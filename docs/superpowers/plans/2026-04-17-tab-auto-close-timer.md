# Tab Auto-Close Timer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Chrome MV3 extension that closes a configurable tab after a wall-clock timer, holds an OS-level display wake-lock while any timer is active, and leaves the PC fully usable.

**Architecture:** Manifest V3 extension with a service-worker coordinator (`background.js`), a popup UI, and `chrome.storage.session` as the timer registry. Scheduling uses `chrome.alarms` for durations ≥ 30s and `setTimeout` (with a keep-alive port) for durations < 30s. Wake-lock uses `chrome.power.requestKeepAwake("display")`. No content scripts; minimal permissions: `tabs`, `alarms`, `power`, `storage`.

**Tech Stack:** Vanilla JavaScript (ES modules), Chrome Manifest V3 APIs, Vitest + jsdom for unit tests, Playwright (`launchPersistentContext`) for E2E.

**Spec:** `docs/superpowers/specs/2026-04-17-tab-auto-close-timer-design.md`

---

## File Structure

```
tab-auto-close-timer/
├── manifest.json
├── package.json
├── .gitignore
├── vitest.config.js
├── playwright.config.js
├── src/
│   ├── background.js         # SW entry; wires chrome.* listeners to timer-manager
│   ├── timer-manager.js      # startTimer / cancelTimer / extendTimer / onAlarmFired / onTabRemoved
│   ├── scheduler.js          # schedule/unschedule abstracting alarms vs setTimeout
│   ├── storage.js            # chrome.storage.session wrapper (getTimers, setTimer, removeTimer)
│   ├── wake-lock.js          # updateWakeLock(): requests/releases based on active-timer count
│   ├── badge.js              # icon badge dot on/off
│   ├── formatters.js         # formatRemaining(ms) → "MM:SS" or "HH:MM:SS"
│   └── constants.js          # ALARM_PREFIX, THRESHOLD_MS, MIN_SECONDS, MAX_SECONDS, EXTEND_MS
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── tests/
│   ├── setup.js              # chrome.* mock installed via vitest setupFiles
│   ├── formatters.test.js
│   ├── storage.test.js
│   ├── wake-lock.test.js
│   ├── scheduler.test.js
│   ├── timer-manager.test.js
│   ├── badge.test.js
│   └── popup.test.js         # jsdom-based tests
├── e2e/
│   └── extension.spec.js     # Playwright integration tests
└── README.md
```

**Boundaries:**
- `storage.js` — only knows about persistence. No scheduling. No chrome.* except `chrome.storage.session`.
- `scheduler.js` — only schedules/unschedules. Accepts a callback; does not know about storage or wake-lock.
- `wake-lock.js` — only knows about `chrome.power`. Reads count from storage via injected getter.
- `timer-manager.js` — orchestrator. Calls into storage, scheduler, wake-lock, badge.
- `background.js` — trivial wiring. `chrome.alarms.onAlarm` → `timerManager.handleAlarmFired`, etc.
- `popup.js` — no scheduling or wake-lock logic; sends messages to SW and reads storage for display.

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`, `.gitignore`, `vitest.config.js`, `playwright.config.js`, `manifest.json`, `tests/setup.js`, `src/constants.js`, `README.md`

- [ ] **Step 1: Initialize git repo**

Run:
```bash
cd /c/Users/GiorgosSpiliotopoulo/tab-auto-close-timer
git init -b main
```
Expected: `Initialized empty Git repository in ...`

- [ ] **Step 2: Create package.json**

Create `package.json`:
```json
{
  "name": "tab-auto-close-timer",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "^1.47.0",
    "jsdom": "^25.0.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 3: Install dependencies**

Run:
```bash
npm install
```
Expected: installs vitest, jsdom, @playwright/test.

- [ ] **Step 4: Create .gitignore**

Create `.gitignore`:
```
node_modules/
coverage/
playwright-report/
test-results/
.DS_Store
*.log
```

- [ ] **Step 5: Create vitest.config.js**

Create `vitest.config.js`:
```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.js'],
    environmentMatchGlobs: [
      ['tests/popup.test.js', 'jsdom']
    ]
  }
});
```

- [ ] **Step 6: Create tests/setup.js with chrome API mock**

Create `tests/setup.js`:
```js
import { vi, beforeEach } from 'vitest';

function createChromeMock() {
  const alarms = new Map();
  const storageData = { timers: {} };
  const tabs = new Map();
  const listeners = {
    alarm: [],
    tabRemoved: [],
    runtimeStartup: [],
    messageExternal: []
  };

  return {
    _state: { alarms, storageData, tabs, listeners },
    alarms: {
      create: vi.fn((name, opts) => { alarms.set(name, opts); }),
      clear: vi.fn(async (name) => alarms.delete(name)),
      getAll: vi.fn(async () => Array.from(alarms.entries()).map(([name, o]) => ({ name, ...o }))),
      onAlarm: { addListener: vi.fn((cb) => listeners.alarm.push(cb)) }
    },
    storage: {
      session: {
        get: vi.fn(async (key) => {
          if (key == null) return { ...storageData };
          if (typeof key === 'string') return { [key]: storageData[key] };
          const out = {};
          for (const k of key) out[k] = storageData[k];
          return out;
        }),
        set: vi.fn(async (obj) => { Object.assign(storageData, obj); }),
        remove: vi.fn(async (key) => { delete storageData[key]; })
      }
    },
    tabs: {
      remove: vi.fn(async (id) => { tabs.delete(id); }),
      get: vi.fn(async (id) => tabs.get(id)),
      query: vi.fn(async () => Array.from(tabs.values())),
      onRemoved: { addListener: vi.fn((cb) => listeners.tabRemoved.push(cb)) }
    },
    power: {
      requestKeepAwake: vi.fn(),
      releaseKeepAwake: vi.fn()
    },
    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {})
    },
    runtime: {
      onStartup: { addListener: vi.fn((cb) => listeners.runtimeStartup.push(cb)) },
      onMessage: { addListener: vi.fn((cb) => listeners.messageExternal.push(cb)) },
      sendMessage: vi.fn(),
      connect: vi.fn(() => ({ disconnect: vi.fn(), onDisconnect: { addListener: vi.fn() } }))
    }
  };
}

beforeEach(() => {
  globalThis.chrome = createChromeMock();
});
```

- [ ] **Step 7: Create src/constants.js**

Create `src/constants.js`:
```js
export const ALARM_PREFIX = 'close-tab-';
export const THRESHOLD_MS = 30_000;           // alarms ≥ 30s, setTimeout < 30s
export const MIN_SECONDS = 1;
export const MAX_SECONDS = 86_400;            // 24 hours
export const EXTEND_MS = 5 * 60 * 1000;       // +5 minutes
export const BADGE_COLOR = '#4a90e2';
export const KEEPALIVE_PORT_NAME = 'timer-keepalive';
```

- [ ] **Step 8: Create manifest.json**

Create `manifest.json`:
```json
{
  "manifest_version": 3,
  "name": "Tab Auto-Close Timer",
  "version": "0.1.0",
  "description": "Close a tab after a configurable timer while keeping the screen awake.",
  "permissions": ["tabs", "alarms", "power", "storage"],
  "background": {
    "service_worker": "src/background.js",
    "type": "module"
  },
  "action": {
    "default_popup": "popup/popup.html",
    "default_title": "Tab Auto-Close Timer"
  }
}
```

- [ ] **Step 9: Create README.md placeholder**

Create `README.md`:
```markdown
# Tab Auto-Close Timer

Chrome extension that closes a tab after a configurable timer while keeping the screen awake and the PC usable.

## Develop

```
npm install
npm test          # unit tests
npm run test:e2e  # Playwright E2E tests
```

## Load unpacked

Open `chrome://extensions`, enable Developer Mode, click "Load unpacked", select this folder.
```

- [ ] **Step 10: Create playwright.config.js**

Create `playwright.config.js`:
```js
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    headless: false
  }
});
```

- [ ] **Step 11: Commit scaffold**

```bash
git add package.json package-lock.json .gitignore vitest.config.js playwright.config.js manifest.json tests/setup.js src/constants.js README.md
git commit -m "chore: scaffold Chrome extension project"
```

---

## Task 2: Formatters

**Files:**
- Create: `src/formatters.js`, `tests/formatters.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/formatters.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { formatRemaining } from '../src/formatters.js';

