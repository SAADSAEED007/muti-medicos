// Run only while PharmaSpot is closed. Backups contain private pharmacy data.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { DatabaseSync, backup } = require('node:sqlite');

const appData = process.env.PHARMASPOT_DATA_DIR || path.join(process.env.APPDATA || '', 'PharmaSpot');
const relativeDatabase = path.join('server', 'databases', 'pharmacy.sqlite');

function verifyDatabase(filename) {
  if (!fs.existsSync(filename)) throw new Error('SQLite database is missing.');
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    if (Object.values(db.prepare('PRAGMA quick_check').get())[0] !== 'ok' ||
        db.prepare('PRAGMA foreign_key_check').all().length !== 0) throw new Error('SQLite integrity check failed.');
  } finally { db.close(); }
}

function files(root, relative = '') {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const name = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Backup contains a symbolic link.');
    return entry.isDirectory() ? files(root, name) : [name];
  });
}

function manifest(root) {
  return Object.fromEntries(files(root).filter(name => name !== 'backup-manifest.json').sort().map(name => [
    name.replaceAll('\\', '/'),
    crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex'),
  ]));
}

function checkClosed() {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(process.env.PORT || 3210) });
    socket.setTimeout(700);
    socket.on('connect', () => { socket.destroy(); reject(new Error('Close PharmaSpot before backup or restore.')); });
    socket.on('error', () => resolve());
    socket.on('timeout', () => { socket.destroy(); reject(new Error('Cannot verify that PharmaSpot is closed.')); });
  });
}

async function run(command, target, confirmed = false) {
  if (!['backup', 'restore'].includes(command) || !target) throw new Error('Usage: node scripts/offline-backup.js backup <new-folder> | restore <backup-folder> --confirm');
  await checkClosed();
  const destination = path.resolve(target);
  if (command === 'backup') {
    const source = path.join(appData, relativeDatabase);
    verifyDatabase(source);
    if (fs.existsSync(destination)) throw new Error('Backup destination already exists.');
    if (destination.startsWith(path.resolve(appData) + path.sep)) throw new Error('Backup must be outside the live data folder.');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(appData, destination, { recursive: true, errorOnExist: true, force: false });
    const snapshot = path.join(destination, relativeDatabase);
    fs.rmSync(snapshot);
    const sourceDb = new DatabaseSync(source, { readOnly: true });
    try { await backup(sourceDb, snapshot); }
    finally { sourceDb.close(); }
    for (const suffix of ['-wal', '-shm']) fs.rmSync(snapshot + suffix, { force: true });
    verifyDatabase(snapshot);
    fs.writeFileSync(path.join(destination, 'backup-manifest.json'), JSON.stringify(manifest(destination), null, 2));
    return `Backup saved: ${destination}`;
  }
  if (!confirmed) throw new Error('Restore requires --confirm. It replaces live data after saving a safety copy.');
  if (destination === path.resolve(appData) || destination.startsWith(path.resolve(appData) + path.sep)) throw new Error('Backup source must be outside the live data folder.');
  if (!fs.existsSync(path.join(destination, 'backup-manifest.json'))) throw new Error('Backup manifest is missing.');
  const expected = JSON.parse(fs.readFileSync(path.join(destination, 'backup-manifest.json'), 'utf8'));
  if (JSON.stringify(expected) !== JSON.stringify(manifest(destination))) throw new Error('Backup integrity check failed.');
  verifyDatabase(path.join(destination, relativeDatabase));
  const parent = path.dirname(appData);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safety = path.join(parent, `PharmaSpot-before-restore-${stamp}`);
  const staging = path.join(parent, `PharmaSpot-restore-staging-${stamp}`);
  fs.cpSync(destination, staging, { recursive: true, errorOnExist: true, force: false });
  fs.rmSync(path.join(staging, 'backup-manifest.json'));
  if (fs.existsSync(appData)) fs.renameSync(appData, safety);
  try { fs.renameSync(staging, appData); }
  catch (err) {
    if (fs.existsSync(safety)) fs.renameSync(safety, appData);
    throw err;
  }
  return `Restore complete. Previous data saved: ${safety}`;
}

if (require.main === module) {
  run(process.argv[2], process.argv[3], process.argv.includes('--confirm'))
    .then(message => console.log(message))
    .catch(err => { console.error(err.message); process.exitCode = 1; });
}

module.exports = { run, manifest };
