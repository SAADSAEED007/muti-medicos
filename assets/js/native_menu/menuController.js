const { app, dialog } = require("electron");
let mainWindow;
const path = require("path");
const iconPath = path.join(__dirname, "../../../assets/images/multi-medicos-icon.png");
const appVersion = app.getVersion();
const appName = app.getName();
const pkg = require("../../../package.json");
const { appConfig } = require("../../../app.config");
const { autoUpdater } = require("electron-updater");
const unzipper = require('unzipper');
const archiver = require('archiver');
const dbFolderPath = path.join(
  process.env.APPDATA,
  process.env.APPNAME,
  "server",
  "databases"
);
const uploadsFolderPath = path.join(
  process.env.APPDATA,
  process.env.APPNAME,
  "uploads"
);
const fs = require('fs');
const crypto = require('crypto'); 
const os = require('os');
const { backup, DatabaseSync } = require('node:sqlite');
const { db } = require('../../../api/sqlite');
const isPackaged = app.isPackaged;
const updateServer = appConfig.UPDATE_SERVER;
const updateUrl = `${updateServer}/update/${
  process.platform
}/${app.getVersion()}`;

function writeZip(destination, configure) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destination);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    configure(archive);
    archive.finalize();
  });
}

function fileSha256(filename) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filename);
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
    input.on('error', reject);
  });
}

function showAbout() {
  const options = {
    applicationName: `${appName}`,
    applicationVersion: `v${appVersion}`,
    copyright: `Copyright © ${
      appConfig.COPYRIGHT_YEAR
    }-${new Date().getFullYear()} ${pkg.author}`,
    version: `v${appVersion}`,
    authors: [pkg.author],
    website: pkg.website,
    iconPath: iconPath,
  };
  app.setAboutPanelOptions(options);
  app.showAboutPanel();
}

function getDocs() {}

function sendFeedback() {}

