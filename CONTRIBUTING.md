# Contributing to Multi Medicos

Thank you for helping maintain Multi Medicos. Keep fixes focused and preserve the established offline Windows, SQLite, inventory, Khata, and accounting behavior.

## Set up a branch

```bash
git clone https://github.com/SAADSAEED007/muti-medicos.git
cd muti-medicos
npm ci
npm start
git switch -c fix/issue-name
```

## Contribution workflow

1. Search existing issues and record clear reproduction steps.
2. Reproduce with temporary or invented data—never a real pharmacy database.
3. Make the smallest reasonable fix; do not rewrite core business logic without prior discussion.
4. Add or update automated tests for the behavior.
5. Run `npm test -- --runInBand` and the relevant isolated script from `scripts/`.
6. Confirm a fresh owner setup or an existing-profile update still works when your change affects persistence.
7. Commit clearly, for example `git commit -m "Fix duplicate purchase receiving"`.
8. Push with `git push -u origin fix/issue-name`.
9. Open a pull request against `main` and complete the checklist.

Do not commit `node_modules`, `out`, databases, SQLite WAL/SHM files, backups, environment secrets, logs, or customer/business data. Screenshots and logs must be sanitized.

## Coding and review guidance

- Follow the CommonJS and formatting style already used in the touched file.
- Keep money calculations in integer cents and preserve transaction boundaries.
- Maintain foreign keys, inventory invariants, journal balance, and retry/idempotency protection.
- Preserve `%APPDATA%\PharmaSpot` compatibility unless a separately reviewed migration is provided.
- Treat backup/restore, authentication, and schema changes as high risk and add isolated upgrade tests.
- Keep Ledger/Cashbook UI hidden unless a product decision explicitly restores it; internal accounting remains required.

Contributions are licensed under the repository's MIT license. Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
