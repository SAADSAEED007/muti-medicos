const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmaspot-crash-test-'));
process.env.APPDATA = root;
process.env.APPNAME = 'PharmaSpotTest';
const { db } = require('../api/sqlite');

try {
  db.prepare(`INSERT INTO products(id,barcode,name,price_cents,expiration_date,stock_tracked)
    VALUES (1,1,'Test medicine',1000,'31-Dec-2035',1)`).run();
  db.prepare('INSERT INTO inventory(product_id,quantity) VALUES (1,5)').run();
  const child = path.join(__dirname, 'test-sale-crash-child.js');
  for (const point of ['before_validation', 'after_sale', 'after_first_item', 'after_first_stock', 'after_stock', 'before_commit']) {
    const result = spawnSync(process.execPath, [child, `crash-${point.replaceAll('_', '-')}`], {
      env: { ...process.env, PHARMASPOT_TEST_SALE_FAILPOINT: point }, encoding: 'utf8', timeout: 15000,
    });
    assert.notEqual(result.status, 0, `${point} unexpectedly completed: ${result.stdout} ${result.stderr}`);
    assert.equal(db.prepare('SELECT quantity FROM inventory WHERE product_id=1').get().quantity, 5, `${point}: stock changed`);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sales').get().count, 0, `${point}: sale persisted`);
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  }
  const paid = spawnSync(process.execPath, [child, 'completed-sale'], { env: process.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(paid.status, 0, paid.stderr);
  assert.match(paid.stdout, /200/);
  assert.equal(db.prepare('SELECT quantity FROM inventory WHERE product_id=1').get().quantity, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sales').get().count, 1);
  const retried = spawnSync(process.execPath, [child, 'completed-sale'], { env: process.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(retried.status, 0, retried.stderr);
  assert.match(retried.stdout, /200/);
  assert.equal(db.prepare('SELECT quantity FROM inventory WHERE product_id=1').get().quantity, 3);
  console.log('Sale process interruption and idempotent retry tests passed.');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
