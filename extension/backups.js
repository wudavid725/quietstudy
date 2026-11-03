// Relies on backup-store.js for BACKUP_REASONS.

function formatTime(ms) {
  return new Date(ms).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' });
}

function showMessage(text, isError) {
  const message = document.getElementById('message');
  message.textContent = text;
  message.className = isError ? 'error' : '';
}

// Same file format as the bookmarklet tool, so files from either can be restored here.
function downloadSnapshot(snapshot, at) {
  const text = JSON.stringify({ app: 'shysafari', exportedAt: new Date(at).toISOString(), data: JSON.parse(snapshot) }, null, 2);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  link.download = 'shysafari-backup-' + new Date(at).toISOString().slice(0, 16).replace(':', '') + '.json';
  link.click();
  URL.revokeObjectURL(link.href);
}

async function requestRestore(snapshot, label) {
  if (!confirm('要把 Shy Safari 還原成「' + label + '」嗎？\n\n目前的紀錄會先另存一份備份，所有電腦都會改用還原後的版本。')) return;
  await chrome.storage.local.set({ pendingRestore: snapshot });
  showMessage('已送出還原。如果 Shy Safari 開著，會馬上還原並重新整理；沒開的話，下次打開時會還原。');
}

async function renderList() {
  const { backups = [] } = await chrome.storage.local.get('backups');
  const tbody = document.getElementById('backup-list');
  tbody.replaceChildren();
  if (!backups.length) {
    const row = tbody.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 4;
    cell.className = 'empty';
    cell.textContent = '還沒有備份。開始使用 Shy Safari 後會自動產生。';
    return;
  }
  backups.forEach((backup) => {
    const row = tbody.insertRow();
    row.insertCell().textContent = formatTime(backup.at);
    row.insertCell().textContent = BACKUP_REASONS[backup.reason] || backup.reason;
    const size = row.insertCell();
    size.className = 'size';
    size.textContent = (backup.snapshot.length / 1024).toFixed(1) + ' KB';
    const actions = row.insertCell();
    actions.className = 'actions';
    const restore = document.createElement('button');
    restore.textContent = '還原';
    restore.addEventListener('click', () => requestRestore(backup.snapshot, formatTime(backup.at) + ' 的備份'));
    const download = document.createElement('button');
    download.textContent = '下載';
    download.addEventListener('click', () => downloadSnapshot(backup.snapshot, backup.at));
    actions.append(restore, ' ', download);
  });
}

document.getElementById('download-current').addEventListener('click', async () => {
  const { lastSnapshot } = await chrome.storage.local.get('lastSnapshot');
  if (!lastSnapshot) {
    showMessage('這台電腦還沒有同步過，請先打開一次 Shy Safari。', true);
    return;
  }
  downloadSnapshot(lastSnapshot, Date.now());
  showMessage('已下載目前的紀錄。');
});

document.getElementById('import-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch (err) {
    showMessage('這個檔案不是有效的備份檔。', true);
    return;
  }
  if (!backup || backup.app !== 'shysafari' || !backup.data || typeof backup.data !== 'object') {
    showMessage('這不是 Shy Safari 的備份檔。', true);
    return;
  }
  const data = {};
  Object.keys(backup.data).sort().forEach((key) => { data[key] = String(backup.data[key]); });
  await requestRestore(JSON.stringify(data), '備份檔 ' + file.name);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.backups) renderList();
});

renderList();
