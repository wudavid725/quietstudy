function formatTime(ms) {
  return ms ? new Date(ms).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' }) : '尚未同步';
}

(async () => {
  const { lastSyncedAt } = await chrome.storage.local.get('lastSyncedAt');
  const { meta } = await chrome.storage.sync.get('meta');
  const used = await chrome.storage.sync.getBytesInUse(null);
  document.getElementById('local').textContent = formatTime(lastSyncedAt);
  document.getElementById('remote').textContent = formatTime(meta && meta.updatedAt);
  document.getElementById('usage').textContent =
    (used / 1024).toFixed(1) + ' KB / ' + (chrome.storage.sync.QUOTA_BYTES / 1024).toFixed(0) + ' KB';
})();
