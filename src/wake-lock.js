import { countTimers } from './storage.js';

let isKeepingAwake = false;

export async function updateWakeLock() {
  const count = await countTimers();
  if (count > 0 && !isKeepingAwake) {
    chrome.power.requestKeepAwake('display');
    isKeepingAwake = true;
  } else if (count === 0 && isKeepingAwake) {
    chrome.power.releaseKeepAwake();
    isKeepingAwake = false;
  }
}

export function __resetWakeLockForTests() {
  isKeepingAwake = false;
}
