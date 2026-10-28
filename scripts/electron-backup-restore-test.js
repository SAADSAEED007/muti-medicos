const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-medicos-backup-test-'));
process.env.APPDATA = root;
process.env.APPNAME = 'PharmaSpot';

app.whenReady().then(async () => {
  const { db } = require('../api/sqlite');
  const { createBackup, prepareRestore, dbFolderPath, uploadsFolderPath } = require('../assets/js/native_menu/menuController');
  const { applyPendingRestore } = require('../installers/pendingRestore');
  const backupPath = path.join(root, 'verified-backup.zip');

  db.exec('CREATE TABLE IF NOT EXISTS backup_test (value TEXT NOT NULL); DELETE FROM backup_test;');
  db.prepare('INSERT INTO backup_test (value) VALUES (?)').run('captured-in-backup');
  fs.mkdirSync(uploadsFolderPath, { recursive: true });
  fs.writeFileSync(path.join(uploadsFolderPath, 'proof.txt'), 'captured-in-backup');

  await createBackup(dbFolderPath, uploadsFolderPath, backupPath);
  if (!fs.existsSync(backupPath) || fs.statSync(backupPath).size === 0) throw new Error('Backup archive was not created.');

  db.exec('DELETE FROM backup_test');
  db.prepare('INSERT INTO backup_test (value) VALUES (?)').run('changed-after-backup');
  await prepareRestore(backupPath);
  db.close();

  const result = applyPendingRestore(root, 'PharmaSpot');
  if (!result.applied) throw new Error('Prepared backup was not applied.');
  const { DatabaseSync } = require('node:sqlite');
  const restored = new DatabaseSync(path.join(root, 'PharmaSpot', 'server', 'databases', 'pharmacy.sqlite'), { readOnly: true });
  try {
    const row = restored.prepare('SELECT value FROM backup_test').get();
    if (!row || row.value !== 'captured-in-backup') throw new Error('Restored database does not match the backup snapshot.');
  } finally {
    restored.close();
  }
  if (fs.readFileSync(path.join(root, 'PharmaSpot', 'uploads', 'proof.txt'), 'utf8') !== 'captured-in-backup') {
    throw new Error('Uploads were not restored.');
  }
  console.log('Online SQLite backup, checksum verification, staging, and restart-time restore passed.');
}).then(() => {
  fs.rmSync(root, { recursive: true, force: true });
  app.quit();
}).catch(error => {
  console.error(error);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  app.exit(1);
});
