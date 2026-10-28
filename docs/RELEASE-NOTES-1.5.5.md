# Multi Medicos — Windows Pharmacy Management 1.5.5

## Highlights

- Windows 10/11 x64 desktop installer
- Multi Medicos application, shortcut, executable, and installer branding
- Offline SQLite database stored under `%APPDATA%\PharmaSpot`
- Point of Sale with manual medicine name/SKU search and barcode support
- Simplified supplier and medicine-purchase workflows
- Cash, credit, and mixed sales
- Customer Khata and supplier payable tracking
- Medicine batches, expiry, bonus stock, and FEFO inventory handling
- Expenses, transaction history, and financial reports
- Integrity-checked backup and restart-safe restore
- Ledger and Cashbook pages hidden while double-entry accounting remains active

## Historical installer artifacts

These checksums describe the installer produced and checked on 2026-10-27. Generated binaries are not stored in the source repository.

| File | Size | SHA-256 | Signature |
| --- | ---: | --- | --- |
| `Multi-Medicos-1.5.5-Setup.exe` | 164,996,096 bytes | `D985CA2DC632B709ADFA770F415F02451F8D1AE5049B2239EFE9BEBFAFB573EB` | Unsigned |
| `PharmaSpot-1.5.5-full.nupkg` | 164,149,172 bytes | `902287A310B34DE644FF52420543B3F5EDF3C82FE796177ABEF44B74D75908A6` | Unsigned |

Do not assume a newly built installer has these hashes. Verify every rebuilt artifact independently before distribution.

## Data safety and upgrade continuity

- The database remains at `%APPDATA%\PharmaSpot\server\databases\pharmacy.sqlite`.
- Installing or updating Multi Medicos does not intentionally delete or reset pharmacy records.
- Use **File → Backup** before an update and store the archive securely outside the live data directory.

## SmartScreen notice

The historical build is unsigned. Windows SmartScreen may display an **Unknown publisher** warning. Verify the SHA-256 checksum and organization policy before running it; do not disable Windows security.