function checkForUpdates() {
  if (!isPackaged) {
    console.log(`Skipping update check in development mode`);
    return;
  }

  const dialogOpts = {
    type: "info",
    buttons: ["Update now", "Later"],
    title: "New version available",
  };

  autoUpdater.setFeedURL({
    provider: "generic",
    url: updateUrl,
  });

  autoUpdater.checkForUpdates();
  autoUpdater.autoDownload = false;

  const handleUpdateAvailable = (info) => {
    const message = `Current version: ${pkg.version}\nNew Version: ${info.version}`;
    dialogOpts.message = message;
    dialogOpts.detail =
      process.platform === "win32" ? releaseNotes : releaseName;

    dialog.showMessageBox(dialogOpts).then((returnValue) => {
      if (returnValue.response === 0) {
        autoUpdater.downloadUpdate();
      }
    });
  };

  const handleUpdateNotAvailable = (info) => {
    dialogOpts.type = "info";
    dialogOpts.buttons = ["OK"];
    dialogOpts.title = "No Updates Available";
    dialogOpts.message = `You are using the latest version: ${info.version}`;
    dialog.showMessageBox(dialogOpts);
  };

  const handleUpdateDownloaded = (info) => {
    console.log(`Update downloaded for version ${info.version}`);
    dialogOpts.buttons = ["Install now", "Later"];
    dialogOpts.title = "Ready to Install Update";
    dialogOpts.message = `The update for version ${info.version} is downloaded.\nClick 'Install now' to restart the app and apply the update.`;
    dialog.showMessageBox(dialogOpts).then((returnValue) => {
      if (returnValue.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  };


const handleError = async (err) => {
  try {
    console.error(`Error checking for updates: ${err}`);
    
    const dialogOpts = {
      type: "error",
      title: "Update check failed",
      message: "An error occurred while checking for updates.",
      detail: err,
      buttons: ["Retry", "Cancel"]
    };

    const returnValue = await dialog.showMessageBox(dialogOpts);

    if (returnValue.response === 0) {
      checkForUpdates();
    }
  } catch (error) {
    console.error(`Error in handleError function: ${error}`);
  }
};

  autoUpdater.on("update-available", handleUpdateAvailable);
  autoUpdater.on("update-not-available", handleUpdateNotAvailable);
  autoUpdater.on("update-downloaded", handleUpdateDownloaded);
  autoUpdater.on("error", handleError);
}

/**
 * Creates a consistent online SQLite snapshot and includes the uploads folder.
 * Stores the SHA256 hash as a file inside the zip (sha256.txt).
 * @param {string} dbFolderPath - Retained for compatibility with the menu caller.
 * @param {string} uploadsFolderPath - Path to the uploads folder.
 * @param {string} backupZipPath - Path to save the backup zip file.
 * @returns {Promise<void>}
 */
const createBackup = async (dbFolderPath, uploadsFolderPath, backupZipPath) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-medicos-backup-'));
  const snapshotFolder = path.join(tempRoot, 'databases');
  const snapshotPath = path.join(snapshotFolder, 'pharmacy.sqlite');
  const innerZip = path.join(tempRoot, 'backup.zip');
  const pendingOutput = `${backupZipPath}.partial`;
  fs.mkdirSync(snapshotFolder, { recursive: true });
  try {
    await backup(db, snapshotPath);
    const snapshotDb = new DatabaseSync(snapshotPath, { readOnly: true });
    try {
      const check = snapshotDb.prepare('PRAGMA integrity_check').get();
      if (!check || check.integrity_check !== 'ok') throw new Error('SQLite backup failed its integrity check.');
    } finally {
      snapshotDb.close();
    }

    await writeZip(innerZip, archive => {
      archive.file(snapshotPath, { name: 'databases/pharmacy.sqlite' });
      if (fs.existsSync(uploadsFolderPath)) archive.directory(uploadsFolderPath, 'uploads');
    });
    const digest = await fileSha256(innerZip);
    await writeZip(pendingOutput, archive => {
      archive.file(innerZip, { name: 'backup.zip' });
      archive.append(digest, { name: 'sha256.txt' });
    });
    if (fs.existsSync(backupZipPath)) fs.rmSync(backupZipPath, { force: true });
    fs.renameSync(pendingOutput, backupZipPath);
  } finally {
    if (fs.existsSync(pendingOutput)) fs.rmSync(pendingOutput, { force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
};

/**
 * Verifies and stages a backup. The database is replaced only during the next
 * application startup, before SQLite is opened.
 * @param {string} backupZipPath - Path to the backup zip file.
 * @returns {Promise<string>} Staging directory queued for startup.
 */
const prepareRestore = async (backupZipPath) => {
  // Read sha256.txt from the zip
  const zip = await unzipper.Open.file(backupZipPath);
  const shaFileEntry = zip.files.find(f => f.path === 'sha256.txt');
  if (!shaFileEntry) throw new Error('SHA256 file not found in backup!');
  const expectedHash = (await shaFileEntry.buffer()).toString().trim();

  // Find backup.zip entry (the actual backup data)
  const backupEntry = zip.files.find(f => f.path === 'backup.zip');
  if (!backupEntry) throw new Error('backup.zip not found in backup!');

  const appRoot = path.join(process.env.APPDATA, process.env.APPNAME);
  const stagingRoot = path.join(path.dirname(appRoot), `${process.env.APPNAME}-restore-staging-${Date.now()}`);
  const innerZip = path.join(stagingRoot, 'backup.zip');
  fs.mkdirSync(stagingRoot, { recursive: true });
  try {
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(innerZip);
      output.on('close', resolve);
      output.on('error', reject);
      backupEntry.stream().on('error', reject).pipe(output);
    });
    const digest = await fileSha256(innerZip);
    if (digest !== expectedHash) throw new Error('Backup file integrity check failed.');

    const inner = await unzipper.Open.file(innerZip);
    for (const entry of inner.files) {
      const normalized = entry.path.replace(/\\/g, '/');
      if (!normalized.startsWith('databases/') && !normalized.startsWith('uploads/')) continue;
      const target = path.resolve(stagingRoot, normalized);
      if (!target.startsWith(path.resolve(stagingRoot) + path.sep)) throw new Error('Backup contains an unsafe path.');
      if (entry.type === 'Directory') {
        fs.mkdirSync(target, { recursive: true });
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(target);
        output.on('close', resolve);
        output.on('error', reject);
        entry.stream().on('error', reject).pipe(output);
      });
    }
    fs.rmSync(innerZip, { force: true });

    const stagedDatabase = path.join(stagingRoot, 'databases', 'pharmacy.sqlite');
    if (!fs.existsSync(stagedDatabase)) throw new Error('Backup does not contain pharmacy.sqlite.');
    const stagedDb = new DatabaseSync(stagedDatabase, { readOnly: true });
    try {
      const check = stagedDb.prepare('PRAGMA integrity_check').get();
      if (!check || check.integrity_check !== 'ok') throw new Error('Backup database failed its integrity check.');
    } finally {
      stagedDb.close();
    }

    fs.mkdirSync(appRoot, { recursive: true });
    fs.writeFileSync(path.join(appRoot, 'restore-pending.json'), JSON.stringify({ stagingRoot }), 'utf8');
    return stagingRoot;
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Opens a dialog for the user to select a folder and saves the backup zip there.
 * Adds a timestamp to the backup file name.
 * @param {string} dbFolderPath - Retained for compatibility with the menu caller.
 * @param {string} uploadsFolderPath - Path to the uploads folder.
 */
const saveBackupDialog = async (dbFolderPath, uploadsFolderPath) => {
  // Simple timestamp: YYYYMMDD-HHmmss
  const now = new Date();
  const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const defaultName = `${process.env.APPNAME}-backup-${timestamp}.zip`;
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "Save Database Backup",
    defaultPath: defaultName,
    filters: [{ name: "Zip Files", extensions: ["zip"] }]
  });

  if (!canceled && filePath) {
    try {
      await createBackup(dbFolderPath, uploadsFolderPath, filePath);
      dialog.showMessageBox({
        type: "info",
        title: "Backup Successful",
        message: "Backup saved successfully.",
        detail: `${filePath}`
      });
    } catch (err) {
      dialog.showErrorBox("Backup Failed", err.message || String(err));
    }
  }
};

/**
 * Opens a dialog for the user to select a backup zip file and restores the database and uploads folder.
 * @param {string} dbFolderPath - Retained for compatibility with the menu caller.
 * @param {string} uploadsFolderPath - Retained for compatibility with the menu caller.
 */
const restoreBackupDialog = async (dbFolderPath, uploadsFolderPath) => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Select Database Backup to Restore",
    filters: [{ name: "Zip Files", extensions: ["zip"] }],
    properties: ["openFile"]
  });

  if (!canceled && filePaths && filePaths[0]) {
    const confirm = await dialog.showMessageBox({
      type: "warning",
      title: "Confirm Restore",
      message: "Restoring a backup will overwrite your current database and uploads. Are you sure?",
      buttons: ["Restore", "Cancel"],
      defaultId: 1,
      cancelId: 1
    });
    if (confirm.response !== 0) return;

    try {
      await prepareRestore(filePaths[0]);
      await dialog.showMessageBox({
        type: "info",
        title: "Restore Ready",
        message: "The backup was verified. Multi Medicos will restart to restore it safely.",
        detail: "Your current data will be kept in a dated safety folder."
      });
      app.relaunch();
      app.exit(0);
    } catch (err) {
      dialog.showErrorBox("Restore Failed", err.message || String(err));
    }
  }
};

const initializeMainWindow = (win)=>{
mainWindow = win;
} 

const handleClick = (elementId)=>{
  mainWindow.webContents.send('click-element', elementId);
}

module.exports = {
  showAbout, 
  checkForUpdates, 
  getDocs, 
  sendFeedback,
  initializeMainWindow,
  handleClick,
  dbFolderPath,
  uploadsFolderPath,
  createBackup,
  prepareRestore,
  saveBackupDialog,
  restoreBackupDialog
 };
