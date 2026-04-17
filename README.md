# Tab Auto-Close Timer

Chrome extension that closes a tab after a configurable timer while keeping the screen awake and the PC usable.

## Load unpacked

1. Open `chrome://extensions`.
2. Enable **Developer Mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Pin the extension to your toolbar for quick access.

## Use

1. Open the tab you want to auto-close.
2. Click the extension icon.
3. Pick a preset (1h / 5h 59m / 10h) or enter any duration in seconds (1–86400).
4. Click **Start timer**.

While any timer is active:
- Screen stays awake (OS-level wake lock).
- You can switch tabs, minimize the browser, and use the PC normally.
- The toolbar badge shows a dot as a reminder.

Click the icon again to see the countdown, cancel, add +5 minutes, or manage other active timers.

## Updating the extension after code changes

Chrome does not auto-reload unpacked extensions. After editing any file in this folder:

1. Open `chrome://extensions`.
2. Find the **Tab Auto-Close Timer** card.
3. Click the circular **reload** icon on the card.

If you changed the popup UI, close and reopen the popup to see the update. If you changed `manifest.json` or the service worker, the reload will restart the service worker too — any running timers stored in `chrome.storage.session` are cleared (sessions reset on extension reload).

Tip: to see service-worker logs while iterating, click **service worker** on the extension's card to open its DevTools.

## Manual smoke test

Load the unpacked extension, then verify by hand:

- [ ] Start a 5-minute timer on a tab. Unplug from power. Screen stays awake for the full 5 minutes.
- [ ] While a timer is active, switch to another tab, type in other apps, open a new window. All normal.
- [ ] Click the extension icon — the badge shows a dot while any timer is active; empty when none.
- [ ] In `chrome://extensions`, toggle "Allow in incognito" on. Open an incognito window, start a timer. It fires correctly.
- [ ] Start a 45-second timer, then leave the browser idle for 30+ seconds. The timer still fires (service worker wakes via `chrome.alarms`).
- [ ] Start a 10-second timer, then leave the browser idle. The timer still fires (keep-alive port holds the service worker).
- [ ] Start two timers on different tabs. Cancel one. The other still fires on schedule.
- [ ] Close a tab manually while its timer is running. Badge clears when no timers remain.

## Architecture

See `docs/superpowers/specs/2026-04-17-tab-auto-close-timer-design.md`.

## Files

```
manifest.json            # MV3 extension manifest
src/background.js        # Service worker: wires chrome listeners
src/timer-manager.js     # Core lifecycle: start/cancel/extend/fire/tab-removed
src/scheduler.js         # alarms (>=30s) vs setTimeout+keepalive (<30s)
src/storage.js           # chrome.storage.session wrapper
src/wake-lock.js         # chrome.power display keep-awake
src/badge.js             # Toolbar badge dot
src/formatters.js        # MM:SS / HH:MM:SS time formatting
src/constants.js         # Shared constants
popup/popup.html         # Popup markup
popup/popup.css          # Popup styles
popup/popup.js           # Popup controller
```
