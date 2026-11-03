// Mirrors Shy Safari's localStorage into chrome.storage.sync, so every Chrome signed in
// to the same Google account shares one copy of the settings and records.
// Relies on backup-store.js, which the manifest loads first.

// Checking is cheap and uploads only happen when something changed, so a short interval
// limits what a crash or power cut can lose while staying far under Chrome's write limits.
const CHECK_INTERVAL_MS = 30 * 1000;
// On a computer that has never synced, Chrome may still be downloading the account's data.
// Hold off the first upload so this computer's defaults don't overwrite the real records.
const FIRST_SYNC_GRACE_MS = 60 * 1000;
// An incomplete cloud copy for this long means sync is stuck rather than still arriving.
const INCOMPLETE_WARNING_MS = 10 * 60 * 1000;
// chrome.storage.sync allows 8 KB per item; 1500 characters stays under that even for CJK text.
const CHUNK_SIZE = 1500;
const META_KEY = 'meta';
const CHUNK_PREFIX = 'chunk:';
const CONFLICT_BANNER_ID = 'shysafari-sync-conflict';

const startedAt = Date.now();
let queue = Promise.resolve();

function takeSnapshot() {
  const data = {};
  Object.keys(localStorage).sort().forEach((key) => {
    data[key] = localStorage.getItem(key);
  });
  return JSON.stringify(data);
}

function applySnapshot(snapshot) {
  const data = JSON.parse(snapshot);
  localStorage.clear();
  Object.keys(data).forEach((key) => localStorage.setItem(key, data[key]));
}

function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function chunkKeys(from, to) {
  const keys = [];
  for (let i = from; i < to; i++) keys.push(CHUNK_PREFIX + i);
  return keys;
}

// Chunks can arrive from Chrome sync one by one, so a copy that doesn't match its
// length and hash is treated as still in transit rather than as real data.
async function readRemote() {
  const { [META_KEY]: meta } = await chrome.storage.sync.get(META_KEY);
  if (!meta) return { status: 'none', chunks: 0 };
  const keys = chunkKeys(0, meta.chunks);
  const parts = await chrome.storage.sync.get(keys);
  const snapshot = keys.map((key) => parts[key] ?? '').join('');
  if (snapshot.length !== meta.length || hash(snapshot) !== meta.hash) return { status: 'invalid', chunks: meta.chunks };
  return { status: 'ok', snapshot, rev: meta.rev, chunks: meta.chunks };
}

async function writeRemote(snapshot, oldChunks) {
  const items = {};
  let count = 0;
  for (let i = 0; i < snapshot.length; i += CHUNK_SIZE) {
    items[CHUNK_PREFIX + count++] = snapshot.slice(i, i + CHUNK_SIZE);
  }
  const rev = crypto.randomUUID();
  items[META_KEY] = { rev, chunks: count, length: snapshot.length, hash: hash(snapshot), updatedAt: Date.now() };
  await chrome.storage.sync.set(items);
  if (oldChunks > count) await chrome.storage.sync.remove(chunkKeys(count, oldChunks));
  return rev;
}

async function upload(snapshot, remote) {
  if (remote.status === 'ok') await addBackup(remote.snapshot, 'routine');
  await markSynced(snapshot, await writeRemote(snapshot, remote.chunks));
}

async function markSynced(snapshot, rev) {
  await chrome.storage.local.set({ lastSnapshot: snapshot, lastRev: rev, lastSyncedAt: Date.now() });
}

function setStatus(fields) {
  return chrome.storage.local.set({ lastCheckedAt: Date.now(), ...fields });
}

async function save(force = false) {
  const remote = await readRemote();
  const state = await chrome.storage.local.get(['lastSnapshot', 'lastRev', 'incompleteSince']);
  if (remote.status === 'invalid') {
    const since = state.incompleteSince || Date.now();
    await setStatus({ incompleteSince: since, error: Date.now() - since > INCOMPLETE_WARNING_MS ? 'incomplete' : null });
    return;
  }
  const snapshot = takeSnapshot();
  if (remote.status === 'ok' && remote.rev !== state.lastRev) {
    // Another computer saved since this one last synced. Unchanged pages pick that up on the next
    // load; a page with its own new changes asks which copy to keep instead of dropping either.
    if (snapshot !== state.lastSnapshot) await showConflict(snapshot, remote.snapshot);
  } else if (remote.status === 'none' && !state.lastRev && !force && Date.now() - startedAt < FIRST_SYNC_GRACE_MS) {
    return;
  } else if (remote.status === 'none' || snapshot !== state.lastSnapshot) {
    await upload(snapshot, remote);
  }
  await setStatus({ incompleteSince: null, error: null, errorMessage: null });
}

