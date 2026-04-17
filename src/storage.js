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