describe('formatRemaining', () => {
  it('returns MM:SS when under 10 minutes', () => {
    expect(formatRemaining(0)).toBe('00:00');
    expect(formatRemaining(1_000)).toBe('00:01');
    expect(formatRemaining(61_000)).toBe('01:01');
    expect(formatRemaining(9 * 60_000 + 59_000)).toBe('09:59');
  });

  it('returns HH:MM:SS at 10 minutes or more', () => {
    expect(formatRemaining(10 * 60_000)).toBe('00:10:00');
    expect(formatRemaining(3_661_000)).toBe('01:01:01');
    expect(formatRemaining(23 * 3_600_000 + 59 * 60_000 + 59_000)).toBe('23:59:59');
  });

  it('clamps negative input to 00:00', () => {
    expect(formatRemaining(-100)).toBe('00:00');
  });
});
```

- [ ] **Step 2: Run tests (expect fail)**

Run:
```bash
npm test -- formatters
```
Expected: FAIL — `formatRemaining` not defined.

- [ ] **Step 3: Implement**

Create `src/formatters.js`:
```js
const pad = (n) => String(n).padStart(2, '0');

export function formatRemaining(ms) {
  if (ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (ms >= 10 * 60_000) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run:
```bash
npm test -- formatters
```
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/formatters.js tests/formatters.test.js
git commit -m "feat(formatters): format remaining ms as MM:SS or HH:MM:SS"
```

---

## Task 3: Storage Wrapper

**Files:**
- Create: `src/storage.js`, `tests/storage.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/storage.test.js`:
```js
import { describe, it, expect, beforeEach } from 'vitest';
import { getTimers, getTimer, setTimer, removeTimer, countTimers } from '../src/storage.js';

describe('storage', () => {
  it('returns an empty object when no timers set', async () => {
    expect(await getTimers()).toEqual({});
  });

  it('sets and retrieves a timer by tabId', async () => {
    await setTimer(42, {
      targetTimestamp: 1000,
      originalDurationMs: 500,
      tabTitle: 'Test',
      tabFaviconUrl: ''
    });
    expect(await getTimer(42)).toEqual({
      targetTimestamp: 1000,
      originalDurationMs: 500,
      tabTitle: 'Test',
      tabFaviconUrl: ''
    });
  });

  it('returns null for unknown tabId', async () => {
    expect(await getTimer(999)).toBeNull();
  });

  it('removes a timer', async () => {
    await setTimer(42, { targetTimestamp: 1, originalDurationMs: 1, tabTitle: '', tabFaviconUrl: '' });
    await removeTimer(42);
    expect(await getTimer(42)).toBeNull();
  });

  it('countTimers returns number of active timers', async () => {
    expect(await countTimers()).toBe(0);
    await setTimer(1, { targetTimestamp: 1, originalDurationMs: 1, tabTitle: '', tabFaviconUrl: '' });
    await setTimer(2, { targetTimestamp: 1, originalDurationMs: 1, tabTitle: '', tabFaviconUrl: '' });
    expect(await countTimers()).toBe(2);
  });

  it('coerces numeric tabId to string key internally', async () => {
    await setTimer(7, { targetTimestamp: 1, originalDurationMs: 1, tabTitle: '', tabFaviconUrl: '' });
    const all = await getTimers();
    expect(Object.keys(all)).toContain('7');
  });
});
```

- [ ] **Step 2: Run tests (expect fail)**

Run:
```bash
npm test -- storage
```
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/storage.js`:
```js
const KEY = 'timers';

export async function getTimers() {
  const result = await chrome.storage.session.get(KEY);
  return result[KEY] ?? {};
}

export async function getTimer(tabId) {
  const timers = await getTimers();
  return timers[String(tabId)] ?? null;
}

export async function setTimer(tabId, entry) {
  const timers = await getTimers();
  timers[String(tabId)] = entry;
  await chrome.storage.session.set({ [KEY]: timers });
}

export async function removeTimer(tabId) {
  const timers = await getTimers();
  delete timers[String(tabId)];
  await chrome.storage.session.set({ [KEY]: timers });
}

export async function countTimers() {
  const timers = await getTimers();
  return Object.keys(timers).length;
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run:
```bash
npm test -- storage
```
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/storage.js tests/storage.test.js
git commit -m "feat(storage): chrome.storage.session wrapper for timer registry"
```

---

## Task 4: Wake-Lock Helper

**Files:**
- Create: `src/wake-lock.js`, `tests/wake-lock.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/wake-lock.test.js`:
```js
import { describe, it, expect, beforeEach } from 'vitest';
import { updateWakeLock, __resetWakeLockForTests } from '../src/wake-lock.js';
import { setTimer, removeTimer } from '../src/storage.js';

beforeEach(() => { __resetWakeLockForTests(); });

describe('updateWakeLock', () => {
  it('requests keep-awake when transitioning 0 → 1 timer', async () => {
    await setTimer(1, { targetTimestamp: 1, originalDurationMs: 1, tabTitle: '', tabFaviconUrl: '' });
    await updateWakeLock();
    expect(chrome.power.requestKeepAwake).toHaveBeenCalledWith('display');
    expect(chrome.power.releaseKeepAwake).not.toHaveBeenCalled();
  });

  it('does not re-request when already awake and count stays positive', async () => {
    await setTimer(1, { targetTimestamp: 1, originalDurationMs: 1, tabTitle: '', tabFaviconUrl: '' });
    await updateWakeLock();
    await setTimer(2, { targetTimestamp: 1, originalDurationMs: 1, tabTitle: '', tabFaviconUrl: '' });
    await updateWakeLock();
    expect(chrome.power.requestKeepAwake).toHaveBeenCalledTimes(1);
  });

  it('releases when transitioning 1 → 0 timers', async () => {
    await setTimer(1, { targetTimestamp: 1, originalDurationMs: 1, tabTitle: '', tabFaviconUrl: '' });
    await updateWakeLock();
    await removeTimer(1);
    await updateWakeLock();
    expect(chrome.power.releaseKeepAwake).toHaveBeenCalledTimes(1);
  });

  it('does not release if already released and count stays zero', async () => {
    await updateWakeLock();
    await updateWakeLock();
    expect(chrome.power.releaseKeepAwake).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests (expect fail)**

Run:
```bash
npm test -- wake-lock
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/wake-lock.js`:
```js
import { countTimers } from './storage.js';

let isKeepingAwake = false;

export async function updateWakeLock() {
  const count = await countTimers();
  if (count > 0 && !isKeepingAwake) {
    chrome.power.requestKeepAwake('display');
    isKeepingAwake = true;
  } else if (count === 0 && isKeepingAwake) {
    chrome.power.releaseKeepAwake();
    isKeepingAwake = false;
  }
}

export function __resetWakeLockForTests() {
  isKeepingAwake = false;
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run:
```bash
npm test -- wake-lock
```
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/wake-lock.js tests/wake-lock.test.js
git commit -m "feat(wake-lock): request/release keep-awake on 0↔1 transitions"
```

---

## Task 5: Scheduler (alarms vs setTimeout)

**Files:**
- Create: `src/scheduler.js`, `tests/scheduler.test.js`

The scheduler owns timing. It does not touch storage or wake-lock. Consumers register a fire callback at module init.

- [ ] **Step 1: Write failing tests**

Create `tests/scheduler.test.js`:
```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { schedule, unschedule, __resetSchedulerForTests, registerFireCallback } from '../src/scheduler.js';
import { THRESHOLD_MS, ALARM_PREFIX } from '../src/constants.js';

describe('scheduler', () => {
  beforeEach(() => {
    __resetSchedulerForTests();
    vi.useFakeTimers();
  });

  it('uses chrome.alarms when remaining >= 30s', async () => {
    const now = Date.now();
    await schedule(42, now + THRESHOLD_MS);
    expect(chrome.alarms.create).toHaveBeenCalledWith(
      `${ALARM_PREFIX}42`,
      { when: now + THRESHOLD_MS }
    );
  });

  it('uses setTimeout when remaining < 30s', async () => {
    const fireCb = vi.fn();
    registerFireCallback(fireCb);
    const now = Date.now();
    await schedule(42, now + 5_000);
    expect(chrome.alarms.create).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(fireCb).toHaveBeenCalledWith(42);
  });

  it('unschedule clears an alarm', async () => {
    const now = Date.now();
    await schedule(42, now + THRESHOLD_MS);
    await unschedule(42);
    expect(chrome.alarms.clear).toHaveBeenCalledWith(`${ALARM_PREFIX}42`);
  });

  it('unschedule cancels a setTimeout', async () => {
    const fireCb = vi.fn();
    registerFireCallback(fireCb);
    const now = Date.now();
    await schedule(42, now + 5_000);
    await unschedule(42);
    vi.advanceTimersByTime(5_000);
    expect(fireCb).not.toHaveBeenCalled();
  });

  it('parseTabIdFromAlarmName extracts numeric id from alarm name', async () => {
    const { parseTabIdFromAlarmName } = await import('../src/scheduler.js');
    expect(parseTabIdFromAlarmName('close-tab-42')).toBe(42);
    expect(parseTabIdFromAlarmName('not-ours')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests (expect fail)**

Run:
```bash
npm test -- scheduler
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/scheduler.js`:
```js
import { ALARM_PREFIX, THRESHOLD_MS, KEEPALIVE_PORT_NAME } from './constants.js';

const pendingTimeouts = new Map();   // tabId → timeoutId
let fireCallback = null;
let keepalivePort = null;

export function registerFireCallback(cb) {
  fireCallback = cb;
}

function openKeepaliveIfNeeded() {
  if (pendingTimeouts.size === 0) return;
  if (keepalivePort) return;
  try {
    keepalivePort = chrome.runtime.connect({ name: KEEPALIVE_PORT_NAME });
  } catch {
    keepalivePort = null;
  }
}

function closeKeepaliveIfIdle() {
  if (pendingTimeouts.size > 0) return;
  if (!keepalivePort) return;
  try { keepalivePort.disconnect(); } catch {}
  keepalivePort = null;
}

export async function schedule(tabId, targetTimestamp) {
  const remaining = targetTimestamp - Date.now();
  await unschedule(tabId);
  if (remaining >= THRESHOLD_MS) {
    chrome.alarms.create(`${ALARM_PREFIX}${tabId}`, { when: targetTimestamp });
  } else {
    const delay = Math.max(0, remaining);
    const id = setTimeout(() => {
      pendingTimeouts.delete(tabId);
      closeKeepaliveIfIdle();
      if (fireCallback) fireCallback(tabId);
    }, delay);
    pendingTimeouts.set(tabId, id);
    openKeepaliveIfNeeded();
  }
}

export async function unschedule(tabId) {
  if (pendingTimeouts.has(tabId)) {
    clearTimeout(pendingTimeouts.get(tabId));
    pendingTimeouts.delete(tabId);
    closeKeepaliveIfIdle();
  }
  await chrome.alarms.clear(`${ALARM_PREFIX}${tabId}`);
}

export function parseTabIdFromAlarmName(name) {
  if (!name || !name.startsWith(ALARM_PREFIX)) return null;
  const n = Number(name.slice(ALARM_PREFIX.length));
  return Number.isFinite(n) ? n : null;
}

export function __resetSchedulerForTests() {
  for (const id of pendingTimeouts.values()) clearTimeout(id);
  pendingTimeouts.clear();
  fireCallback = null;
  if (keepalivePort) { try { keepalivePort.disconnect(); } catch {} }
  keepalivePort = null;
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run:
```bash
npm test -- scheduler
```
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.js tests/scheduler.test.js
git commit -m "feat(scheduler): alarm for >=30s, setTimeout+keepalive for <30s"
```

---

## Task 6: Badge Indicator

**Files:**
- Create: `src/badge.js`, `tests/badge.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/badge.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { updateBadge } from '../src/badge.js';
import { setTimer } from '../src/storage.js';
import { BADGE_COLOR } from '../src/constants.js';

describe('updateBadge', () => {
  it('clears badge when no timers active', async () => {
    await updateBadge();
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
  });

  it('shows a dot when timers are active', async () => {
    await setTimer(1, { targetTimestamp: 1, originalDurationMs: 1, tabTitle: '', tabFaviconUrl: '' });
    await updateBadge();
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '●' });
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: BADGE_COLOR });
  });
});
```

- [ ] **Step 2: Run tests (expect fail)**

Run:
```bash
npm test -- badge
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/badge.js`:
```js
import { countTimers } from './storage.js';
import { BADGE_COLOR } from './constants.js';

export async function updateBadge() {
  const count = await countTimers();
  if (count > 0) {
    await chrome.action.setBadgeText({ text: '●' });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run:
```bash
npm test -- badge
```
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/badge.js tests/badge.test.js
git commit -m "feat(badge): show dot when any timer active"
```

---

## Task 7: Timer Manager — startTimer

**Files:**
- Create: `src/timer-manager.js` (partial), `tests/timer-manager.test.js`

Note: subsequent tasks extend the same files. We create tests incrementally; the file carries the earlier code forward.

- [ ] **Step 1: Write failing test**

Create `tests/timer-manager.test.js`:
```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { startTimer } from '../src/timer-manager.js';
import { getTimer } from '../src/storage.js';
import { ALARM_PREFIX } from '../src/constants.js';
import { __resetWakeLockForTests } from '../src/wake-lock.js';
import { __resetSchedulerForTests } from '../src/scheduler.js';

beforeEach(() => {
  __resetWakeLockForTests();
  __resetSchedulerForTests();
  vi.useRealTimers();
});

describe('startTimer', () => {
  it('writes a storage entry with target timestamp', async () => {
    const tab = { id: 77, title: 'Hello', favIconUrl: 'http://x/f.ico' };
    const before = Date.now();
    await startTimer(tab, 60_000);
    const stored = await getTimer(77);
    expect(stored.originalDurationMs).toBe(60_000);
    expect(stored.tabTitle).toBe('Hello');
    expect(stored.tabFaviconUrl).toBe('http://x/f.ico');
    expect(stored.targetTimestamp).toBeGreaterThanOrEqual(before + 60_000);
    expect(stored.targetTimestamp).toBeLessThanOrEqual(before + 60_000 + 50);
  });

  it('schedules an alarm for durations >= 30s', async () => {
    await startTimer({ id: 77, title: '', favIconUrl: '' }, 60_000);
    expect(chrome.alarms.create).toHaveBeenCalledWith(
      `${ALARM_PREFIX}77`,
      expect.objectContaining({ when: expect.any(Number) })
    );
  });

  it('requests wake-lock on first timer', async () => {
    await startTimer({ id: 77, title: '', favIconUrl: '' }, 60_000);
    expect(chrome.power.requestKeepAwake).toHaveBeenCalledWith('display');
  });

  it('updates badge on start', async () => {
    await startTimer({ id: 77, title: '', favIconUrl: '' }, 60_000);
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '●' });
  });

  it('rejects duration below MIN_SECONDS', async () => {
    await expect(startTimer({ id: 77, title: '', favIconUrl: '' }, 500))
      .rejects.toThrow(/minimum/i);
  });

  it('rejects duration above MAX_SECONDS', async () => {
    await expect(startTimer({ id: 77, title: '', favIconUrl: '' }, 86_400_001))
      .rejects.toThrow(/maximum/i);
  });
});
```

- [ ] **Step 2: Run tests (expect fail)**

Run:
```bash
npm test -- timer-manager
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/timer-manager.js`:
```js
import { setTimer } from './storage.js';
import { schedule, registerFireCallback } from './scheduler.js';
import { updateWakeLock } from './wake-lock.js';
import { updateBadge } from './badge.js';
import { MIN_SECONDS, MAX_SECONDS } from './constants.js';

function validateDuration(ms) {
  if (ms < MIN_SECONDS * 1000) throw new Error(`Duration below minimum (${MIN_SECONDS}s)`);
  if (ms > MAX_SECONDS * 1000) throw new Error(`Duration above maximum (${MAX_SECONDS}s)`);
}

export async function startTimer(tab, durationMs) {
  validateDuration(durationMs);
  const targetTimestamp = Date.now() + durationMs;
  await setTimer(tab.id, {
    targetTimestamp,
    originalDurationMs: durationMs,
    tabTitle: tab.title ?? '',
    tabFaviconUrl: tab.favIconUrl ?? ''
  });
  await schedule(tab.id, targetTimestamp);
  await updateWakeLock();
  await updateBadge();
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run:
```bash
npm test -- timer-manager
```
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/timer-manager.js tests/timer-manager.test.js
git commit -m "feat(timer-manager): startTimer writes storage, schedules, requests wake-lock"
```

---

## Task 8: Timer Manager — cancelTimer

**Files:**
- Modify: `src/timer-manager.js`, `tests/timer-manager.test.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/timer-manager.test.js`:
```js
import { cancelTimer } from '../src/timer-manager.js';

describe('cancelTimer', () => {
  it('removes the storage entry', async () => {
    await startTimer({ id: 77, title: '', favIconUrl: '' }, 60_000);
    await cancelTimer(77);
    expect(await getTimer(77)).toBeNull();
  });

  it('clears the alarm', async () => {
    await startTimer({ id: 77, title: '', favIconUrl: '' }, 60_000);
    await cancelTimer(77);
    expect(chrome.alarms.clear).toHaveBeenCalledWith(`${ALARM_PREFIX}77`);
  });

  it('releases wake-lock when last timer cancelled', async () => {
    await startTimer({ id: 77, title: '', favIconUrl: '' }, 60_000);
    await cancelTimer(77);
    expect(chrome.power.releaseKeepAwake).toHaveBeenCalled();
  });

  it('keeps wake-lock held when another timer remains', async () => {
    await startTimer({ id: 1, title: '', favIconUrl: '' }, 60_000);
    await startTimer({ id: 2, title: '', favIconUrl: '' }, 60_000);
    chrome.power.releaseKeepAwake.mockClear();
    await cancelTimer(1);
    expect(chrome.power.releaseKeepAwake).not.toHaveBeenCalled();
  });

  it('clears the badge when last timer cancelled', async () => {
    await startTimer({ id: 77, title: '', favIconUrl: '' }, 60_000);
    chrome.action.setBadgeText.mockClear();
    await cancelTimer(77);
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
  });

  it('is a no-op for unknown tabId', async () => {
    await expect(cancelTimer(999)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests (expect fail on cancelTimer)**

Run:
```bash
npm test -- timer-manager
```
Expected: FAIL — `cancelTimer` not exported.

- [ ] **Step 3: Implement**

Add to `src/timer-manager.js`:
```js
import { removeTimer, getTimer } from './storage.js';
import { unschedule } from './scheduler.js';
```
(Merge with existing imports; `setTimer` stays.)

Append to the file:
```js
export async function cancelTimer(tabId) {
  const existing = await getTimer(tabId);
  if (!existing) return;
  await removeTimer(tabId);
  await unschedule(tabId);
  await updateWakeLock();
  await updateBadge();
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run:
```bash
npm test -- timer-manager
```
Expected: PASS — all timer-manager tests.

- [ ] **Step 5: Commit**

```bash
git add src/timer-manager.js tests/timer-manager.test.js
git commit -m "feat(timer-manager): cancelTimer cleans up storage, schedule, wake-lock, badge"
```

---

## Task 9: Timer Manager — extendTimer

**Files:**
- Modify: `src/timer-manager.js`, `tests/timer-manager.test.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/timer-manager.test.js`:
```js
import { extendTimer } from '../src/timer-manager.js';
import { EXTEND_MS } from '../src/constants.js';

describe('extendTimer', () => {
  it('pushes targetTimestamp forward by EXTEND_MS', async () => {
    await startTimer({ id: 77, title: '', favIconUrl: '' }, 60_000);
    const before = (await getTimer(77)).targetTimestamp;
    await extendTimer(77);
    const after = (await getTimer(77)).targetTimestamp;
    expect(after - before).toBe(EXTEND_MS);
  });

  it('re-schedules the alarm with the new target', async () => {
    await startTimer({ id: 77, title: '', favIconUrl: '' }, 60_000);
    chrome.alarms.create.mockClear();
    await extendTimer(77);
    expect(chrome.alarms.clear).toHaveBeenCalledWith(`${ALARM_PREFIX}77`);
    expect(chrome.alarms.create).toHaveBeenCalled();
  });

  it('rejects if the current target is already in the past', async () => {
    await startTimer({ id: 77, title: '', favIconUrl: '' }, 60_000);
    // Manually expire: rewrite targetTimestamp to past
    const existing = await getTimer(77);
    existing.targetTimestamp = Date.now() - 1_000;
    await chrome.storage.session.set({ timers: { 77: existing } });
    await expect(extendTimer(77)).rejects.toThrow(/expired/i);
  });

  it('throws for unknown tabId', async () => {
    await expect(extendTimer(999)).rejects.toThrow(/no timer/i);
  });
});
```

- [ ] **Step 2: Run tests (expect fail)**

Run:
```bash
npm test -- timer-manager
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Add `EXTEND_MS` to imports in `src/timer-manager.js`:
```js
import { MIN_SECONDS, MAX_SECONDS, EXTEND_MS } from './constants.js';
```

Append:
```js
export async function extendTimer(tabId) {
  const existing = await getTimer(tabId);
  if (!existing) throw new Error(`No timer for tab ${tabId}`);
  if (existing.targetTimestamp < Date.now()) {
    throw new Error('Cannot extend: timer already expired');
  }
  const newTarget = existing.targetTimestamp + EXTEND_MS;
  await setTimer(tabId, { ...existing, targetTimestamp: newTarget });
  await schedule(tabId, newTarget);
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run:
```bash
npm test -- timer-manager
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/timer-manager.js tests/timer-manager.test.js
git commit -m "feat(timer-manager): extendTimer adds 5 minutes and reschedules"
```

---

## Task 10: Timer Manager — handleAlarmFired

**Files:**
- Modify: `src/timer-manager.js`, `tests/timer-manager.test.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/timer-manager.test.js`:
```js
import { handleAlarmFired, handleTimeoutFired } from '../src/timer-manager.js';

describe('handleAlarmFired / handleTimeoutFired', () => {
  it('closes the tab when alarm fires', async () => {
    await startTimer({ id: 77, title: '', favIconUrl: '' }, 60_000);
    await handleAlarmFired({ name: `${ALARM_PREFIX}77` });
    expect(chrome.tabs.remove).toHaveBeenCalledWith(77);
  });

  it('removes storage entry after alarm fires', async () => {
    await startTimer({ id: 77, title: '', favIconUrl: '' }, 60_000);
    await handleAlarmFired({ name: `${ALARM_PREFIX}77` });
    expect(await getTimer(77)).toBeNull();
  });

  it('releases wake-lock after last alarm fires', async () => {
    await startTimer({ id: 77, title: '', favIconUrl: '' }, 60_000);
    await handleAlarmFired({ name: `${ALARM_PREFIX}77` });
    expect(chrome.power.releaseKeepAwake).toHaveBeenCalled();
  });

  it('ignores alarms that are not ours', async () => {
    await handleAlarmFired({ name: 'some-other-alarm' });
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });

  it('swallows errors when the tab is already gone', async () => {
    chrome.tabs.remove.mockRejectedValueOnce(new Error('No tab with id'));
    await startTimer({ id: 77, title: '', favIconUrl: '' }, 60_000);
    await expect(handleAlarmFired({ name: `${ALARM_PREFIX}77` })).resolves.toBeUndefined();
    expect(await getTimer(77)).toBeNull();
  });

  it('handleTimeoutFired(tabId) closes the tab', async () => {
    await startTimer({ id: 77, title: '', favIconUrl: '' }, 60_000);
    await handleTimeoutFired(77);
    expect(chrome.tabs.remove).toHaveBeenCalledWith(77);
  });
});
```

- [ ] **Step 2: Run tests (expect fail)**

Run:
```bash
npm test -- timer-manager
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to imports in `src/timer-manager.js`:
```js
import { parseTabIdFromAlarmName } from './scheduler.js';
```

Append:
```js
async function closeAndCleanup(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch (err) {
    console.debug('tabs.remove failed (probably already gone):', err);
  }
  await removeTimer(tabId);
  await updateWakeLock();
  await updateBadge();
}

export async function handleAlarmFired(alarm) {
  const tabId = parseTabIdFromAlarmName(alarm.name);
  if (tabId == null) return;
  await closeAndCleanup(tabId);
}

export async function handleTimeoutFired(tabId) {
  await closeAndCleanup(tabId);
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run:
```bash
npm test -- timer-manager
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/timer-manager.js tests/timer-manager.test.js
git commit -m "feat(timer-manager): close tab + clean up on alarm/timeout fire"
```

---

## Task 11: Timer Manager — handleTabRemoved

**Files:**
- Modify: `src/timer-manager.js`, `tests/timer-manager.test.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/timer-manager.test.js`:
```js
import { handleTabRemoved } from '../src/timer-manager.js';

describe('handleTabRemoved', () => {
  it('cleans up when a tracked tab is closed manually', async () => {
    await startTimer({ id: 77, title: '', favIconUrl: '' }, 60_000);
    await handleTabRemoved(77);
    expect(await getTimer(77)).toBeNull();
    expect(chrome.alarms.clear).toHaveBeenCalledWith(`${ALARM_PREFIX}77`);
  });

  it('releases wake-lock when last tab closes manually', async () => {
    await startTimer({ id: 77, title: '', favIconUrl: '' }, 60_000);
    await handleTabRemoved(77);
    expect(chrome.power.releaseKeepAwake).toHaveBeenCalled();
  });

  it('is a no-op for an untracked tab', async () => {
    await handleTabRemoved(999);
    expect(chrome.alarms.clear).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests (expect fail)**

Run:
```bash
npm test -- timer-manager
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `src/timer-manager.js`:
```js
export async function handleTabRemoved(tabId) {
  const existing = await getTimer(tabId);
  if (!existing) return;
  await removeTimer(tabId);
  await unschedule(tabId);
  await updateWakeLock();
  await updateBadge();
}
```

- [ ] **Step 4: Wire fire callback on module load**

Prepend to `src/timer-manager.js` (after imports):
```js
registerFireCallback((tabId) => { handleTimeoutFired(tabId).catch(console.error); });
```

- [ ] **Step 5: Run tests (expect pass)**

Run:
```bash
npm test -- timer-manager
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/timer-manager.js tests/timer-manager.test.js
git commit -m "feat(timer-manager): clean up when tab closed manually"
```

---

## Task 12: Background Service Worker

**Files:**
- Create: `src/background.js`

The SW is thin — it only wires chrome.* events to timer-manager and handles popup messages.

- [ ] **Step 1: Write failing test**

Create `tests/background.test.js`:
```js
import { describe, it, expect, vi } from 'vitest';

describe('background service worker', () => {
  it('registers chrome.alarms.onAlarm listener', async () => {
    await import('../src/background.js');
    expect(chrome.alarms.onAlarm.addListener).toHaveBeenCalled();
  });

  it('registers chrome.tabs.onRemoved listener', async () => {
    expect(chrome.tabs.onRemoved.addListener).toHaveBeenCalled();
  });

  it('registers chrome.runtime.onMessage listener', async () => {
    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalled();
  });

  it('registers chrome.runtime.onStartup listener', async () => {
    expect(chrome.runtime.onStartup.addListener).toHaveBeenCalled();
  });

  it('handles start message by calling startTimer', async () => {
    const tab = { id: 77, title: 'x', favIconUrl: '' };
    const msgCb = chrome._state.listeners.messageExternal[0];
    chrome._state.tabs.set(77, tab);
    const sendResponse = vi.fn();
    const handled = msgCb(
      { type: 'start', tabId: 77, durationMs: 60_000, tab },
      {},
      sendResponse
    );
    expect(handled).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

Run:
```bash
npm test -- background
```
Expected: FAIL — `background.js` does not exist.

- [ ] **Step 3: Implement**

Create `src/background.js`:
```js
import {
  startTimer,
  cancelTimer,
  extendTimer,
  handleAlarmFired,
  handleTabRemoved
} from './timer-manager.js';
import { updateWakeLock } from './wake-lock.js';
import { updateBadge } from './badge.js';
import { KEEPALIVE_PORT_NAME } from './constants.js';

chrome.alarms.onAlarm.addListener((alarm) => {
  handleAlarmFired(alarm).catch(console.error);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  handleTabRemoved(tabId).catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  Promise.all([updateWakeLock(), updateBadge()]).catch(console.error);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'start':
          await startTimer(msg.tab, msg.durationMs);
          sendResponse({ ok: true });
          break;
        case 'cancel':
          await cancelTimer(msg.tabId);
          sendResponse({ ok: true });
          break;
        case 'extend':
          await extendTimer(msg.tabId);
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: 'unknown-type' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message ?? err) });
    }
  })();
  return true; // keep sendResponse alive for async
});

chrome.runtime.onConnect?.addListener?.((port) => {
  if (port.name === KEEPALIVE_PORT_NAME) {
    port.onDisconnect.addListener(() => {});
  }
});
```

Note: the test imports `background.js` which calls `chrome.runtime.onMessage.addListener`. Our mock in `tests/setup.js` already provides `runtime.onMessage`. Add `onConnect` to the mock if missing.

- [ ] **Step 4: Update tests/setup.js to add runtime.onConnect**

Edit `tests/setup.js` — inside the `runtime:` block, ensure it has:
```js
runtime: {
  onStartup: { addListener: vi.fn((cb) => listeners.runtimeStartup.push(cb)) },
  onMessage: { addListener: vi.fn((cb) => listeners.messageExternal.push(cb)) },
  onConnect: { addListener: vi.fn() },
  sendMessage: vi.fn(),
  connect: vi.fn(() => ({ disconnect: vi.fn(), onDisconnect: { addListener: vi.fn() } }))
}
```

- [ ] **Step 5: Run tests (expect pass)**

Run:
```bash
npm test -- background
```
Expected: PASS — 5 tests.

- [ ] **Step 6: Run full unit test suite**

Run:
```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/background.js tests/background.test.js tests/setup.js
git commit -m "feat(background): wire chrome listeners and message handlers"
```

---

## Task 13: Popup HTML + CSS

**Files:**
- Create: `popup/popup.html`, `popup/popup.css`

- [ ] **Step 1: Create popup.html**

Create `popup/popup.html`:
```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <link rel="stylesheet" href="popup.css" />
</head>
<body>
  <main id="app">
    <section id="no-timer" hidden>
      <div class="tab-label">
        <div class="title" id="current-title"></div>
      </div>
      <div class="presets">
        <button class="preset" data-seconds="600">10m</button>
        <button class="preset" data-seconds="1200">20m</button>
        <button class="preset" data-seconds="1800">30m</button>
        <button class="preset" data-seconds="3600">60m</button>
      </div>
      <label class="custom">
        Or seconds:
        <input id="custom-seconds" type="number" min="1" max="86400" />
      </label>
      <button id="start-btn" class="primary">Start timer</button>
      <p class="error" id="start-error" hidden></p>
    </section>

    <section id="active-timer" hidden>
      <div class="countdown" id="current-countdown">--:--</div>
      <div class="actions">
        <button id="extend-btn">+5 min</button>
        <button id="cancel-btn" class="danger">Cancel timer</button>
      </div>
    </section>

    <section id="others" hidden>
      <h3 id="others-heading">Other active timers</h3>
      <ul id="others-list"></ul>
    </section>

    <p id="warning" class="warning" hidden></p>
  </main>
  <script type="module" src="popup.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create popup.css**

Create `popup/popup.css`:
```css
:root {
  --bg: #fff;
  --fg: #222;
  --muted: #666;
  --primary: #4a90e2;
  --danger: #d14;
  --border: #ddd;
}
body {
  width: 320px;
  font-family: -apple-system, Segoe UI, sans-serif;
  color: var(--fg);
  background: var(--bg);
  margin: 0;
  padding: 12px;
  box-sizing: border-box;
}
main { display: flex; flex-direction: column; gap: 12px; }
.tab-label .title {
  font-size: 13px; color: var(--muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.presets { display: flex; gap: 6px; }
.preset {
  flex: 1; padding: 6px; border: 1px solid var(--border);
  background: #f6f6f6; border-radius: 4px; cursor: pointer;
}
.preset.selected { background: var(--primary); color: #fff; border-color: var(--primary); }
.custom { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.custom input { flex: 1; padding: 4px 6px; border: 1px solid var(--border); border-radius: 4px; }
button.primary {
  padding: 8px; border: 0; background: var(--primary);
  color: #fff; border-radius: 4px; cursor: pointer; font-size: 14px;
}
button.danger {
  padding: 6px 10px; border: 1px solid var(--danger);
  color: var(--danger); background: #fff; border-radius: 4px; cursor: pointer;
}
.countdown { font-size: 40px; text-align: center; font-variant-numeric: tabular-nums; }
.actions { display: flex; gap: 6px; }
.actions button { flex: 1; }
#others h3 { font-size: 12px; color: var(--muted); margin: 0 0 6px; text-transform: uppercase; }
#others ul { list-style: none; padding: 0; margin: 0; }
#others li {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 0; font-size: 12px; border-top: 1px solid var(--border);
}
#others li .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#others li .time { font-variant-numeric: tabular-nums; color: var(--muted); }
#others li button {
  background: transparent; border: 0; color: var(--muted);
  font-size: 16px; cursor: pointer; padding: 0 4px;
}
.error, .warning {
  font-size: 12px; margin: 0; padding: 6px; border-radius: 4px;
}
.error { color: var(--danger); background: #fdecec; }
.warning { color: #8a5a00; background: #fff7e0; }
```

- [ ] **Step 3: Commit**

```bash
git add popup/popup.html popup/popup.css
git commit -m "feat(popup): HTML skeleton and styles"
```

---

## Task 14: Popup Logic — Rendering + Interactions

**Files:**
- Create: `popup/popup.js`, `tests/popup.test.js`

This task builds the full popup controller. It is larger than earlier tasks but is still a single cohesive unit.

- [ ] **Step 1: Write failing tests (State A — no timer on current tab)**

Create `tests/popup.test.js`:
```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function loadPopupHtml() {
  const html = fs.readFileSync(path.resolve(__dirname, '../popup/popup.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<script[^>]*><\/script>/, '');
}

async function loadPopupScript() {
  vi.resetModules();
  return await import('../popup/popup.js');
}

function stubCurrentTab(tab) {
  chrome.tabs.query = vi.fn(async () => [tab]);
}

describe('popup — no active timer on current tab', () => {
  beforeEach(() => { loadPopupHtml(); });

  it('shows the no-timer section when current tab has no timer', async () => {
    stubCurrentTab({ id: 10, title: 'Hello', favIconUrl: '' });
    await loadPopupScript();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById('no-timer').hidden).toBe(false);
    expect(document.getElementById('active-timer').hidden).toBe(true);
    expect(document.getElementById('current-title').textContent).toBe('Hello');
  });

  it('clicking a preset selects it and fills custom-seconds', async () => {
    stubCurrentTab({ id: 10, title: '', favIconUrl: '' });
    await loadPopupScript();
    await new Promise((r) => setTimeout(r, 0));
    const btn30 = document.querySelector('.preset[data-seconds="1800"]');
    btn30.click();
    expect(btn30.classList.contains('selected')).toBe(true);
    expect(document.getElementById('custom-seconds').value).toBe('1800');
  });

  it('clicking Start sends a start message', async () => {
    stubCurrentTab({ id: 10, title: 'H', favIconUrl: '' });
    chrome.runtime.sendMessage = vi.fn(async () => ({ ok: true }));
    await loadPopupScript();
    await new Promise((r) => setTimeout(r, 0));
    document.getElementById('custom-seconds').value = '60';
    document.getElementById('start-btn').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'start', durationMs: 60_000 })
    );
  });

  it('shows an error when seconds is out of range', async () => {
    stubCurrentTab({ id: 10, title: 'H', favIconUrl: '' });
    chrome.runtime.sendMessage = vi.fn(async () => ({ ok: true }));
    await loadPopupScript();
    await new Promise((r) => setTimeout(r, 0));
    document.getElementById('custom-seconds').value = '0';
    document.getElementById('start-btn').click();
    await new Promise((r) => setTimeout(r, 0));
    const err = document.getElementById('start-error');
    expect(err.hidden).toBe(false);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});

describe('popup — active timer on current tab', () => {
  beforeEach(() => { loadPopupHtml(); });

  it('renders State B with countdown', async () => {
    stubCurrentTab({ id: 10, title: 'Curr', favIconUrl: '' });
    await chrome.storage.session.set({
      timers: { 10: { targetTimestamp: Date.now() + 60_000, originalDurationMs: 60_000, tabTitle: 'Curr', tabFaviconUrl: '' } }
    });
    await loadPopupScript();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById('active-timer').hidden).toBe(false);
    expect(document.getElementById('no-timer').hidden).toBe(true);
    const text = document.getElementById('current-countdown').textContent;
    expect(text).toMatch(/^\d{2}:\d{2}$/);
  });

  it('clicking Cancel sends a cancel message', async () => {
    stubCurrentTab({ id: 10, title: 'C', favIconUrl: '' });
    await chrome.storage.session.set({
      timers: { 10: { targetTimestamp: Date.now() + 60_000, originalDurationMs: 60_000, tabTitle: 'C', tabFaviconUrl: '' } }
    });
    chrome.runtime.sendMessage = vi.fn(async () => ({ ok: true }));
    await loadPopupScript();
    await new Promise((r) => setTimeout(r, 0));
    document.getElementById('cancel-btn').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'cancel', tabId: 10 });
  });

  it('clicking +5 min sends an extend message', async () => {
    stubCurrentTab({ id: 10, title: 'C', favIconUrl: '' });
    await chrome.storage.session.set({
      timers: { 10: { targetTimestamp: Date.now() + 60_000, originalDurationMs: 60_000, tabTitle: 'C', tabFaviconUrl: '' } }
    });
    chrome.runtime.sendMessage = vi.fn(async () => ({ ok: true }));
    await loadPopupScript();
    await new Promise((r) => setTimeout(r, 0));
    document.getElementById('extend-btn').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'extend', tabId: 10 });
  });

  it('renders other active timers in the list', async () => {
    stubCurrentTab({ id: 10, title: 'C', favIconUrl: '' });
    await chrome.storage.session.set({
      timers: {
        10: { targetTimestamp: Date.now() + 60_000, originalDurationMs: 60_000, tabTitle: 'C', tabFaviconUrl: '' },
        20: { targetTimestamp: Date.now() + 120_000, originalDurationMs: 120_000, tabTitle: 'Other', tabFaviconUrl: '' }
      }
    });
    await loadPopupScript();
    await new Promise((r) => setTimeout(r, 0));
    const items = document.querySelectorAll('#others-list li');
    expect(items).toHaveLength(1);
    expect(items[0].querySelector('.name').textContent).toBe('Other');
  });
});
```

- [ ] **Step 2: Run tests (expect fail)**

Run:
```bash
npm test -- popup
```
Expected: FAIL — `popup.js` does not exist.

- [ ] **Step 3: Implement popup.js**

Create `popup/popup.js`:
```js
import { formatRemaining } from '../src/formatters.js';
import { MIN_SECONDS, MAX_SECONDS } from '../src/constants.js';

let currentTab = null;
let tickHandle = null;

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  await render();
  tickHandle = setInterval(render, 1000);
}

async function render() {
  const { timers = {} } = await chrome.storage.session.get('timers');
  const currentEntry = currentTab ? timers[String(currentTab.id)] : null;

  const noTimerEl = document.getElementById('no-timer');
  const activeEl = document.getElementById('active-timer');
  const othersSection = document.getElementById('others');
  const othersList = document.getElementById('others-list');
  const othersHeading = document.getElementById('others-heading');

  if (currentEntry) {
    noTimerEl.hidden = true;
    activeEl.hidden = false;
    const remaining = currentEntry.targetTimestamp - Date.now();
    document.getElementById('current-countdown').textContent = formatRemaining(remaining);
    document.getElementById('extend-btn').disabled = remaining <= 0;
  } else {
    noTimerEl.hidden = false;
    activeEl.hidden = true;
    document.getElementById('current-title').textContent = currentTab?.title ?? '';
  }

  const otherEntries = Object.entries(timers)
    .filter(([id]) => !currentTab || Number(id) !== currentTab.id);
  othersList.innerHTML = '';
  if (otherEntries.length === 0) {
    othersSection.hidden = true;
  } else {
    othersSection.hidden = false;
    othersHeading.textContent = currentEntry ? 'Other active timers' : 'Active timers';
    for (const [tabIdStr, entry] of otherEntries) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = entry.tabTitle || `Tab ${tabIdStr}`;
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = formatRemaining(entry.targetTimestamp - Date.now());
      const cancel = document.createElement('button');
      cancel.textContent = '×';
      cancel.title = 'Cancel this timer';
      cancel.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'cancel', tabId: Number(tabIdStr) }).then(render);
      });
      li.append(name, time, cancel);
      othersList.appendChild(li);
    }
  }
}

function wireNoTimerControls() {
  for (const btn of document.querySelectorAll('.preset')) {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.preset').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      document.getElementById('custom-seconds').value = btn.dataset.seconds;
    });
  }

  document.getElementById('start-btn').addEventListener('click', async () => {
    const err = document.getElementById('start-error');
    err.hidden = true;
    const seconds = Number(document.getElementById('custom-seconds').value);
    if (!Number.isFinite(seconds) || seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
      err.hidden = false;
      err.textContent = `Enter a value between ${MIN_SECONDS} and ${MAX_SECONDS} seconds.`;
      return;
    }
    const resp = await chrome.runtime.sendMessage({
      type: 'start',
      tab: currentTab,
      durationMs: seconds * 1000
    });
    if (resp?.ok) {
      await render();
    } else {
      err.hidden = false;
      err.textContent = resp?.error ?? 'Failed to start timer.';
    }
  });
}

function wireActiveControls() {
  document.getElementById('cancel-btn').addEventListener('click', async () => {
    if (!currentTab) return;
    await chrome.runtime.sendMessage({ type: 'cancel', tabId: currentTab.id });
    await render();
  });
  document.getElementById('extend-btn').addEventListener('click', async () => {
    if (!currentTab) return;
    await chrome.runtime.sendMessage({ type: 'extend', tabId: currentTab.id });
    await render();
  });
}

wireNoTimerControls();
wireActiveControls();
init();

window.addEventListener('unload', () => {
  if (tickHandle) clearInterval(tickHandle);
});
```

- [ ] **Step 4: Run tests (expect pass)**

Run:
```bash
npm test -- popup
```
Expected: PASS — all popup tests.

- [ ] **Step 5: Run full test suite**

Run:
```bash
npm test
```
Expected: all unit tests pass across every file.

- [ ] **Step 6: Commit**

```bash
git add popup/popup.js tests/popup.test.js
git commit -m "feat(popup): state rendering, start/cancel/extend, live countdown"
```

---

## Task 15: Playwright E2E — Load Extension and Start a Timer

**Files:**
- Create: `e2e/extension.spec.js`

- [ ] **Step 1: Install Playwright browsers**

Run:
```bash
npx playwright install chromium
```

- [ ] **Step 2: Write E2E test**

Create `e2e/extension.spec.js`:
```js
import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '..');

async function launchWithExtension() {
  const userDataDir = path.join(process.cwd(), '.pw-profile');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run'
    ]
  });
  // Wait for service worker
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  return { context, sw };
}

async function extensionId(sw) {
  return new URL(sw.url()).host;
}

test('closes a tab when a short timer expires', async () => {
  const { context, sw } = await launchWithExtension();
  try {
    const page = await context.newPage();
    await page.goto('data:text/html,<title>Victim</title><body>Victim tab</body>');
    await page.waitForLoadState('load');

    // Start a 2-second timer by messaging the SW directly
    const id = await extensionId(sw);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup/popup.html`);

    // Tell the SW to start a timer on the victim page
    await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const victim = tabs.find((t) => t.title === 'Victim');
      await chrome.runtime.sendMessage({ type: 'start', tab: victim, durationMs: 2000 });
    });

    // Wait up to 5s for the tab to close
    await expect.poll(async () => {
      const tabs = await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.title));
      return tabs.includes('Victim');
    }, { timeout: 5_000 }).toBe(false);
  } finally {
    await context.close();
  }
});
```

- [ ] **Step 3: Run E2E test**

Run:
```bash
npm run test:e2e
```
Expected: PASS — victim tab closes within 5 seconds of the 2-second timer starting.

- [ ] **Step 4: Commit**

```bash
git add e2e/extension.spec.js package.json package-lock.json
git commit -m "test(e2e): timer fires and closes target tab"
```

---

## Task 16: E2E — Cancel, Extend, Manual-Close Cleanup

**Files:**
- Modify: `e2e/extension.spec.js`

- [ ] **Step 1: Add cancel test**

Append to `e2e/extension.spec.js`:
```js
test('cancelling a timer prevents tab close', async () => {
  const { context, sw } = await launchWithExtension();
  try {
    const page = await context.newPage();
    await page.goto('data:text/html,<title>Survivor</title>');
    await page.waitForLoadState('load');

    await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const target = tabs.find((t) => t.title === 'Survivor');
      await chrome.runtime.sendMessage({ type: 'start', tab: target, durationMs: 3000 });
      await chrome.runtime.sendMessage({ type: 'cancel', tabId: target.id });
    });

    // Wait longer than the original duration; tab should still be there
    await new Promise((r) => setTimeout(r, 4000));
    const titles = await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.title));
    expect(titles).toContain('Survivor');
  } finally {
    await context.close();
  }
});

