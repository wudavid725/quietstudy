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
  // After the first successful load the pill shrinks to a dot, so it doesn't distract a class.
  const COMPACT_DELAY_MS = 5 * 1000;

  // What Shy Safari stores, as read from its code (Nov 2026). Used to spot a site update that
  // changed the format, and to describe backups.
  const PREFIX = 'class-noise-level:';
  const CLASSES_KEY = PREFIX + 'classes';
  const SETTINGS_KEY = PREFIX + 'settings';
  const CLASS_KEY = /^class-noise-level:class:([^:]+):(.+)$/;
  const SCENES = ['savanna', 'reef', 'space', 'prehistoric', 'forest', 'jungle', 'arctic', 'halloween'];
  // Per-class values this script knows; names it doesn't know (new features) are left alone.
  const CLASS_VALUE_CHECKS = {
    arrived: (text) => /^\d+$/.test(text),
    sightings: (text) => isObject(parseJson(text)),
    notes: (text) => Array.isArray(parseJson(text)),
    timer: (text) => isObject(parseJson(text)),
  };
  const VALUE_LABELS = { arrived: '動物數', sightings: '看過的動物', notes: '便利貼', timer: '計時器' };
  const PAUSED_MESSAGE =
    'Shy Safari 的資料格式跟以前不一樣，可能是網站改版了。為了不弄壞雲端的紀錄，同步已暫停，雲端紀錄沒有被改動。' +
    '如果 Shy Safari 看起來一切正常，可以按「仍要同步」；也請通知維護書籤的人更新程式。';

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
  // jsDelivr lets browsers keep this file for a week, so the copy the bookmark just loaded may be
  // old. Ask for the current one (revalidating the cached copy too) and run that instead; if that
  // fails, run the cached copy.
  const self = document.currentScript && document.currentScript.src;
  if (self && !config.fresh) {
    config.fresh = true;
    // Holds the place so a second click meanwhile doesn't start another copy.
    window.__shysafariSync = { togglePanel() {} };
    const run = (code) => {
      delete window.__shysafariSync;
      const script = document.createElement('script');
      if (code) script.textContent = code;
      else script.src = self;
      document.documentElement.appendChild(script);
    };
    fetch(self, { cache: 'no-cache' })
      .then((response) => (response.ok ? response.text() : Promise.reject()))
      .then(run, () => run());
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
  let paused = false;
  let formatOverride = false;
  let compact = false;
  let compactTimer = null;

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

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (err) {
      return undefined;
    }
  }

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function isAnimalList(text) {
    const list = parseJson(text);
    return Array.isArray(list) && list.every((animal) => isObject(animal) && typeof animal.slug === 'string');
  }

  function readClasses(data) {
    const value = parseJson(data[CLASSES_KEY]);
    if (!isObject(value) || !Array.isArray(value.classes)) return null;
    const classes = value.classes.filter((c) => isObject(c) && typeof c.id === 'string' && c.id && typeof c.name === 'string');
    return classes.length ? classes : null;
  }

  function className(c, index) {
    return c.name || '未命名班級 ' + (index + 1);
  }

  // Empty means the snapshot looks like the Shy Safari this script was written for.
  function formatProblems(snapshot) {
    const data = parseJson(snapshot);
    if (!isObject(data)) return ['資料無法讀取'];
    const keys = Object.keys(data);
    if (!keys.length) return [];
    const problems = [];
    if (!readClasses(data)) problems.push('找不到班級名單');
    if (SETTINGS_KEY in data && !isObject(parseJson(data[SETTINGS_KEY]))) problems.push('設定');
    keys.forEach((key) => {
      const match = key.match(CLASS_KEY);
      if (!match) return;
      const check = SCENES.includes(match[2]) ? isAnimalList : CLASS_VALUE_CHECKS[match[2]];
      if (check && !check(data[key])) problems.push(VALUE_LABELS[match[2]] || '場景裡的動物');
    });
    return problems.filter((p, i) => problems.indexOf(p) === i);
  }

  // "A 班：12 隻、B 班：3 隻": the animals in each class's scenes.
  function summarize(snapshot) {
    const data = parseJson(snapshot);
    const classes = isObject(data) && readClasses(data);
    if (!classes) return '';
    return classes.map((c, index) => {
      let animals = 0;
      Object.keys(data).forEach((key) => {
        const match = key.match(CLASS_KEY);
        if (match && match[1] === c.id && SCENES.includes(match[2]) && isAnimalList(data[key])) animals += JSON.parse(data[key]).length;
      });
      return className(c, index) + '：' + animals + ' 隻';
    }).join('、');
  }

  // Stops syncing before data in an unknown format reaches the sheet or this page.
  async function checkFormat(local, remote) {
    if (formatOverride) return true;
    const localProblems = formatProblems(local);
    const problems = localProblems.concat(remote ? formatProblems(remote) : []);
    if (!problems.length) return true;
    paused = true;
    if (localProblems.length) await call('backup', { snapshot: local, reason: '網站格式改變時，這台電腦的紀錄' }).catch(() => {});
    setStatus('paused', PAUSED_MESSAGE + '（看不懂的部分：' + problems.join('、') + '）');
    panel.hidden = false;
    return false;
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
    if (!(await checkFormat(local, current && current.snapshot))) return;
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
    if (conflictOpen || paused) return queue;
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
    if (!started || conflictOpen || paused) return;
    const snapshot = takeSnapshot();
    if (snapshot === base.snapshot) {
      setStatus('ok');
      return;
    }
    if (!(await checkFormat(snapshot))) return;
    await upload(snapshot, base.rev);
  }

  // The page is going away, so there is no time to wait for an answer.
  function saveOnExit() {
    if (!started || conflictOpen || paused) return;
    const snapshot = takeSnapshot();
    if (snapshot === base.snapshot || (!formatOverride && formatProblems(snapshot).length)) return;
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
      .paused .dot { background: #e8a200; }
      .paused { background: #fff3cd; color: #5c4200; }
      .pill.compact { width: 18px; height: 18px; padding: 0; justify-content: center; opacity: .5; }
      .pill.compact .label { display: none; }
      .pill.compact:hover { width: auto; height: auto; padding: 4px 12px; opacity: 1; }
      .pill.compact:hover .label { display: inline; }
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
      td .summary { display: block; color: #666; font-size: 12px; }
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
        <button class="btn primary" data-action="resume" hidden>仍要同步</button>
        <button class="btn primary" data-action="sync">立即同步</button>
        <button class="btn" data-action="backups">備份與還原</button>
        <a class="btn sheet" target="_blank" rel="noopener" hidden>開啟試算表</a>
      </div>
      <div class="backups"></div>
      <p class="muted">網頁開著時每 30 秒自動保存。關掉分頁前也會再存一次。</p>
      <p class="muted">上課時右下角只留一個小圓點，滑鼠移過去會顯示同步時間；有問題時會自動展開。</p>
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
  let backupsGeneration = 0;

  function formatTime(ms) {
    return new Date(ms).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function setStatus(state, text) {
    status = { state, text: text || '' };
    if (state === 'ok' && !compactTimer) {
      compactTimer = setTimeout(() => {
        compact = true;
        setStatus(status.state, status.text);
      }, COMPACT_DELAY_MS);
    }
    const needsAttention = state === 'error' || state === 'paused' || conflictOpen;
    pill.className = 'pill ' + state + (compact && !needsAttention ? ' compact' : '');
    const savedText = lastSavedAt ? '已同步 ' + new Date(lastSavedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) : '已同步';
    pill.querySelector('.label').textContent =
      state === 'ok' ? savedText : state === 'error' ? '同步有問題' : state === 'paused' ? '已暫停同步' : text || '同步中…';
    root.querySelector('.message').textContent =
      state === 'error' || state === 'paused' ? text : state === 'ok' ? (text ? text + '。' : '') + '最後同步：' + (lastSavedAt ? formatTime(lastSavedAt) : '—') : text || '同步中…';
    root.querySelector('[data-action="resume"]').hidden = state !== 'paused';
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
    const generation = ++backupsGeneration;
    box.textContent = '讀取中…';
    const { backups } = await call('list', { limit: BACKUP_LIST_LIMIT, withData: true });
    box.replaceChildren();
    const now = summarize(takeSnapshot());
    if (now) {
      const current = document.createElement('p');
      current.className = 'muted';
      current.textContent = '現在：' + now;
      box.append(current);
    }
    if (!backups.length) {
      box.append('還沒有備份。');
      return;
    }
    const table = document.createElement('table');
    const missing = [];
    backups.slice(0, BACKUP_LIST_LIMIT).forEach((backup) => {
      const row = table.insertRow();
      row.insertCell().textContent = formatTime(backup.at);
      const reasonCell = row.insertCell();
      reasonCell.textContent = backup.reason;
      const summary = document.createElement('span');
      summary.className = 'summary';
      reasonCell.append(summary);
      if (typeof backup.snapshot === 'string') summary.textContent = summarize(backup.snapshot);
      else missing.push({ id: backup.id, summary });
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
    loadSummaries(missing, generation);
  }

  // An older Code.gs lists backups without their data, so fetch them one by one, outside the
  // save queue so routine saves aren't held up.
  async function loadSummaries(rows, generation) {
    rows.forEach((row) => { row.summary.textContent = '…'; });
    for (const row of rows) {
      if (generation !== backupsGeneration || panel.hidden) return;
      try {
        const { snapshot } = await call('getBackup', { id: row.id });
        row.summary.textContent = snapshot ? summarize(snapshot) : '';
      } catch (err) {
        row.summary.textContent = '';
      }
    }
  }

  pill.addEventListener('click', togglePanel);
  root.addEventListener('click', (event) => {
    const action = event.target.dataset && event.target.dataset.action;
    if (action === 'sync') tick();
    if (action === 'resume') {
      formatOverride = true;
      paused = false;
      tick();
    }
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
