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

chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
  .catch(console.error);

chrome.alarms.onAlarm.addListener((alarm) => {
  handleAlarmFired(alarm).catch(console.error);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  handleTabRemoved(tabId).catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  Promise.all([updateWakeLock(), updateBadge()]).catch(console.error);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
        case 'whoami':
          sendResponse({ ok: true, tabId: sender?.tab?.id ?? null });
          break;
        default:
          sendResponse({ ok: false, error: 'unknown-type' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message ?? err) });
    }
  })();
  return true;
});

chrome.runtime.onConnect?.addListener?.((port) => {
  if (port.name === KEEPALIVE_PORT_NAME) {
    port.onDisconnect.addListener(() => {});
  }
});