test('manually closing a tab cleans up storage and wake-lock', async () => {
  const { context, sw } = await launchWithExtension();
  try {
    const page = await context.newPage();
    await page.goto('data:text/html,<title>Manual</title>');
    await page.waitForLoadState('load');

    await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const target = tabs.find((t) => t.title === 'Manual');
      await chrome.runtime.sendMessage({ type: 'start', tab: target, durationMs: 60_000 });
    });

    await page.close();
    await new Promise((r) => setTimeout(r, 500));

    const { timers } = await sw.evaluate(async () => {
      return await chrome.storage.session.get('timers');
    });
    expect(timers ?? {}).toEqual({});
  } finally {
    await context.close();
  }
});

test('extending a timer postpones the close', async () => {
  const { context, sw } = await launchWithExtension();
  try {
    const page = await context.newPage();
    await page.goto('data:text/html,<title>Extended</title>');
    await page.waitForLoadState('load');

    await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const target = tabs.find((t) => t.title === 'Extended');
      await chrome.runtime.sendMessage({ type: 'start', tab: target, durationMs: 2000 });
      await chrome.runtime.sendMessage({ type: 'extend', tabId: target.id });
    });

    // After 3s (longer than the original 2s but shorter than 2s + 5min), tab should still exist
    await new Promise((r) => setTimeout(r, 3000));
    const titles = await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.title));
    expect(titles).toContain('Extended');
  } finally {
    await context.close();
  }
});
```

- [ ] **Step 2: Run E2E tests**

Run:
```bash
npm run test:e2e
```
Expected: PASS — all four E2E tests.

- [ ] **Step 3: Commit**

```bash
git add e2e/extension.spec.js
git commit -m "test(e2e): cancel, manual-close cleanup, and extend"
```

---

## Task 17: Manual Smoke Test Checklist

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add manual checklist to README**

Append to `README.md`:
```markdown
## Manual smoke test

