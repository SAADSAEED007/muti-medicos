# Multi Medicos — Windows Installation Guide

Multi Medicos is an offline Windows pharmacy application. The pharmacy computer does not need Node.js, npm, Git, SQLite, or a database server.

## Requirements

- Windows 10 or 11, 64-bit
- Permission to install applications for the local Windows account
- About 500 MB of free disk space
- An installer obtained from the official GitHub Release or maintainer

## Install on a new computer

1. Download `Multi-Medicos-1.5.5-Setup.exe` and its published SHA-256 checksum.
2. Verify the checksum and close any running Multi Medicos process.
3. Run the installer. The unsigned private build may show an **Unknown publisher** warning; follow company policy and do not disable Windows security.
4. Open **Multi Medicos** from the desktop or Start Menu shortcut.
5. Enter the owner username and a password of at least 12 characters, then select **Create Owner Account**.

The fresh database contains schema/accounting definitions only. It does not contain a developer account, demo medicines, customers, suppliers, sales, or a development database.

## Initial pharmacy setup

1. Add medicines from **Products**, including selling price and expiry details.
2. Add suppliers from **Suppliers**.
3. Use **Purchases → New Purchase** to select the supplier and medicines, enter quantity, cost, batch, expiry, bonus quantity, and payment state.
4. Receive the purchase when stock physically arrives. A draft does not change stock; a received purchase changes it once.
5. Add customers before credit/Khata sales.

Barcode scanners and receipt printers are optional. Medicines can be searched manually by name or SKU.

## Customer Khata

Select a registered customer before a credit or mixed sale. The credit portion appears under **Customer Khata**, where full or partial payments can be recorded and reviewed.

## Backup

1. Open **File → Backup**.
2. Choose a destination outside `%APPDATA%\PharmaSpot`, preferably an encrypted external drive or protected storage.
3. Wait for **Backup Successful**.

Backups contain private pharmacy and customer data. Store them securely and create one before every application update.

## Restore

1. Open **File → Restore** and select a Multi Medicos backup.
2. Confirm the restore.
3. The application verifies the archive and database, stages it, and restarts.
4. Confirm the owner, medicines, stock, suppliers, purchases, transactions, and balances.

The prior live data is retained in a dated `PharmaSpot-before-restore-*` folder beside the application-data folder. Keep it until the restored data is verified.

## Update an existing installation

1. Create and safely copy a new backup.
2. Close Multi Medicos.
3. Run the newer official installer.
4. Launch Multi Medicos and verify existing records.

Updates intentionally continue to use:

```text
%APPDATA%\PharmaSpot
```

Do not delete or rename this folder. The name remains `PharmaSpot` for compatibility even though the application is branded Multi Medicos.

## Uninstall safely

Back up first, close the app, and uninstall it from **Windows Settings → Apps → Installed apps**. The data folder should remain for safety. Do not delete `%APPDATA%\PharmaSpot` unless permanent removal is intentional and a verified backup exists.
