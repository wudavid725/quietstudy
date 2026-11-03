// Puts a red "!" on the toolbar icon whenever syncing needs attention, so problems
// are visible without opening the popup.

async function updateBadge() {
  const { error } = await chrome.storage.local.get('error');
  const { email } = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
  await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  await chrome.action.setBadgeText({ text: error || !email ? '!' : '' });
}

chrome.runtime.onInstalled.addListener(updateBadge);
chrome.runtime.onStartup.addListener(updateBadge);
chrome.identity.onSignInChanged.addListener(updateBadge);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && 'error' in changes) updateBadge();
});