Load the unpacked extension, then verify by hand:

- [ ] Start a 5-minute timer on a tab. Unplug from power. Screen stays awake for the full 5 minutes.
- [ ] While a timer is active, switch to another tab, type in other apps, open a new window. All normal.
- [ ] Click the extension icon — the badge shows a dot while any timer is active; empty when none.
- [ ] In `chrome://extensions`, toggle "Allow in incognito" on. Open an incognito window, start a timer. It fires correctly.
- [ ] Start a 45-second timer, then leave the browser idle for 30+ seconds. The timer still fires (service-worker wake is handled by `chrome.alarms`).
- [ ] Start a 10-second timer, then leave the browser idle. The timer still fires (keep-alive port holds the service worker).
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: manual smoke test checklist"
```

---

## Task 18: Final Verification

- [ ] **Step 1: Run every test**

Run:
```bash
npm test
npm run test:e2e
```
Expected: all tests pass.

- [ ] **Step 2: Manual load-and-use test**

1. Open `chrome://extensions`, enable Developer Mode.
2. Click "Load unpacked" and select the project folder.
3. Open a YouTube video in a new tab.
4. Click the extension icon; set a 30-second timer; click Start.
5. Switch to another tab. Verify screen does not sleep (or use a short display-sleep timeout to confirm).
6. Verify the YouTube tab closes at 30 seconds.

- [ ] **Step 3: Tag v0.1.0**

Run:
```bash
git tag v0.1.0
```

- [ ] **Step 4: Mark plan complete**

All tasks checked off; extension ready to use.

---

## Open Questions

None.
