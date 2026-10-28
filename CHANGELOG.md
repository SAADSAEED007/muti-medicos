# Changelog

## 1.5.5 — 2026-10-27

- Rebranded the Windows desktop application and installer as Multi Medicos while preserving the `PharmaSpot` data path for upgrades.
- Added first-run owner creation, stronger credential/session handling, user management, and role enforcement.
- Added SQLite-backed suppliers, purchases, batches, FEFO stock movement, returns, expenses, customer Khata, payments, and double-entry accounting.
- Added cash, credit, and mixed-payment sales with atomic stock/accounting updates and duplicate/retry protection.
- Simplified supplier and purchase workflows and retained the customized green pharmacy UI.
- Hid Ledger and Cashbook screens while preserving their accounting records and calculations.
- Added integrity-checked in-app backup and restart-safe restore with a retained safety copy.
- Added isolated integration and Electron UI verification scripts plus Windows Squirrel packaging.

See [release notes](docs/RELEASE-NOTES-1.5.5.md) for artifact-specific information.
