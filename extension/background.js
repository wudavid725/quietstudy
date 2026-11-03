// Puts a red "!" on the toolbar icon whenever syncing needs attention, so problems
// are visible without opening the popup.

async function updateBadge() {
  const { error } = await chrome.storage.local.get('error');
  const { email } = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
  await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  await chrome.action.setBadgeText({ text: error || !email ? '!' : '' });
}

// Self-update for copies loaded from a synced folder such as Google Drive: once the files on
// disk form a complete newer release, reload so every computer runs it without anyone
// visiting chrome://extensions.

const UPDATE_ALARM = 'check-for-update';
const UPDATE_CHECK_MINUTES = 2;
const SHY_SAFARI_TABS = 'https://www.shysafari.com/*';

async function sha256(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Unpacked extensions serve their files straight from disk, so this sees what the folder holds now.
async function fetchOwnFile(path) {
  const response = await fetch(chrome.runtime.getURL(path), { cache: 'no-store' });
  if (!response.ok) throw new Error(path + ' ' + response.status);
  return response;
}

// Folder sync delivers files one at a time, so only a release whose every file already
// matches its recorded hash is safe to load.
async function releaseIsComplete(release) {
  for (const [path, expected] of Object.entries(release.files)) {
    const response = await fetchOwnFile(path).catch(() => null);
    if (!response || (await sha256(await response.arrayBuffer())) !== expected) return false;
  }
  return true;
}

async function checkForUpdate() {
  const release = await (await fetchOwnFile('release.json')).json();
  if (release.version === chrome.runtime.getManifest().version) return;
  if (!(await releaseIsComplete(release))) return;
  // Reloading cuts off the sync script in open Shy Safari tabs, so wait until they are closed.
  const tabs = await chrome.tabs.query({ url: SHY_SAFARI_TABS });
  if (tabs.length) {
    await chrome.storage.local.set({ pendingUpdate: release.version });
    return;
  }
  chrome.runtime.reload();
}

function checkForUpdateQuietly() {
  checkForUpdate().catch((err) => console.warn('[Shy Safari 自動同步] 檢查更新失敗', err));
}

async function ensureUpdateAlarm() {
  if (!(await chrome.alarms.get(UPDATE_ALARM))) {
    await chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: UPDATE_CHECK_MINUTES });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove('pendingUpdate');
  updateBadge();
});
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
  checkForUpdateQuietly();
});
chrome.identity.onSignInChanged.addListener(updateBadge);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && 'error' in changes) updateBadge();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) checkForUpdateQuietly();
});
chrome.tabs.onRemoved.addListener(async () => {
  const { pendingUpdate } = await chrome.storage.local.get('pendingUpdate');
  if (pendingUpdate) checkForUpdateQuietly();
});
ensureUpdateAlarm();
