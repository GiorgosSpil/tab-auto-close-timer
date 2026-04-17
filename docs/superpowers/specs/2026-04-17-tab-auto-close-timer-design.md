# Tab Auto-Close Timer — Design

**Date:** 2026-04-17
**Status:** Approved for planning

## Summary

A Chrome Manifest V3 extension that closes a browser tab after a user-configured duration (1 second to 24 hours). While any timer is active, the extension holds an OS-level display wake-lock so the screen stays on; the PC remains fully usable, and the target tab does not need to be focused or visible.

## Goals

- Auto-close any tab after a configurable wall-clock duration.
- Keep the display awake at the OS level while at least one timer is active.
- Leave the PC fully usable: no tab or window needs focus for the timer to work.
- Support multiple concurrent timers across different tabs.
- Survive service-worker restarts; correctly clean up on browser restart.

## Non-Goals

- Targeting tabs by URL pattern, or persisting timers across browser restarts.
- Counting playback time or focus time (wall-clock only).
- Firefox / Safari support (Chromium-family only: Chrome, Edge, Brave, Arc).
- Content-script interaction with the target page (no site-specific hooks).

## Architecture

Three pieces:

### Popup (`popup.html` + `popup.js`)
Opens when the user clicks the extension icon. Shows:
- Current tab's title and whether a timer is already running on it.
- Duration input (seconds, with quick presets: 10m / 20m / 30m / 60m).
- Start button (or Cancel if a timer is active on this tab).
- "+5 min" extend button when the current tab has an active timer.
- List of all active timers across tabs with live countdowns and per-row cancel buttons.

Countdowns update live via a 1-second `setInterval` while the popup is open. The popup derives remaining time from stored target timestamps; it never owns timer state.

### Service worker (`background.js`)
The coordinator. Owns:
- The timer registry (via `chrome.storage.session`).
- `chrome.alarms` scheduling for timers ≥ 30 seconds (one alarm per active timer, named `close-tab-<tabId>`).
- `setTimeout` scheduling for timers < 30 seconds (Chrome alarms are not reliably fired below 30s in production builds).
- Wake-lock coordination: calls `chrome.power.requestKeepAwake("display")` when the first timer starts; `chrome.power.releaseKeepAwake()` when the last timer ends.
- Listeners for `chrome.alarms.onAlarm` (fire event), `chrome.tabs.onRemoved` (manual tab close cleanup), and `chrome.runtime.onStartup` (resync wake-lock state based on storage contents).
- On alarm fire: reads the tabId from the alarm name, calls `chrome.tabs.remove(tabId)`, deletes the storage entry, updates the wake-lock.

### Storage (`chrome.storage.session`)
Survives service-worker restarts but not browser restarts. Holds:

```js
// Key: "timers"
{
  "<tabId>": {
    targetTimestamp: <ms since epoch>,   // absolute close time
    originalDurationMs: <number>,        // for display and extend math
    tabTitle: "<cached at start>",
    tabFaviconUrl: "<cached at start>"
  },
  ...
}
```

Session storage is the correct choice here: timers should not survive a browser restart, because the tabs they target won't.

### No content scripts
Everything happens at the tab/browser level. Avoids breaking on sites with strict CSP, iframes, or DRM, and keeps permissions minimal: `tabs`, `alarms`, `power`, `storage`.

## Data Flow

| Event | Action |
|---|---|
| User clicks **Start** in popup | Service worker writes entry to storage; creates `chrome.alarms` entry (≥30s) or `setTimeout` (<30s); calls `requestKeepAwake("display")` if this is the first active timer. |
| User clicks **Cancel** on a timer | Service worker deletes storage entry; clears alarm or `setTimeout`; calls `releaseKeepAwake()` if no timers remain. |
| User clicks **+5 min** | Service worker adds 300000 ms to `targetTimestamp`; clears the old alarm or `setTimeout`; reschedules against the new target (alarm if new remaining ≥ 30s, `setTimeout` otherwise — the extend path may switch mechanisms). Rejects if current `targetTimestamp < now`. |
| Alarm fires (or `setTimeout` callback runs) | Reads tabId from alarm name; calls `chrome.tabs.remove(tabId)`; deletes storage entry; updates wake-lock. Catches and logs if the tab no longer exists. |
| Tab closed manually before alarm fires | `chrome.tabs.onRemoved` handler deletes storage entry; clears the alarm; updates wake-lock. |
| Service worker restarts | `chrome.alarms` and `chrome.storage.session` persist automatically. On `onStartup`, `updateWakeLock()` is called to resync in-memory wake-lock state against storage contents. |
| Browser restart | Session storage and alarms clear. All timers gone. Correct — the tabs are gone too. |

### Wake-lock coordination
A single in-memory boolean `isKeepingAwake`. Helper `updateWakeLock()` reads `storage.session.timers`; if count > 0 and not already awake → request; if count = 0 and awake → release. Called on every state change and on service-worker startup.

## UI

### State A — No timer on current tab

```
┌─────────────────────────────────────┐
│ Current tab:                        │
│ "<page title>"                      │
│                                     │
│ Close this tab in:                  │
│ [ 10m ] [ 20m ] [ 30m ] [ 60m ]    │
│ or custom: [___] seconds            │
│ (1 second minimum, 24 hour maximum) │
│                                     │
│           [  Start timer  ]         │
│                                     │
│ ─── Active timers (N) ───           │
│ • "<title>"          MM:SS  [×]    │
└─────────────────────────────────────┘
```

