// Mirrors Shy Safari's localStorage into chrome.storage.sync, so every Chrome signed in
// to the same Google account shares one copy of the settings and records.

const SAVE_INTERVAL_MS = 5 * 60 * 1000;
// On a computer that has never synced, Chrome may still be downloading the account's data.
// Hold off the first upload so this computer's defaults don't overwrite the real records.
const FIRST_SYNC_GRACE_MS = 60 * 1000;
// chrome.storage.sync allows 8 KB per item; 1500 characters stays under that even for CJK text.
const CHUNK_SIZE = 1500;
const META_KEY = 'meta';
const CHUNK_PREFIX = 'chunk:';

const startedAt = Date.now();
let saving = Promise.resolve();

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
  if (!meta) return { status: 'none' };
  const keys = chunkKeys(0, meta.chunks);
  const parts = await chrome.storage.sync.get(keys);
  const snapshot = keys.map((key) => parts[key] ?? '').join('');
  if (snapshot.length !== meta.length || hash(snapshot) !== meta.hash) return { status: 'invalid' };
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

async function save() {
  const remote = await readRemote();
  if (remote.status === 'invalid') return;
  const state = await chrome.storage.local.get(['lastSnapshot', 'lastRev']);
  // Another computer saved since this one last synced: keep its copy, this page picks it up on the next load.
  if (remote.status === 'ok' && remote.rev !== state.lastRev) return;
  if (remote.status === 'none' && !state.lastRev && Date.now() - startedAt < FIRST_SYNC_GRACE_MS) return;
  const snapshot = takeSnapshot();
  if (remote.status === 'ok' && snapshot === state.lastSnapshot) return;
  const rev = await writeRemote(snapshot, remote.chunks || 0);
  await chrome.storage.local.set({ lastSnapshot: snapshot, lastRev: rev, lastSyncedAt: Date.now() });
}

function queueSave() {
  saving = saving.then(save, save).catch((err) => console.warn('[Shy Safari 自動同步] 儲存失敗', err));
  return saving;
}

async function start() {
  const remote = await readRemote();
  const { lastRev } = await chrome.storage.local.get('lastRev');
  if (remote.status === 'ok' && remote.rev !== lastRev) {
    const changed = remote.snapshot !== takeSnapshot();
    if (changed) applySnapshot(remote.snapshot);
    await chrome.storage.local.set({ lastSnapshot: remote.snapshot, lastRev: remote.rev, lastSyncedAt: Date.now() });
    // The page has already read the old values, so reload it with the synced ones.
    if (changed) {
      location.reload();
      return;
    }
  }
  queueSave();
  setInterval(queueSave, SAVE_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') queueSave();
  });
  window.addEventListener('pagehide', queueSave);
}

start().catch((err) => console.warn('[Shy Safari 自動同步] 啟動失敗', err));
