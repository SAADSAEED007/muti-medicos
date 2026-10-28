const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmaspot-backup-test-'));
process.env.PHARMASPOT_DATA_DIR = path.join(root, 'PharmaSpot');
process.env.PORT = '62489';
const { run } = require('./offline-backup');

async function main() {
  const live = process.env.PHARMASPOT_DATA_DIR;
  const db = path.join(live, 'server', 'databases', 'pharmacy.sqlite');
  const backup = path.join(root, 'saved');
  fs.mkdirSync(path.dirname(db), { recursive: true });
  let connection = new DatabaseSync(db);
  connection.exec('PRAGMA journal_mode=WAL; CREATE TABLE sample (name TEXT);');
  connection.prepare('INSERT INTO sample VALUES (?)').run('Sample medicine');
  connection.close();
  await run('backup', backup);
  const saved = path.join(backup, 'server', 'databases', 'pharmacy.sqlite');
  connection = new DatabaseSync(saved, { readOnly: true });
  assert.equal(connection.prepare('SELECT name FROM sample').get().name, 'Sample medicine');
  connection.close();
  await assert.rejects(run('restore', backup), /--confirm/);
  connection = new DatabaseSync(db);
  connection.exec("UPDATE sample SET name='Changed'");
  connection.close();
  await run('restore', backup, true);
  connection = new DatabaseSync(db, { readOnly: true });
  assert.equal(connection.prepare('SELECT name FROM sample').get().name, 'Sample medicine');
  connection.close();
  const safety = fs.readdirSync(root).find(name => name.startsWith('PharmaSpot-before-restore-'));
  connection = new DatabaseSync(path.join(root, safety, 'server', 'databases', 'pharmacy.sqlite'), { readOnly: true });
  assert.equal(connection.prepare('SELECT name FROM sample').get().name, 'Changed');
  connection.close();
  fs.writeFileSync(saved, 'tampered');
  await assert.rejects(run('restore', backup, true), /integrity/);
  console.log('Offline backup and restore sample tests passed.');
}

main().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => {
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'pharmaspot-backup-test-')) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
