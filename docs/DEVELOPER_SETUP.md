# Developer setup

## Verified environment

Multi Medicos 1.5.5 was release-checked on Windows with Node.js 24.17.0, npm 11.13.0, Electron 43.8.4, and Electron Forge 8.0.1.

```powershell
git clone https://github.com/SAADSAEED007/muti-medicos.git
Set-Location muti-medicos
npm ci
npm test -- --runInBand
npm start
```

`npm start` launches the Electron main process. `start.js` starts `server.js`, waits for its loopback API to listen, and then loads `index.html`. Do not run a separate backend process.

## Isolated verification

The following scripts create their own temporary application-data folders:

```powershell
node scripts/test-users.js
node scripts/test-sales.js
node scripts/test-sale-crash.js
node scripts/test-simple-supplier-purchase.js
node scripts/test-transaction-history.js
node scripts/test-enterprise-system.js
node scripts/test-default-replacement.js
node scripts/test-offline-backup.js
node scripts/test-pending-restore.js
node scripts/run-supplier-purchase-ui-test.js
node scripts/run-transaction-ui-test.js
```

The Node integration scripts cover owner/login/users, sales, stock, crash rollback/retry, supplier purchases, credit and mixed transactions, Khata, journals, trial balance, backup/restore, and persistence. The two UI scripts listed last verify supplier/purchase/search and transaction-history workflows across restart.

Three additional wrappers exist—`run-electron-smoke.js`, its `--legacy` mode, and `verify-ui-login.js`. During the 1.5.5 publication audit they reached the renderer but timed out, and their wrappers incorrectly treated timeout termination as success. Until that harness issue is fixed, do not count them as passing release checks.

All test scripts must use `TEST_APPDATA`, `app.setPath('appData', ...)`, or a temporary directory. Never point tests at `%APPDATA%\PharmaSpot` from a real installation.

## Package and installer

```powershell
npm run package
npm run make:win
```

`package` produces an unpacked application under `out/`. `make:win` creates the Squirrel.Windows setup package under `out/make/squirrel.windows/x64/`. Generated output is ignored and should be distributed as a GitHub Release asset only after testing.

## Debugging

- API route modules live in `api/` and use the shared connection exported by `api/sqlite.js`.
- The renderer uses jQuery and calls the local API through helpers in `assets/js/pos.js` and `assets/js/enterprise.js`.
- Set `PHARMASPOT_DISABLE_RELOADER=1` when a repeatable Electron test must avoid development reloads.
- Use `TEST_APPDATA` for an isolated profile and choose a non-default `PORT` for parallel tests.

Do not manually edit an SQLite database used by a pharmacy. Reproduce issues against a fresh temporary profile or a sanitized schema-only fixture.
