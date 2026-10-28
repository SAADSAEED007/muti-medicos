# Troubleshooting

## Development install fails

Confirm `node --version` reports Node.js 24.x and `npm --version` reports npm 11.x. From the repository root, run `npm ci`. If a previous dependency folder is corrupted, remove only `node_modules` and rerun `npm ci`; do not remove `%APPDATA%\PharmaSpot`.

## `node:sqlite` cannot be found

The backend uses Node's built-in SQLite module. Older Node.js versions do not provide the required API. Install current Node.js 24 x64. The packaged application uses Electron's bundled runtime and does not need system Node.js.

## Electron opens no window

Run `npm start` from a PowerShell terminal and keep the error output. Check for an orphan `Multi Medicos.exe`/Electron process and whether endpoint protection quarantined application files. The API listens only on loopback; an explicitly assigned test `PORT` that is already occupied causes startup to fail.

## Owner setup or login is unexpected

A fresh profile shows **Create Owner Account** and requires a password of at least 12 characters. If a login screen appears with an existing username, the Windows profile already has Multi Medicos/PharmaSpot data. Do not guess credentials or delete the folder. Back up the data and contact the maintainer.

## SQLite initialization fails

Verify that the Windows user can write to `%APPDATA%\PharmaSpot`, that the disk has free space, and that another process is not locking the database. Never copy only a live `.sqlite` file while the application is running in WAL mode; use the in-app backup command.

## Existing data is missing after an update

Close the application and check whether Windows launched it under a different user account. The expected folder is `%APPDATA%\PharmaSpot`. Do not create replacement records, move folders, or run restore repeatedly until the paths and latest backup are identified.

## Backup or restore fails

Use **File → Backup** while the application is running normally and select a writable destination outside the live data folder. Restore accepts backups produced by Multi Medicos, validates checksums/database integrity, and applies them on restart. Preserve any `PharmaSpot-before-restore-*` directory until the restored data has been checked.

## Windows packaging fails

Use Windows 10/11 x64, Node.js 24, `npm ci`, then `npm run make:win`. Check free disk space and antivirus history. Generated files belong in `out/` and should not be committed.

## Installer or SmartScreen warning

The 1.5.5 private installer is unsigned. Windows may show an unknown-publisher warning. Obtain the installer from the official release, compare its SHA-256 checksum with the published release notes, and follow organization policy. Do not disable Windows security.

## Reporting a problem safely

Include reproduction steps, expected/actual results, Windows and application versions, sanitized logs, and sanitized screenshots. Never upload `pharmacy.sqlite`, WAL/SHM files, backups, passwords, tokens, customer information, or financial records.
