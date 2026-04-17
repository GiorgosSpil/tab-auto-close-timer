import { setTimer, getTimer, removeTimer } from './storage.js';
import { schedule, unschedule, registerFireCallback, parseTabIdFromAlarmName } from './scheduler.js';
import { updateWakeLock } from './wake-lock.js';
import { updateBadge } from './badge.js';
import { MIN_SECONDS, MAX_SECONDS, EXTEND_MS } from './constants.js';

registerFireCallback((tabId) => { handleTimeoutFired(tabId).catch(console.error); });

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

export async function cancelTimer(tabId) {
  const existing = await getTimer(tabId);
  if (!existing) return;
  await removeTimer(tabId);
  await unschedule(tabId);
  await updateWakeLock();
  await updateBadge();
}

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

export async function handleTabRemoved(tabId) {
  const existing = await getTimer(tabId);
  if (!existing) return;
  await removeTimer(tabId);
  await unschedule(tabId);
  await updateWakeLock();
  await updateBadge();
}
