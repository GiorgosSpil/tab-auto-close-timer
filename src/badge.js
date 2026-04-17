import { countTimers } from './storage.js';
import { BADGE_COLOR } from './constants.js';

export async function updateBadge() {
  const count = await countTimers();
  if (count > 0) {
    await chrome.action.setBadgeText({ text: '●' });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}
