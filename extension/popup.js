// How long to wait for an open Shy Safari tab to answer a "sync now" request.
const SYNC_REPLY_TIMEOUT_MS = 4000;
const NEARLY_FULL_RATIO = 0.8;

const ERROR_MESSAGES = {
  quota: '雲端空間已滿，最新的紀錄無法上傳。請到「管理備份」下載備份檔保存。',
  incomplete: '雲端資料超過 10 分鐘都沒有同步完整。請確認 Chrome 的同步功能有開啟，而且同步項目包含「擴充功能」。',
  failed: '上次同步失敗',
};

function formatTime(ms) {
  return ms ? new Date(ms).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' }) : '尚未同步';
}

function showWarnings(list) {
  const box = document.getElementById('warnings');
  box.replaceChildren();
  if (!list.length) {
    const ok = document.createElement('p');
    ok.className = 'ok';
    ok.textContent = '✓ 同步正常';
    box.append(ok);
    return;
  }
  list.forEach((text) => {
    const p = document.createElement('p');
    p.className = 'warning';
    p.textContent = text;
    box.append(p);
  });
}

async function render() {
  const local = await chrome.storage.local.get(['lastSyncedAt', 'error', 'errorMessage', 'backups']);
  const { meta } = await chrome.storage.sync.get('meta');
  const used = await chrome.storage.sync.getBytesInUse(null);
  const quota = chrome.storage.sync.QUOTA_BYTES;
  const { email } = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });

  document.getElementById('local').textContent = formatTime(local.lastSyncedAt);
  document.getElementById('remote').textContent = formatTime(meta && meta.updatedAt);
  document.getElementById('usage').textContent = (used / 1024).toFixed(1) + ' KB / ' + (quota / 1024).toFixed(0) + ' KB';
  document.getElementById('backups').textContent = (local.backups || []).length + ' 份（存在這台電腦）';

  const warnings = [];
  if (!email) warnings.push('Chrome 沒有登入 Google 帳號，紀錄只存在這台電腦，不會同步到其他電腦。');
  if (local.error) {
    const text = ERROR_MESSAGES[local.error] || ERROR_MESSAGES.failed;
    warnings.push(local.error === 'failed' && local.errorMessage ? text + '：' + local.errorMessage : text);
  }
  if (local.error !== 'quota' && used > quota * NEARLY_FULL_RATIO) warnings.push('雲端空間快滿了，建議到「管理備份」下載一份備份檔。');
  showWarnings(warnings);
}

// The popup can't reach Shy Safari's page directly, so it leaves a request that the
// content script answers by updating lastCheckedAt.
async function syncNow() {
  const button = document.getElementById('sync-now');
  const message = document.getElementById('message');
  button.disabled = true;
  message.textContent = '同步中…';
  const requestedAt = Date.now();
  await chrome.storage.local.set({ syncRequest: requestedAt });
  const answered = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.storage.onChanged.removeListener(listener);
      resolve(false);
    }, SYNC_REPLY_TIMEOUT_MS);
    function listener(changes, areaName) {
      if (areaName === 'local' && changes.lastCheckedAt && changes.lastCheckedAt.newValue >= requestedAt) {
        clearTimeout(timer);
        chrome.storage.onChanged.removeListener(listener);
        resolve(true);
      }
    }
    chrome.storage.onChanged.addListener(listener);
  });
  const { error } = await chrome.storage.local.get('error');
  if (!answered) message.textContent = '沒有開著的 Shy Safari 分頁。打開 Shy Safari 後就會自動同步。';
  else message.textContent = error ? '同步沒有成功，請看上方的警告。' : '已同步。';
  button.disabled = false;
  render();
}

document.getElementById('sync-now').addEventListener('click', syncNow);
document.getElementById('open-backups').addEventListener('click', () => chrome.runtime.openOptionsPage());
render();
