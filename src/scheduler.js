import { ALARM_PREFIX, THRESHOLD_MS, KEEPALIVE_PORT_NAME } from './constants.js';

const pendingTimeouts = new Map();
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
