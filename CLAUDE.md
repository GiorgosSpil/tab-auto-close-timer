# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm test` — run unit tests once (Vitest).
- `npm run test:watch` — Vitest in watch mode.
- `npm run test:e2e` — Playwright (config present; there is no `e2e/` directory yet, so this is a placeholder).
- Run a single test file: `npx vitest run tests/<file>.test.js`.
- No build step. The repo *is* the extension — load it via `chrome://extensions` → "Load unpacked" and point at the repo root. After editing any file, click the reload icon on the extension's card; reloading the service worker clears all `chrome.storage.session` state (in-flight timers reset).

## Architecture

Chrome Manifest V3 extension with no build pipeline. ES modules are loaded directly by the browser (`"type": "module"` in both `manifest.json` service worker and `package.json`).

### State ownership

`chrome.storage.session` (key `timers`) is the single source of truth for active timers. Everything else — the service worker, the popup, and the content script — *reads* from session storage and *reacts* to it. Never hold timer state in module-level variables as the authoritative copy: the service worker can be terminated and restarted at any time.

```
timers: { "<tabId>": { targetTimestamp, originalDurationMs, tabTitle, tabFaviconUrl } }
```

Session storage survives service-worker restarts but clears on browser restart (correct — the tabs are gone too). The service worker calls `setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })` on startup so content scripts can read `timers` directly.

### Dual scheduling strategy (`src/scheduler.js`)

Timers split by remaining duration at `THRESHOLD_MS` (30s):

- **≥ 30s** → `chrome.alarms.create('close-tab-<tabId>', { when })`. Alarms are the only reliable way to fire after the service worker has been evicted, but Chrome throttles them below 30s.
- **< 30s** → `setTimeout` in the service worker, plus a `chrome.runtime.connect` "keepalive" port (`KEEPALIVE_PORT_NAME`). The port prevents the SW from being evicted for the short wait. When all short timers clear, the port is disconnected.

Extending a timer (`+5 min`) may cross the threshold in either direction; `schedule()` always calls `unschedule()` first, so the two mechanisms are never both armed for the same tab.

### Message/event flow

```
popup.js  ──sendMessage──▶  background.js (onMessage)  ──▶  timer-manager.js
                                                           │
                                                           ├─▶ storage.js (chrome.storage.session)
                                                           ├─▶ scheduler.js (alarms OR setTimeout+port)
                                                           ├─▶ wake-lock.js (chrome.power)
                                                           └─▶ badge.js (chrome.action)

chrome.alarms.onAlarm ──▶ handleAlarmFired ──▶ closeAndCleanup
chrome.tabs.onRemoved ──▶ handleTabRemoved  (manual close: clean storage, clear alarm/timeout)
chrome.runtime.onStartup ──▶ updateWakeLock + updateBadge (resync from storage)
```

`background.js` is a thin listener wrapper — all logic lives in `timer-manager.js`. The `whoami` message is used by the content script to resolve its own `tabId` via `sender.tab.id`.

### Content scripts (`src/content/`)

Both scoped to `*://learn.practica.gr/*`. Two files, two Chromium execution worlds:

- **`heartbeat-sniff.js`** (MAIN world, `document_start`, all frames) — patches `window.fetch` and `XMLHttpRequest.prototype.open` to spot `SessionHeartbeat.ashx` requests. Each hit is relayed to the isolated world via `window.postMessage({ source: 'tact-heartbeat', url })`. Must run in the MAIN world because the isolated world has its own `fetch`/`XHR` and cannot intercept the page's.
- **`auto-advance.js`** (isolated world, `document_idle`, all frames) — two behaviors, both gated on "does this tab have an active timer?" via `chrome.storage.session.timers[tabId]` + `chrome.storage.onChanged`:
  1. *Auto-advance slides*: `MutationObserver` + 2s poll on the iSpring play button; when the SVG path indicates "paused", clicks the "next" button after 500ms.
  2. *Session keepalive*: replays the most recently captured heartbeat URL on a user-configurable cadence (popup input, persisted to `chrome.storage.local` under `keepaliveMinutes`, default 5 min) via a same-origin `fetch(..., { credentials: 'include' })`. The content script reloads the interval from `chrome.storage.onChanged` and re-arms the `setInterval` live — no reload needed. The site's own heartbeat cadence is unreliable when the tab is backgrounded, so we keep the session warm ourselves.

### Constants

`src/constants.js` is the single place for tunables: `THRESHOLD_MS`, `MIN_SECONDS`/`MAX_SECONDS` (1s / 24h), `EXTEND_MS` (5 min), `ALARM_PREFIX`, `KEEPALIVE_PORT_NAME`, badge color.

## Testing

Vitest uses a handwritten `chrome.*` API mock in `tests/setup.js` (`beforeEach` resets `globalThis.chrome`). The mock tracks alarms, session storage, tabs, and listeners so handlers can be driven directly. `vitest.config.js` uses the `node` environment by default, switching to `jsdom` for `tests/popup.test.js`.

The scheduler module holds module-level state (`pendingTimeouts`, `keepalivePort`, `fireCallback`); tests should call `__resetSchedulerForTests()` when needed to avoid leakage between cases.

## Design docs

`docs/superpowers/specs/` contains the authoritative design specs — consult them before making behavioral changes:
- `2026-04-17-tab-auto-close-timer-design.md` — core timer/wake-lock architecture.
- `2026-04-21-auto-advance-slides-design.md` — practica.gr content-script behavior.
