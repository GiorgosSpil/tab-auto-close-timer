const TIMERS_KEY = 'timers';
const HEARTBEAT_STORAGE_KEY = 'keepaliveMinutes';
const DEFAULT_HEARTBEAT_MINUTES = 5;
const PLAY_BUTTON_SELECTOR = '.play-controls-container__play-pause-button';
const NEXT_BUTTON_SELECTOR = '.navigation-controls__button_next';
const PLAY_PATH_PREFIX = 'M5 16.3087';
const POLL_INTERVAL_MS = 2000;
const CLICK_DELAY_MS = 500;

let myTabId = null;
let enabled = false;
let observer = null;
let observedButton = null;
let pollHandle = null;
let pendingClick = null;
let heartbeatUrl = null;
let heartbeatHandle = null;
let heartbeatIntervalMs = DEFAULT_HEARTBEAT_MINUTES * 60 * 1000;

function isPaused(button) {
  const path = button.querySelector('svg path');
  const d = path?.getAttribute('d');
  return typeof d === 'string' && d.startsWith(PLAY_PATH_PREFIX);
}

function clickNext() {
  const next = document.querySelector(NEXT_BUTTON_SELECTOR);
  if (!next || next.disabled) return;
  const opts = { bubbles: true, cancelable: true, view: window };
  next.dispatchEvent(new PointerEvent('pointerdown', opts));
  next.dispatchEvent(new MouseEvent('mousedown', opts));
  next.dispatchEvent(new PointerEvent('pointerup', opts));
  next.dispatchEvent(new MouseEvent('mouseup', opts));
  next.dispatchEvent(new MouseEvent('click', opts));
}

function scheduleClick(playButton) {
  if (pendingClick !== null) return;
  pendingClick = setTimeout(() => {
    pendingClick = null;
    if (!enabled) return;
    if (!playButton.isConnected) return;
    if (isPaused(playButton)) {
      clickNext();
    }
  }, CLICK_DELAY_MS);
}

function checkAndClick() {
  if (!enabled) return;
  const button = document.querySelector(PLAY_BUTTON_SELECTOR);
  if (!button) return;
  if (isPaused(button)) {
    scheduleClick(button);
  }
}

function attachObserver() {
  const button = document.querySelector(PLAY_BUTTON_SELECTOR);
  if (!button || button === observedButton) return;
  if (observer) observer.disconnect();
  observer = new MutationObserver(checkAndClick);
  observer.observe(button, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['d']
  });
  observedButton = button;
  checkAndClick();
}

function pingHeartbeat() {
  if (!heartbeatUrl) return;
  fetch(heartbeatUrl, { credentials: 'include', cache: 'no-store' }).catch(() => {});
}

function startHeartbeat() {
  if (heartbeatHandle !== null) return;
  if (!heartbeatUrl) return;
  heartbeatHandle = setInterval(pingHeartbeat, heartbeatIntervalMs);
}

async function loadHeartbeatInterval() {
  const { [HEARTBEAT_STORAGE_KEY]: minutes } = await chrome.storage.local.get(HEARTBEAT_STORAGE_KEY);
  if (typeof minutes === 'number' && minutes > 0) {
    heartbeatIntervalMs = minutes * 60 * 1000;
  }
}

function applyHeartbeatIntervalChange(minutes) {
  heartbeatIntervalMs = (typeof minutes === 'number' && minutes > 0 ? minutes : DEFAULT_HEARTBEAT_MINUTES) * 60 * 1000;
  if (heartbeatHandle !== null) {
    stopHeartbeat();
    startHeartbeat();
  }
}

function stopHeartbeat() {
  if (heartbeatHandle !== null) {
    clearInterval(heartbeatHandle);
    heartbeatHandle = null;
  }
}

function start() {
  if (pollHandle !== null) return;
  attachObserver();
  pollHandle = setInterval(() => {
    if (!observedButton || !observedButton.isConnected) {
      observedButton = null;
      attachObserver();
    }
    checkAndClick();
  }, POLL_INTERVAL_MS);
  startHeartbeat();
}

function stop() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  observedButton = null;
  if (pollHandle !== null) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
  if (pendingClick !== null) {
    clearTimeout(pendingClick);
    pendingClick = null;
  }
  stopHeartbeat();
}

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  if (e.data?.source !== 'tact-heartbeat') return;
  const url = e.data.url;
  if (typeof url !== 'string') return;
  heartbeatUrl = url;
  if (enabled) startHeartbeat();
});

async function resolveMyTabId() {
  if (myTabId !== null) return myTabId;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'whoami' });
    myTabId = resp?.tabId ?? null;
  } catch {
    myTabId = null;
  }
  return myTabId;
}

async function hasTimerForMe() {
  const tabId = await resolveMyTabId();
  if (tabId === null) return false;
  const { [TIMERS_KEY]: timers = {} } = await chrome.storage.session.get(TIMERS_KEY);
  return Boolean(timers[String(tabId)]);
}

async function refreshState() {
  const wasEnabled = enabled;
  enabled = await hasTimerForMe();
  if (enabled && !wasEnabled) start();
  else if (!enabled && wasEnabled) stop();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && TIMERS_KEY in changes) {
    refreshState();
    return;
  }
  if (area === 'local' && HEARTBEAT_STORAGE_KEY in changes) {
    applyHeartbeatIntervalChange(changes[HEARTBEAT_STORAGE_KEY].newValue);
  }
});

loadHeartbeatInterval().then(refreshState);
