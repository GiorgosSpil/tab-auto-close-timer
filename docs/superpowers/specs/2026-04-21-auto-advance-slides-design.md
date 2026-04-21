# Auto-Advance Slides — Design

**Date:** 2026-04-21
**Status:** Approved, ready for planning

## Problem

The `learn.practica.gr/Education/` platform plays course videos that auto-pause at the end of each slide (the narration finishes, then the player stops and waits for the user to click play or "Επόμενο" to advance). With 349 slides per course, manually clicking through every slide defeats the purpose of leaving the tab open with the auto-close timer running.

The user wants the slides to advance automatically while the existing tab-auto-close-timer counts down, so they can leave the tab unattended.

## Solution

Add a content script to the existing extension that detects when the iSpring player auto-pauses and clicks the play button to resume. Expose a global on/off toggle in the popup.

## Components

### 1. Content script — `src/content/auto-advance.js`

- Injected on `*://learn.practica.gr/Education/*` with `all_frames: true` (the iSpring player is rendered inside a child frame).
- Locates the play/pause button via `.play-controls-container__play-pause-button`.
- Detects "paused" state by inspecting the inner `<svg><path>` `d` attribute. When the path starts with `M5 16.3087` (the play triangle), the player is paused. When it changes to the pause-bars path, the player is playing.
- Watches for state changes with a `MutationObserver` on the button subtree, plus a 2-second safety poll in case the observer misses an event.
- On paused detected: waits ~500 ms, then calls `.click()` on the button.
- Reads the `autoAdvanceEnabled` flag from `chrome.storage.sync` on startup and listens to `chrome.storage.onChanged` to react to popup toggles without a page reload.
- Does nothing when the flag is `false`.

### 2. Popup toggle — `popup/popup.html`, `popup/popup.css`, `popup/popup.js`

- Add a new row to the popup: a labeled checkbox "Auto-advance slides".
- On change, write to `chrome.storage.sync` key `autoAdvanceEnabled` (boolean, default `false`).
- On popup open, read the current value and reflect it in the checkbox.

### 3. Manifest — `manifest.json`

- Add a `content_scripts` entry:
  ```json
  {
    "matches": ["*://learn.practica.gr/Education/*"],
    "js": ["src/content/auto-advance.js"],
    "all_frames": true,
    "run_at": "document_idle"
  }
  ```
- No new permissions needed; `storage` is already granted.

## Data flow

```
popup checkbox  →  chrome.storage.sync.autoAdvanceEnabled
                              ↓
                  chrome.storage.onChanged
                              ↓
                content script (every frame on practica.gr)
                              ↓
        MutationObserver on play button + 2s poll
                              ↓
              detect paused state → wait 500 ms → click
```

## Edge cases

- **Iframe origin mismatch.** If the iSpring player iframe is served from a different host than `learn.practica.gr`, the script won't reach it. Mitigation: test after ship, add the iframe host to `matches` if needed.
- **Button missing.** Frames without the play button (the parent `learn.practica.gr` page itself, ad iframes, etc.) just exit silently when the selector returns nothing.
- **End of course.** The script keeps watching forever. If the player reaches the last slide and stays paused, it will keep clicking play. Acceptable for v1 — out of scope to detect course end.
- **Manual pause.** While the toggle is on, the script will fight the user if they pause manually. The popup toggle is the escape hatch; user disables it when they want manual control.

## Out of scope (YAGNI)

- Clicking "Επόμενο" (Next) — play button works for the same purpose.
- Configurable click delay.
- Per-tab toggle.
- Detecting end-of-course.
- Visual indicator on the page.

## Files touched

- `manifest.json` — add `content_scripts`
- `src/content/auto-advance.js` — new file
- `popup/popup.html` — add checkbox row
- `popup/popup.css` — minor styling for the new row
- `popup/popup.js` — wire checkbox to storage
