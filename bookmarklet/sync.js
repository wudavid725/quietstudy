// Shy Safari 同步 — loaded by the bookmark inside www.shysafari.com.
// Keeps the page's localStorage in step with the teacher's Google Sheet (see Code.gs):
// loads the sheet's copy, then saves changes every 30 seconds while the page is open.
(function () {
  'use strict';

  const SAVE_INTERVAL_MS = 30 * 1000;
  // sessionStorage: the {rev, snapshot} this tab last agreed on with the sheet. It survives
  // reloads of the tab, so a reload can tell "I changed" apart from "the sheet changed".
  const BASE_KEY = 'shysafari-sync:base';
  const BACKUP_LIST_LIMIT = 30;

  const ERROR_MESSAGES = {
    'bad-key': '同步碼不對。請到試算表的「Shy Safari 同步 → 取得書籤」重新建立書籤。',
    'not-json': '試算表沒有正確回應。請確認部署時「誰可以存取」選的是「所有人」，而且網址結尾是 /exec。',
    network: '連不上試算表，網路恢復後會自動重試。',
  };

  const config = window.SHYSAFARI_SYNC || {};
  // `host` only exists so the script can be tested on a local page.
  const host = config.host || 'shysafari.com';
  if (!new RegExp('(^|\\.)' + host.replace(/\./g, '\\.') + '$').test(location.hostname)) {
    alert('請先打開 www.shysafari.com，再按這個書籤。');
    return;
  }
  if (window.__shysafariSync) {
    window.__shysafariSync.togglePanel();
    return;
  }
  if (!config.url || !config.key) {
    alert('這個書籤缺少試算表網址或同步碼，請到試算表重新建立書籤。');
    return;
  }

  // Kept before silenceOuterPage() replaces them, so this script can still write.
  const realSetItem = Storage.prototype.setItem;
  const realClear = Storage.prototype.clear;

  let base = readBase();
  let queue = Promise.resolve();
  let started = false;
  let conflictOpen = false;
  let frame = null;
  let sheetUrl = '';
  let lastSavedAt = 0;
  let status = { state: 'busy', text: '正在載入雲端紀錄…' };

  // --- Local data ----------------------------------------------------------------

  function takeSnapshot() {
    const data = {};
    Object.keys(localStorage).sort().forEach((key) => {
      data[key] = localStorage.getItem(key);
    });
    return JSON.stringify(data);
  }

  function applySnapshot(snapshot) {
    const data = JSON.parse(snapshot);
    realClear.call(localStorage);
    Object.keys(data).forEach((key) => realSetItem.call(localStorage, key, data[key]));
  }

  function readBase() {
    try {
      return JSON.parse(sessionStorage.getItem(BASE_KEY)) || {};
    } catch (err) {
      return {};
    }
  }

  function writeBase(rev, snapshot) {
    base = { rev, snapshot };
    try {
      realSetItem.call(sessionStorage, BASE_KEY, JSON.stringify(base));
    } catch (err) {
      // Private windows may refuse; the in-memory copy still covers this page.
    }
  }

  // Shy Safari has already read the old data, and a reload would end this script. Instead the
  // page reopens itself in a full-screen frame; this outer page keeps syncing, and its now
  // hidden copy of Shy Safari is stopped from writing stale data over the loaded records.
  function showInFrame() {
    if (frame) {
      frame.contentWindow.location.reload();
      return;
    }
    Storage.prototype.setItem = function () {};
    Storage.prototype.removeItem = function () {};
    Storage.prototype.clear = function () {};
    frame = document.createElement('iframe');
    frame.src = location.href;
    frame.allow = 'microphone; camera; fullscreen; autoplay';
    frame.setAttribute('allowfullscreen', '');
    frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483646;background:#fff';
    document.documentElement.appendChild(frame);
    if (document.body) document.body.style.visibility = 'hidden';
  }

  // --- Sheet API -----------------------------------------------------------------

  class SyncError extends Error {}

  // A plain string body goes out as text/plain, which needs no CORS preflight.
  async function call(action, payload) {
    let response;
    try {
      response = await fetch(config.url, {
        method: 'POST',
        body: JSON.stringify(Object.assign({ action, key: config.key }, payload)),
      });
    } catch (err) {
      throw new SyncError('network');
    }
    let data;
    try {
      data = JSON.parse(await response.text());
    } catch (err) {
      throw new SyncError('not-json');
    }
    if (data.error) throw new SyncError(data.error);
    return data;
  }

  // --- Sync ----------------------------------------------------------------------

  function enqueue(task) {
    queue = queue.then(task).catch((err) => {
      const code = err instanceof SyncError ? err.message : String((err && err.message) || err);
      setStatus('error', ERROR_MESSAGES[code] || '同步失敗：' + code);
    });
    return queue;
  }

  async function start() {
    setStatus('busy', '正在載入雲端紀錄…');
    const result = await call('get');
    sheetUrl = result.sheetUrl || '';
    const current = result.current;
    const local = takeSnapshot();
    started = true;
    if (!current) {
      await upload(local, null);
    } else if (current.snapshot === local) {
      writeBase(current.rev, local);
    } else if (base.rev === current.rev) {
      // Only this tab changed since it last synced, e.g. it was reloaded before saving.
      await upload(local, current.rev);
    } else {
      await call('backup', { snapshot: local, reason: 'before-load' });
      applySnapshot(current.snapshot);
      writeBase(current.rev, current.snapshot);
      showInFrame();
    }
    lastSavedAt = Date.now();
    setStatus('ok');
  }

  // Until the first load succeeds (offline, wrong settings), each tick retries it.
  function tick() {
    if (conflictOpen) return queue;
    // Decided when the task runs, so a tick queued behind a slow first load doesn't load twice.
    return enqueue(() => (started ? save() : start()));
  }

  async function upload(snapshot, baseRev, extra) {
    setStatus('busy', '儲存中…');
    const result = await call('save', Object.assign({ snapshot, baseRev }, extra));
    if (result.conflict) {
      showConflict(result.current);
      return;
    }
    writeBase(result.rev, snapshot);
    lastSavedAt = Date.now();
    setStatus('ok');
  }

  async function save() {
    if (!started || conflictOpen) return;
    const snapshot = takeSnapshot();
    if (snapshot === base.snapshot) {
      setStatus('ok');
      return;
    }
    await upload(snapshot, base.rev);
  }

  // The page is going away, so there is no time to wait for an answer.
  function saveOnExit() {
    if (!started || conflictOpen) return;
    const snapshot = takeSnapshot();
    if (snapshot === base.snapshot) return;
    fetch(config.url, {
      method: 'POST',
      keepalive: true,
      body: JSON.stringify({ action: 'save', key: config.key, snapshot, baseRev: base.rev }),
    }).catch(() => {});
  }

  async function restore(id) {
    await save();
    const { snapshot } = await call('getBackup', { id });
    if (!snapshot) throw new SyncError('找不到這份備份');
    const result = await call('save', { snapshot, force: true, backupReason: 'before-restore' });
    applySnapshot(snapshot);
    writeBase(result.rev, snapshot);
    showInFrame();
    lastSavedAt = Date.now();
    setStatus('ok', '已還原');
  }

  // --- UI ------------------------------------------------------------------------

  const ui = document.createElement('div');
  ui.id = 'shysafari-sync-ui';
  const root = ui.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font: 14px/1.6 system-ui, "Microsoft JhengHei", sans-serif; }
      .pill { position: fixed; right: 12px; bottom: 12px; z-index: 2147483647; display: flex; align-items: center; gap: 6px;
        padding: 4px 12px; border: 0; border-radius: 999px; background: rgba(255,255,255,.88); color: #333;
        box-shadow: 0 2px 8px rgba(0,0,0,.2); cursor: pointer; font-size: 13px; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #9aa4b5; flex: none; }
      .ok .dot { background: #1e9e55; }
      .error .dot { background: #d93025; }
      .error { background: #fde7e7; color: #8c1d18; }
      .panel { position: fixed; right: 12px; bottom: 52px; z-index: 2147483647; width: min(380px, calc(100vw - 24px));
        max-height: calc(100vh - 80px); overflow: auto; padding: 14px 16px; border-radius: 12px; background: #fff; color: #222;
        box-shadow: 0 6px 24px rgba(0,0,0,.25); }
      .panel[hidden], .banner[hidden] { display: none; }
      h2 { margin: 0 0 6px; font-size: 16px; font-weight: 700; }
      p { margin: 0 0 10px; }
      .muted { color: #666; font-size: 13px; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 10px; }
      button.btn, a.btn { padding: 5px 12px; border-radius: 8px; border: 1px solid #c8ccd6; background: #fff; color: #222;
        cursor: pointer; text-decoration: none; font-size: 13px; }
      .btn.primary { background: #2f6fd6; border-color: #2f6fd6; color: #fff; }
      table { width: 100%; border-collapse: collapse; }
      td { padding: 6px 4px; border-top: 1px solid #e3e6ee; font-size: 13px; vertical-align: middle; }
      td:last-child { text-align: right; white-space: nowrap; }
      .banner { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); z-index: 2147483647;
        width: min(560px, calc(100vw - 32px)); padding: 14px 16px; border-radius: 12px; background: #fff8e1; color: #3d2c00;
        box-shadow: 0 6px 24px rgba(0,0,0,.25); }
      .banner .actions { justify-content: flex-end; margin: 0; }
    </style>
    <button class="pill" part="pill"><span class="dot"></span><span class="label"></span></button>
    <div class="panel" hidden>
      <h2>Shy Safari 同步</h2>
      <p class="message"></p>
      <div class="actions">
        <button class="btn primary" data-action="sync">立即同步</button>
        <button class="btn" data-action="backups">備份與還原</button>
        <a class="btn sheet" target="_blank" rel="noopener" hidden>開啟試算表</a>
      </div>
      <div class="backups"></div>
      <p class="muted">網頁開著時每 30 秒自動保存。關掉分頁前也會再存一次。</p>
    </div>
    <div class="banner" role="alert" hidden>
      <p><b>另一台電腦剛更新了 Shy Safari 的紀錄。</b><br>這台電腦也有新的變動，兩份都已存進試算表的備份。要用哪一份？</p>
      <div class="actions">
        <button class="btn" data-action="use-remote">改用另一台的</button>
        <button class="btn primary" data-action="use-local">保留這台的</button>
      </div>
    </div>`;
  document.documentElement.appendChild(ui);

  const pill = root.querySelector('.pill');
  const panel = root.querySelector('.panel');
  const banner = root.querySelector('.banner');
  let pendingConflict = null;

  function formatTime(ms) {
    return new Date(ms).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function setStatus(state, text) {
    status = { state, text: text || '' };
    pill.className = 'pill ' + state;
    const savedText = lastSavedAt ? '已同步 ' + new Date(lastSavedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) : '已同步';
    pill.querySelector('.label').textContent = state === 'ok' ? savedText : state === 'error' ? '同步有問題' : text || '同步中…';
    root.querySelector('.message').textContent =
      state === 'error' ? text : state === 'ok' ? (text ? text + '。' : '') + '最後同步：' + (lastSavedAt ? formatTime(lastSavedAt) : '—') : text || '同步中…';
    const sheet = root.querySelector('.sheet');
    sheet.hidden = !sheetUrl;
    sheet.href = sheetUrl || '#';
  }

  function togglePanel() {
    panel.hidden = !panel.hidden;
  }

  function showConflict(current) {
    conflictOpen = true;
    pendingConflict = current;
    banner.hidden = false;
    setStatus('busy', '等你選擇要用哪一份紀錄');
  }

  async function showBackups() {
    const box = root.querySelector('.backups');
    box.textContent = '讀取中…';
    const { backups } = await call('list');
    box.replaceChildren();
    if (!backups.length) {
      box.textContent = '還沒有備份。';
      return;
    }
    const table = document.createElement('table');
    backups.slice(0, BACKUP_LIST_LIMIT).forEach((backup) => {
      const row = table.insertRow();
      row.insertCell().textContent = formatTime(backup.at);
      row.insertCell().textContent = backup.reason;
      const button = document.createElement('button');
      button.className = 'btn';
      button.textContent = '還原';
      button.addEventListener('click', () => {
        if (!confirm('要把 Shy Safari 還原成 ' + formatTime(backup.at) + ' 的備份嗎？\n\n目前的紀錄會先存成備份，所有電腦都會改用還原後的版本。')) return;
        panel.hidden = true;
        setStatus('busy', '還原中…');
        enqueue(() => restore(backup.id));
      });
      row.insertCell().append(button);
    });
    box.append(table);
    const more = document.createElement('p');
    more.className = 'muted';
    more.textContent = '這裡列出最近 ' + Math.min(backups.length, BACKUP_LIST_LIMIT) + ' 份，全部備份在試算表的「備份」分頁。';
    box.append(more);
  }

  pill.addEventListener('click', togglePanel);
  root.addEventListener('click', (event) => {
    const action = event.target.dataset && event.target.dataset.action;
    if (action === 'sync') tick();
    if (action === 'backups') enqueue(showBackups);
    if (action === 'use-local' || action === 'use-remote') {
      banner.hidden = true;
      conflictOpen = false;
      const current = pendingConflict;
      if (action === 'use-local') {
        enqueue(() => upload(takeSnapshot(), current.rev, { force: true }));
      } else {
        applySnapshot(current.snapshot);
        writeBase(current.rev, current.snapshot);
        showInFrame();
        lastSavedAt = Date.now();
        setStatus('ok');
      }
    }
  });

  window.__shysafariSync = { togglePanel };
  setStatus(status.state, status.text);
  setInterval(tick, SAVE_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') tick();
  });
  window.addEventListener('pagehide', saveOnExit);
  tick();
})();