function enqueue(task) {
  queue = queue.then(task).catch((err) => {
    const message = String((err && err.message) || err);
    console.warn('[Shy Safari 自動同步]', message);
    return setStatus({ error: /quota/i.test(message) ? 'quota' : 'failed', errorMessage: message });
  });
  return queue;
}

async function showConflict(localSnapshot, remoteSnapshot) {
  if (document.getElementById(CONFLICT_BANNER_ID)) return;
  await addBackup(remoteSnapshot, 'conflict-remote');
  await addBackup(localSnapshot, 'conflict');
  const host = document.createElement('div');
  host.id = CONFLICT_BANNER_ID;
  // A shadow root keeps Shy Safari's styles and ours from affecting each other.
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      .bar { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); z-index: 2147483647;
        width: min(560px, calc(100vw - 32px)); box-sizing: border-box; padding: 14px 16px; border-radius: 12px;
        background: #fff8e1; color: #3d2c00; box-shadow: 0 6px 24px rgba(0,0,0,.25);
        font: 15px/1.6 system-ui, "Microsoft JhengHei", sans-serif; }
      p { margin: 0 0 10px; }
      .actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
      button { font: inherit; padding: 6px 14px; border-radius: 8px; border: 1px solid #c9a227; background: #fff; color: inherit; cursor: pointer; }
      button.primary { background: #2f6fd6; border-color: #2f6fd6; color: #fff; }
    </style>
    <div class="bar" role="alert">
      <p><b>另一台電腦剛更新了 Shy Safari 的紀錄。</b><br>這台電腦也有新的變動，兩份都已另存備份。要用哪一份？</p>
      <div class="actions">
        <button data-use="remote">改用另一台的</button>
        <button data-use="local" class="primary">保留這台的</button>
      </div>
    </div>`;
  root.addEventListener('click', (event) => {
    const use = event.target.dataset && event.target.dataset.use;
    if (!use) return;
    host.remove();
    enqueue(() => resolveConflict(use));
  });
  (document.body || document.documentElement).appendChild(host);
}

async function resolveConflict(use) {
  const remote = await readRemote();
  if (remote.status !== 'ok') return;
  if (use === 'local') {
    await upload(takeSnapshot(), remote);
    return;
  }
  applySnapshot(remote.snapshot);
  await markSynced(remote.snapshot, remote.rev);
  location.reload();
}

// The backups page can't reach this page's localStorage, so it leaves the chosen copy in
// chrome.storage.local and this script applies it, either now or the next time Shy Safari opens.
async function applyPendingRestore() {
  const { pendingRestore } = await chrome.storage.local.get('pendingRestore');
  if (!pendingRestore) return false;
  await chrome.storage.local.remove('pendingRestore');
  await addBackup(takeSnapshot(), 'before-restore');
  applySnapshot(pendingRestore);
  await upload(pendingRestore, await readRemote());
  location.reload();
  return true;
}

async function start() {
  if (await applyPendingRestore()) return;
  const remote = await readRemote();
  const { lastRev } = await chrome.storage.local.get('lastRev');
  if (remote.status === 'ok' && remote.rev !== lastRev) {
    const local = takeSnapshot();
    const changed = remote.snapshot !== local;
    if (changed) {
      await addBackup(local, 'before-load');
      applySnapshot(remote.snapshot);
    }
    await markSynced(remote.snapshot, remote.rev);
    // The page has already read the old values, so reload it with the synced ones.
    if (changed) {
      location.reload();
      return;
    }
  }
  enqueue(() => save());
  setInterval(() => enqueue(() => save()), CHECK_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') enqueue(() => save());
  });
  window.addEventListener('pagehide', () => enqueue(() => save()));
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.pendingRestore && changes.pendingRestore.newValue) enqueue(applyPendingRestore);
    if (changes.syncRequest) enqueue(() => save(true));
  });
}

enqueue(start);
