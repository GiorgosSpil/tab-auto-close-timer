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

function setCustomFields(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  document.getElementById('custom-hours').value = String(h);
  document.getElementById('custom-minutes').value = String(m);
  document.getElementById('custom-seconds').value = String(s);
}

function readCustomSeconds() {
  const h = Number(document.getElementById('custom-hours').value) || 0;
  const m = Number(document.getElementById('custom-minutes').value) || 0;
  const s = Number(document.getElementById('custom-seconds').value) || 0;
  return h * 3600 + m * 60 + s;
}

function wireNoTimerControls() {
  for (const btn of document.querySelectorAll('.preset')) {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.preset').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      setCustomFields(Number(btn.dataset.seconds));
    });
  }

  document.getElementById('start-btn').addEventListener('click', async () => {
    const err = document.getElementById('start-error');
    err.hidden = true;
    const seconds = readCustomSeconds();
    if (!Number.isFinite(seconds) || seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
      err.hidden = false;
      err.textContent = `Enter a total between ${MIN_SECONDS} second and ${MAX_SECONDS} seconds (24h).`;
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
