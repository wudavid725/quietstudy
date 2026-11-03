// Shared by the content script and the backups page. Backups live in chrome.storage.local,
// which stays on this computer, so a bad copy that syncs everywhere can still be undone.

const MAX_BACKUPS = 50;
// Routine copies are spaced out so 50 of them reach back weeks rather than minutes.
const ROUTINE_BACKUP_GAP_MS = 20 * 60 * 1000;

const BACKUP_REASONS = {
  routine: '定期備份',
  'before-load': '載入另一台電腦的紀錄前',
  conflict: '兩台同時使用時，這台的紀錄',
  'conflict-remote': '兩台同時使用時，另一台的紀錄',
  'before-restore': '還原前的紀錄',
};

async function addBackup(snapshot, reason) {
  if (!snapshot || snapshot === '{}') return;
  const { backups = [] } = await chrome.storage.local.get('backups');
  const latest = backups[0];
  if (latest && latest.snapshot === snapshot) return;
  const latestRoutine = backups.find((b) => b.reason === 'routine');
  if (reason === 'routine' && latestRoutine && Date.now() - latestRoutine.at < ROUTINE_BACKUP_GAP_MS) return;
  backups.unshift({ at: Date.now(), reason, snapshot });
  await chrome.storage.local.set({ backups: backups.slice(0, MAX_BACKUPS) });
}
