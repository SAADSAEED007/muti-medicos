const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmaspot-sales-test-'));
process.env.APPDATA = root;
process.env.APPNAME = 'PharmaSpotTest';
const dataDir = path.join(root, process.env.APPNAME);
fs.mkdirSync(path.join(dataDir, 'server', 'databases'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
const app = require('express')();
app.use(require('express').json());
app.use('/api/inventory', require('../api/inventory'));
app.use('/api', require('../api/transactions'));
const server = app.listen(0, '127.0.0.1');

async function request(route, method = 'GET', body) {
  const url = `http://127.0.0.1:${server.address().port}${route}`;
  const response = await fetch(url, { method, body: body instanceof FormData ? body : body && JSON.stringify(body), headers: body instanceof FormData ? {} : body ? { 'content-type': 'application/json' } : {} });
  const text = await response.text();
  return { status: response.status, data: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text };
}

async function product(name, barcode, quantity, expirationDate, price = 100, id = '', supplier = '') {
  const form = new FormData();
  for (const [key, value] of Object.entries({ id, img: '', remove: '', name, barcode, expirationDate, price, category: '', supplier, quantity, minStock: 2 })) form.set(key, String(value));
  return request('/api/inventory/product', 'POST', form);
}

async function main() {
  try {
    if (!server.listening) await once(server, 'listening');
    assert.equal((await product('Medicine A', 111, 5, '31-Dec-2035')).status, 200);
    assert.equal((await product('Duplicate', 111, 5, '31-Dec-2035')).status, 409);
    assert.equal((await product('Medicine B', 222, 4, '31-Dec-2035', 50)).status, 200);
    assert.equal((await product('Expired', 333, 4, '01-Jan-2020')).status, 200);
    const products = (await request('/api/inventory/products')).data;
    const a = products.find(p => p.name === 'Medicine A');
    const b = products.find(p => p.name === 'Medicine B');
    const expired = products.find(p => p.name === 'Expired');
    assert.equal((await product('Medicine A', 111, 5, '31-Dec-2035', 100, a._id, 'Sample Supplier')).status, 200);
    assert.equal((await request(`/api/inventory/product/${a._id}`)).data.supplier, 'Sample Supplier');
    assert.equal((await product('Bad stock', 444, -1, '31-Dec-2035')).status, 400);
    const sale = (id, items, total, discount = 0) => ({ _id: id, order: id, status: 1, items, discount, tax: 0, total, paid: total, date: new Date().toISOString() });
    const line = (p, quantity) => ({ id: p._id, product_name: p.name, price: p.price, quantity });
    assert.equal((await request('/api/new', 'POST', sale(1001, [line(a, 1), line(b, 2)], 190, 10))).status, 200);
    let current = (await request('/api/inventory/products')).data;
    assert.equal(Number(current.find(p => p._id === a._id).quantity), 4);
    assert.equal(Number(current.find(p => p._id === b._id).quantity), 2);
    assert.equal((await request('/api/new', 'POST', sale(1002, [line(b, 3)], 150))).status, 409);
    assert.equal((await request('/api/new', 'POST', sale(1003, [line(expired, 1)], 100))).status, 409);
    assert.equal((await request('/api/new', 'POST', sale(1004, [line(a, 1)], 1))).status, 400);
    assert.equal((await request('/api/new', 'POST', sale(1001, [line(a, 1)], 100))).status, 409);
    const held = { ...sale(1005, [line(a, 1)], 100), status: 0, paid: '' };
    assert.equal((await request('/api/new', 'POST', held)).status, 200);
    assert.equal((await request('/api/new', 'PUT', { ...held, status: 1, paid: 100 })).status, 200);
    assert.equal((await request('/api/new', 'PUT', { ...held, status: 1, paid: 100 })).status, 200);
    assert.equal((await request('/api/delete', 'POST', { orderId: 1001 })).status, 409);
    current = (await request('/api/inventory/products')).data;
    assert.equal(Number(current.find(p => p._id === a._id).quantity), 3);
    assert.equal((await request('/api/all')).data.filter(t => t.status === 1).length, 2);
    const persisted = require('../api/sqlite').db.prepare('SELECT quantity FROM inventory WHERE product_id=?').get(a._id);
    assert.equal(Number(persisted.quantity), 3);
    console.log('Sales, stock, expiry, duplicate barcode, totals and history sample tests passed.');
  } finally {
    server.close();
    require('../api/sqlite').db.close();
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'pharmaspot-sales-test-')) fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
