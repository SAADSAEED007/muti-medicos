# Architecture

## Startup and desktop process

`package.json` points Electron at `start.js`. The main process initializes Electron Remote and `electron-store`, handles Squirrel install/update events through `installers/setupEvents.js`, and applies any verified pending restore through `installers/pendingRestore.js`. It then requires `server.js`, waits for `server.ready`, and creates a maximized `BrowserWindow` that loads `index.html`.

The renderer entry, `renderer.js`, exposes jQuery and loads the POS, product-search, checkout, and enterprise modules. The desktop uses Node integration and does not load a hosted web application.

## Frontend to backend communication

`server.js` binds Express to `127.0.0.1`, normally on port 3210. If that default is busy and no explicit test port was requested, it selects a free loopback port. Requests are JSON/form encoded, rate-limited, origin-checked, and protected by `api/users.js` authorization before business routes execute.

The main route groups are:

- `api/inventory.js`: medicines, barcode lookup, stock, and images
- `api/customers.js` and `api/categories.js`: master data
- `api/suppliers.js` and `api/purchases.js`: supplier accounts, purchases, receiving, and returns
- `api/transactions.js`: held/completed sales, history, invoice detail, and sales returns
- `api/ledger.js`: customer/supplier payments, statements, opening balances, journals, trial balance, and dashboard totals
- `api/expenses.js`: expense categories, expenses, and summaries
- `api/settings.js`: store settings and logo
- `api/users.js`: first-owner setup, login/logout, sessions, roles, and user management

## SQLite initialization and access

`server.js` sets `APPDATA` and `APPNAME`; `api/sqlite.js` opens:

```text
%APPDATA%\PharmaSpot\server\databases\pharmacy.sqlite
```

It creates missing tables and indexes idempotently, adds compatible columns to older customer data, and seeds only accounting metadata (chart-of-account and expense-category definitions). It does not seed owner credentials, medicines, customers, suppliers, or sales.

SQLite runs with foreign keys enabled, WAL journaling, full synchronous durability, and a busy timeout. The exported `transaction(work)` helper uses `BEGIN IMMEDIATE`, commits on success, and rolls back on error. Application money is stored as integer cents.

## Inventory, sales, and purchases

Receiving a purchase in `api/purchases.js` creates purchase items and inventory batches, increases aggregate inventory, records stock movements, updates supplier payable/payment state, and posts balanced journal lines inside a database transaction. Draft purchases do not change stock; receiving is protected from being applied twice.

Completing a sale in `api/transactions.js` validates totals and stock, deducts inventory (including batch quantities using expiry order), writes sale/item records and stock movements, updates customer receivables for credit portions, and posts revenue/cash-or-receivable journal entries. A payload hash and primary sale identifier protect retries from duplicating transactions. Injected failpoints are used by `scripts/test-sale-crash.js` to verify rollback.

Returns and manual adjustments use the same inventory and journal foundations. `api/accounting.js` centralizes journal/cashbook posting helpers, while `api/ledger.js` handles supplier and customer payment allocations.

## Accounting

The database maintains a chart of accounts, journal entries/lines, party balances, payments, allocations, expenses, cashbook entries, and audit logs. Debits and credits are generated along with operational transactions; `scripts/test-enterprise-system.js` checks trial-balance equality. Ledger and Cashbook navigation/views are intentionally absent from `index.html`, but their internal tables and calculations remain active for reports, Khata, suppliers, and consistency.

## Backup and restore

The File menu calls `assets/js/native_menu/menuController.js`. Backup uses `node:sqlite` online backup, runs SQLite integrity checks, includes runtime uploads, writes a checksum-protected archive through a temporary partial file, and renames it only on success.

Restore rejects unsafe archive paths, verifies the checksum and SQLite integrity, extracts to a sibling staging directory, and writes `restore-pending.json`. On the next launch, `installers/pendingRestore.js` validates the staging location/database, moves the current application data to a dated `PharmaSpot-before-restore-*` safety folder, installs the staged data, and attempts rollback if replacement fails.

## Windows packaging and upgrade identity

`forge.config.js` uses Electron Forge's Squirrel maker, ASAR packaging, the Multi Medicos icon, and `Multi-Medicos-<version>-Setup.exe`. `package.json.name` deliberately remains `PharmaSpot`; `productName` and executable metadata are Multi Medicos. This separation keeps the existing `%APPDATA%\PharmaSpot` database and Squirrel package identity available during in-place updates.
