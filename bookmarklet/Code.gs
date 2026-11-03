// Shy Safari 同步 — 貼到 Google 試算表的「擴充功能 → Apps Script」。
// 安裝步驟：https://github.com/wudavid725/quietstudy/tree/main/bookmarklet
//
// The sheet keeps the current Shy Safari data plus a history of backups. The bookmark
// talks to this script as a web app; every request must carry the sync key.

const CURRENT_SHEET = '目前紀錄';
const BACKUP_SHEET = '備份';
const MAX_BACKUPS = 200;
// Routine copies are spaced out so the history reaches back weeks rather than minutes.
const ROUTINE_BACKUP_GAP_MS = 20 * 60 * 1000;
// A cell holds at most 50,000 characters, so a snapshot is split across columns.
const CELL_CHUNK = 45000;
// Each chunk is prefixed so Sheets never reads it as a formula or a number.
const CHUNK_MARK = '~';
const LOADER_URL = 'https://cdn.jsdelivr.net/gh/wudavid725/quietstudy@main/bookmarklet/sync.js';

const REASONS = {
  routine: '定期備份',
  'before-load': '載入雲端紀錄前，那台電腦原本的紀錄',
  conflict: '兩台同時使用時，其中一台的紀錄',
  'conflict-remote': '兩台同時使用時，雲端上的紀錄',
  'before-restore': '還原前的紀錄',
};

// --- Sheet storage ---------------------------------------------------------------

function getSheet(name, headers) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(name);
  if (!sheet) {
    sheet = book.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function currentSheet() {
  return getSheet(CURRENT_SHEET, ['版本', '更新時間', '資料']);
}

function backupSheet() {
  return getSheet(BACKUP_SHEET, ['時間', '原因', '大小 (KB)', '編號', '資料']);
}

function toCells(snapshot) {
  const cells = [];
  for (let i = 0; i < snapshot.length; i += CELL_CHUNK) cells.push(CHUNK_MARK + snapshot.slice(i, i + CELL_CHUNK));
  return cells.length ? cells : [CHUNK_MARK];
}

function fromCells(row) {
  return row.filter((cell) => typeof cell === 'string' && cell.charAt(0) === CHUNK_MARK).map((cell) => cell.slice(1)).join('');
}

function readCurrent() {
  const sheet = currentSheet();
  if (sheet.getLastRow() < 2) return null;
  const row = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (!row[0]) return null;
  return { rev: String(row[0]), updatedAt: new Date(row[1]).getTime(), snapshot: fromCells(row.slice(2)) };
}

function writeCurrent(snapshot) {
  const sheet = currentSheet();
  const rev = Utilities.getUuid();
  const row = [rev, new Date()].concat(toCells(snapshot));
  if (sheet.getLastRow() >= 2) sheet.getRange(2, 1, 1, sheet.getLastColumn()).clearContent();
  sheet.getRange(2, 1, 1, row.length).setValues([row]);
  return rev;
}

// Newest backup sits on row 2.
function addBackup(snapshot, reason) {
  if (!snapshot || snapshot === '{}') return;
  const sheet = backupSheet();
  const count = sheet.getLastRow() - 1;
  if (count > 0) {
    const recent = sheet.getRange(2, 1, Math.min(count, 50), sheet.getLastColumn()).getValues();
    if (fromCells(recent[0].slice(4)) === snapshot) return;
    const lastRoutine = recent.find((row) => row[1] === REASONS.routine);
    if (reason === 'routine' && lastRoutine && Date.now() - new Date(lastRoutine[0]).getTime() < ROUTINE_BACKUP_GAP_MS) return;
  }
  const now = new Date();
  const row = [now, REASONS[reason] || reason, Math.round(snapshot.length / 102.4) / 10, now.getTime()].concat(toCells(snapshot));
  sheet.insertRowAfter(1);
  sheet.getRange(2, 1, 1, row.length).setValues([row]);
  if (sheet.getLastRow() - 1 > MAX_BACKUPS) sheet.deleteRows(MAX_BACKUPS + 2, sheet.getLastRow() - 1 - MAX_BACKUPS);
}

// withData adds each backup's snapshot to the newest `limit` rows, so the bookmark can describe them.
function listBackups(limit, withData) {
  const sheet = backupSheet();
  if (sheet.getLastRow() < 2) return [];
  const count = sheet.getLastRow() - 1;
  const rows = sheet.getRange(2, 1, count, 4).getValues()
    .map((row) => ({ id: String(row[3]), at: new Date(row[0]).getTime(), reason: row[1], sizeKb: row[2] }));
  if (withData && limit > 0) {
    const n = Math.min(limit, count);
    sheet.getRange(2, 1, n, sheet.getLastColumn()).getValues().forEach((row, i) => {
      rows[i].snapshot = fromCells(row.slice(4));
    });
  }
  return rows;
}

function getBackup(id) {
  const sheet = backupSheet();
  if (sheet.getLastRow() < 2) return null;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  const row = rows.find((r) => String(r[3]) === String(id));
  return row ? fromCells(row.slice(4)) : null;
}

// --- Web app ---------------------------------------------------------------------

function getSyncKey() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('SYNC_KEY');
  if (!key) {
    key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty('SYNC_KEY', key);
  }
  return key;
}

