const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { applyPendingRestore } = require('../installers/pendingRestore');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-medicos-restore-test-'));

function createDatabase(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const database = new DatabaseSync(filename);
  database.exec('CREATE TABLE test_value (value TEXT NOT NULL)');
  database.prepare('INSERT INTO test_value (value) VALUES (?)').run(value);
  database.close();
}

function readValue(filename) {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    return database.prepare('SELECT value FROM test_value').get().value;
  } finally {
    database.close();
  }
}

try {
  const appName = 'PharmaSpot';
  const appRoot = path.join(root, appName);
  const liveDatabase = path.join(appRoot, 'server', 'databases', 'pharmacy.sqlite');
  const stagingRoot = path.join(root, `${appName}-restore-staging-test`);
  const stagedDatabase = path.join(stagingRoot, 'databases', 'pharmacy.sqlite');
  createDatabase(liveDatabase, 'before');
  createDatabase(stagedDatabase, 'restored');
  fs.mkdirSync(path.join(appRoot, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'uploads', 'live.txt'), 'before');
  fs.mkdirSync(path.join(stagingRoot, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(stagingRoot, 'uploads', 'restored.txt'), 'restored');
  fs.writeFileSync(path.join(appRoot, 'restore-pending.json'), JSON.stringify({ stagingRoot }));

  const result = applyPendingRestore(root, appName);
  if (!result.applied) throw new Error('Restore was not applied.');
  if (readValue(liveDatabase) !== 'restored') throw new Error('Staged database was not installed.');
  if (!fs.existsSync(path.join(appRoot, 'uploads', 'restored.txt'))) throw new Error('Staged uploads were not installed.');
  if (fs.existsSync(path.join(appRoot, 'restore-pending.json'))) throw new Error('Pending marker was not removed.');
  const safetyDatabase = path.join(result.safetyRoot, 'server', 'databases', 'pharmacy.sqlite');
  if (readValue(safetyDatabase) !== 'before') throw new Error('Previous database was not retained.');
  if (!fs.existsSync(path.join(result.safetyRoot, 'uploads', 'live.txt'))) throw new Error('Previous uploads were not retained.');
  console.log('Pending restore test passed. Previous data retained at:', result.safetyRoot);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
