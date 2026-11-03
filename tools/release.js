// Prepares a release of the extension for computers that load it from a synced folder.
//
//   node tools/release.js                     update release.json only
//   node tools/release.js "G:\我的雲端硬碟\shysafari-sync"   ...and copy the extension there
//
// release.json lists every file with its SHA-256 so installed copies only reload once
// the whole release has synced. If files changed but the version didn't, the patch
// number is bumped, since installed copies only notice a new version.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EXTENSION_DIR = path.join(__dirname, '..', 'extension');
const RELEASE_FILE = 'release.json';

function listFiles() {
  return fs.readdirSync(EXTENSION_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== RELEASE_FILE)
    .map((entry) => entry.name)
    .sort();
}

function hashFiles(files) {
  const hashes = {};
  files.forEach((name) => {
    hashes[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(EXTENSION_DIR, name))).digest('hex');
  });
  return hashes;
}

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

const manifestPath = path.join(EXTENSION_DIR, 'manifest.json');
const releasePath = path.join(EXTENSION_DIR, RELEASE_FILE);
const previous = readJson(releasePath);
const manifest = readJson(manifestPath);

const files = listFiles();
let hashes = hashFiles(files);
const changed = !previous || JSON.stringify(previous.files) !== JSON.stringify(hashes);

if (changed && previous && previous.version === manifest.version) {
  const parts = manifest.version.split('.').map(Number);
  parts[parts.length - 1] += 1;
  manifest.version = parts.join('.');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  hashes = hashFiles(files);
  console.log('檔案有變動，版本號自動改為 ' + manifest.version);
}

fs.writeFileSync(releasePath, JSON.stringify({ version: manifest.version, files: hashes }, null, 2) + '\n');
console.log((changed ? '已更新' : '沒有變動，保留') + ' release.json（版本 ' + manifest.version + '，' + files.length + ' 個檔案）');

const target = process.argv[2];
if (target) {
  fs.mkdirSync(target, { recursive: true });
  // release.json goes last so a computer syncing mid-copy never sees a release before its files.
  files.concat(RELEASE_FILE).forEach((name) => fs.copyFileSync(path.join(EXTENSION_DIR, name), path.join(target, name)));
  console.log('已複製到 ' + target);
}
