const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function inside(parent, child) {
  const base = path.resolve(parent) + path.sep;
  return path.resolve(child).startsWith(base);
}

function applyPendingRestore(appDataPath, appName) {
  const appRoot = path.resolve(appDataPath, appName);
  const markerPath = path.join(appRoot, 'restore-pending.json');
  if (!fs.existsSync(markerPath)) return { applied: false };

  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  const stagingRoot = path.resolve(String(marker.stagingRoot || ''));
  const appDataParent = path.dirname(appRoot);
  if (!inside(appDataParent, stagingRoot) || !path.basename(stagingRoot).startsWith(`${appName}-restore-staging-`)) {
    throw new Error('Pending restore location is invalid. Existing data was not changed.');
  }

  const stagedDatabases = path.join(stagingRoot, 'databases');
  const stagedUploads = path.join(stagingRoot, 'uploads');
  const stagedDatabase = path.join(stagedDatabases, 'pharmacy.sqlite');
  if (!fs.existsSync(stagedDatabase)) throw new Error('Pending restore database is missing. Existing data was not changed.');

  const checkDb = new DatabaseSync(stagedDatabase, { readOnly: true });
  try {
    const integrity = checkDb.prepare('PRAGMA integrity_check').get();
    if (!integrity || integrity.integrity_check !== 'ok') throw new Error('Pending restore database failed its integrity check.');
  } finally {
    checkDb.close();
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safetyRoot = path.join(appDataParent, `${appName}-before-restore-${timestamp}`);
  const liveDatabases = path.join(appRoot, 'server', 'databases');
  const liveUploads = path.join(appRoot, 'uploads');
  const safetyDatabases = path.join(safetyRoot, 'server', 'databases');
  const safetyUploads = path.join(safetyRoot, 'uploads');
  fs.mkdirSync(path.dirname(safetyDatabases), { recursive: true });

  let movedDatabases = false;
  let movedUploads = false;
  let installedDatabases = false;
  let installedUploads = false;
  try {
    if (fs.existsSync(liveDatabases)) {
      fs.renameSync(liveDatabases, safetyDatabases);
      movedDatabases = true;
    }
    fs.mkdirSync(path.dirname(liveDatabases), { recursive: true });
    fs.renameSync(stagedDatabases, liveDatabases);
    installedDatabases = true;

    if (fs.existsSync(liveUploads)) {
      fs.renameSync(liveUploads, safetyUploads);
      movedUploads = true;
    }
    if (fs.existsSync(stagedUploads)) fs.renameSync(stagedUploads, liveUploads);
    else fs.mkdirSync(liveUploads, { recursive: true });
    installedUploads = true;

    fs.rmSync(markerPath, { force: true });
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    return { applied: true, safetyRoot };
  } catch (error) {
    try {
      if (installedDatabases && fs.existsSync(liveDatabases)) fs.rmSync(liveDatabases, { recursive: true, force: true });
      if (installedUploads && fs.existsSync(liveUploads)) fs.rmSync(liveUploads, { recursive: true, force: true });
      if (movedDatabases && fs.existsSync(safetyDatabases)) {
        fs.renameSync(safetyDatabases, liveDatabases);
      }
      if (movedUploads && fs.existsSync(safetyUploads)) {
        fs.renameSync(safetyUploads, liveUploads);
      }
    } catch (rollbackError) {
      error.message += ` Rollback also failed: ${rollbackError.message}`;
    }
    throw error;
  }
}

module.exports = { applyPendingRestore };