function handle(request) {
  switch (request.action) {
    case 'get': {
      const current = readCurrent();
      return { current, sheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl() };
    }
    case 'save': {
      const current = readCurrent();
      // Someone else saved since this page last synced: keep both copies and let the teacher choose.
      if (current && current.rev !== request.baseRev && !request.force) {
        if (current.snapshot !== request.snapshot) {
          addBackup(current.snapshot, 'conflict-remote');
          addBackup(request.snapshot, 'conflict');
          return { conflict: true, current };
        }
        return { rev: current.rev };
      }
      if (current && current.snapshot === request.snapshot) return { rev: current.rev };
      if (current) addBackup(current.snapshot, request.backupReason || 'routine');
      return { rev: writeCurrent(request.snapshot) };
    }
    case 'backup':
      addBackup(request.snapshot, request.reason);
      return { ok: true };
    case 'list':
      return { backups: listBackups(Number(request.limit) || 0, !!request.withData) };
    case 'getBackup':
      return { snapshot: getBackup(request.id) };
    default:
      return { error: 'unknown-action' };
  }
}

// The bookmark posts JSON as text/plain, which browsers send cross-origin without a preflight.
function doPost(e) {
  let result;
  try {
    const request = JSON.parse(e.postData.contents);
    if (request.key !== getSyncKey()) {
      result = { error: 'bad-key' };
    } else {
      const lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try {
        result = handle(request);
      } finally {
        lock.releaseLock();
      }
    }
  } catch (err) {
    result = { error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

// --- Setup menu ------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Shy Safari 同步').addItem('取得書籤', 'showBookmarkDialog').addToUi();
  currentSheet();
  backupSheet();
}

// The URL field starts empty on purpose: ScriptApp.getService().getUrl() can return a
// URL that answers 404 to the bookmark, so the teacher pastes the one the deploy dialog showed.
function showBookmarkDialog() {
  const data = JSON.stringify({ key: getSyncKey(), loader: LOADER_URL }).replace(/</g, '\\u003c');
  const html = `
<style>
  body { font: 14px/1.6 system-ui, "Microsoft JhengHei", sans-serif; color: #222; margin: 0; }
  label { display: block; margin: 0 0 4px; font-weight: 600; }
  input { width: 100%; box-sizing: border-box; padding: 6px 8px; font: inherit; }
  .step { margin: 0 0 14px; }
  #bookmark { display: inline-block; padding: 10px 18px; border-radius: 10px; background: #2f6fd6; color: #fff; font-weight: 600; text-decoration: none; cursor: grab; }
  #bookmark.disabled { background: #9aa4b5; pointer-events: none; }
  .note { color: #666; font-size: 13px; }
  button { font: inherit; padding: 4px 12px; }
</style>
<div class="step">
  <label for="url">1. 貼上部署時複製的「網頁應用程式」網址（結尾是 /exec）</label>
  <input id="url" placeholder="https://script.google.com/macros/s/.../exec">
</div>
<div class="step">
  <label>2. 把下面的按鈕拖到 Chrome 的書籤列</label>
  <a id="bookmark" class="disabled" href="#">☁ 同步 Shy Safari</a>
  <p class="note">看不到書籤列的話，按 Ctrl + Shift + B 打開。書籤會跟著你的 Chrome 帳號同步到其他電腦。</p>
</div>
<div class="step">
  <label>拖不過去的話</label>
  <button id="copy">複製書籤網址</button> <span id="status" class="note"></span>
  <p class="note">先隨便把一個網頁加入書籤，再編輯它，把網址換成複製的內容。</p>
</div>
<p class="note">這個書籤含有你的同步碼，不要分享給別人。</p>
<script>
  const data = ${data};
  const input = document.getElementById('url');
  const link = document.getElementById('bookmark');
  function update() {
    const url = input.value.trim();
    const ok = /^https:\\/\\/script\\.google\\.com\\/.+\\/exec$/.test(url);
    link.classList.toggle('disabled', !ok);
    const config = JSON.stringify({ url: url, key: data.key });
    link.href = ok ? 'javascript:' + encodeURIComponent('(function(){window.SHYSAFARI_SYNC=' + config +
      ';var s=document.createElement("script");s.src="' + data.loader + '";document.documentElement.appendChild(s)})()') : '#';
  }
  input.addEventListener('input', update);
  document.getElementById('copy').addEventListener('click', () => {
    if (link.classList.contains('disabled')) { document.getElementById('status').textContent = '請先貼上網址'; return; }
    navigator.clipboard.writeText(link.href).then(
      () => { document.getElementById('status').textContent = '已複製'; },
      () => { document.getElementById('status').textContent = '無法複製，請改用拖曳'; });
  });
  update();
</script>`;
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(520).setHeight(420), 'Shy Safari 同步書籤');
}