### State B — Timer already active on current tab

```
┌─────────────────────────────────────┐
│ This tab will close in:             │
│                                     │
│        ⏱  HH:MM:SS                  │
│                                     │
│   [ +5 min ]  [ Cancel timer ]      │
│                                     │
│ ─── Other active timers (N) ───     │
│ • "<title>"          MM:SS  [×]    │
└─────────────────────────────────────┘
```

### Countdown format
- `MM:SS` when remaining < 10 minutes
- `HH:MM:SS` when remaining ≥ 10 minutes

### Icon badge
A subtle tinted badge dot on the extension icon whenever at least one timer is active. No per-second badge countdown (would require constantly waking the service worker; battery cost). Cleared when no timers remain.

### Input validation
- Custom seconds field: min = 1, max = 86400 (24h). Reject out-of-range values in the popup with an inline error; service worker also guards.

## Edge Cases & Error Handling

- **Tab closed before alarm fires:** `chrome.tabs.onRemoved` cleans up the stale entry and alarm.
- **Tab navigated to a new URL:** Timer persists. A timer is about the tab, not the page.
- **Tab moved to a different window:** `tabId` is stable; nothing to do.
- **Tab discarded by Chrome under memory pressure:** `tabId` survives discard; `chrome.tabs.remove()` still works.
- **Alarm fires but tab no longer exists:** `chrome.tabs.remove()` rejects; catch, log, clean up storage + wake-lock. Shouldn't happen thanks to `onRemoved` cleanup, but guarded as a safety net.
- **Service worker killed mid-operation:** `chrome.storage.session` and `chrome.alarms` persist. On `onStartup`, `updateWakeLock()` resyncs the wake-lock state from storage.
- **Sub-30s timer when service worker idles:** For `setTimeout`-based timers, the service worker is kept alive during the window by holding a short-lived port connection. If a sub-30s timer is scheduled, open the port; close it when the timer fires or is cancelled.
- **Browser restart:** Session storage clears, alarms clear. All timers gone. Tabs also gone.
- **User sets 0 or negative duration:** Popup validation enforces min = 1s, max = 86400s. Service worker also guards.
- **+5 min pressed after timer expired (race):** Popup disables the button once remaining ≤ 0. Service worker guard rejects extensions where `targetTimestamp < now`.
- **`chrome.power.requestKeepAwake` rejects:** Log and continue. The timer still fires; only the screen-awake guarantee is lost. Popup shows a small warning banner for the session.
- **Multiple Chrome profiles:** Each profile has its own extension instance and its own timers. No cross-profile concerns.
- **Incognito:** Not enabled by default. User must explicitly toggle "Allow in incognito" on `chrome://extensions`. Then it works identically, with its own independent timer set.

## Timing Implementation: Alarms vs setTimeout

Chrome alarms have a minimum reliable granularity of 30 seconds in stable Chrome (the `when` field accepts shorter values, but alarms may not fire below 30s in production builds). Therefore:

- **Duration ≥ 30 seconds:** Use `chrome.alarms.create({when: targetTimestamp})`. Survives service-worker idle and restart automatically.
- **Duration < 30 seconds:** Use `setTimeout(closeTabHandler, remainingMs)` inside the service worker. Hold a short-lived port connection to keep the service worker alive for the duration of the timer. When the timer fires or is cancelled, close the port.

The distinction is internal to the service worker; the popup and the rest of the system do not need to know which mechanism a given timer uses.

## Testing

### Unit tests (Vitest, with Chrome API stubs)
- `startTimer(tabId, durationMs)` writes storage entry, schedules alarm or setTimeout by duration threshold, calls `updateWakeLock()`.
- `cancelTimer(tabId)` cleans up storage + alarm/timeout, updates wake-lock.
- `extendTimer(tabId, addMs)` updates target, reschedules, rejects when `targetTimestamp < now`.
- `onAlarmFired(alarmName)` closes tab, cleans up, updates wake-lock; handles missing tab gracefully.
- `onTabRemoved(tabId)` cleans up if a timer existed; no-op otherwise.
- `updateWakeLock()` transitions: 0→1 timers requests, 1→0 releases, otherwise no-op.

### Integration tests (Playwright with `launchPersistentContext` + unpacked extension)
- Start a 2-second timer on a test tab → tab closes within 2.5s.
- Start two timers, cancel one → the other still fires, wake-lock still held.
- Start a timer, close the tab manually → no orphan alarm; wake-lock released.
- Start a timer, click +5 min → new close time reflected.
- Popup opens, countdown updates after 1s (assert text change).

### Manual smoke checklist
- Screen genuinely stays awake during a 5-minute timer (unplug from power, watch display).
- PC remains usable — switch apps, type in other windows, etc.
- Works across incognito (after user-enabled in `chrome://extensions`).
- Survives a service-worker idle timeout (wait 30s+ doing nothing, then verify timer still fires).

### Not automatically tested
The OS-level `chrome.power` wake-lock itself — there is no programmatic way to assert the display wouldn't have slept. Covered by the manual smoke checklist.

## Permissions (manifest)

```json
{
  "manifest_version": 3,
  "permissions": ["tabs", "alarms", "power", "storage"],
  "action": { "default_popup": "popup.html" },
  "background": { "service_worker": "background.js" }
}
```

No host permissions needed — we never read or modify page content.

## Open Questions

None at time of writing.
