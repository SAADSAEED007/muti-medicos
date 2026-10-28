const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmaspot-transaction-history-'));
process.env.APPDATA = root;
process.env.APPNAME = 'PharmaSpotTest';
const dataDir = path.join(root, process.env.APPNAME);
fs.mkdirSync(path.join(dataDir, 'server', 'databases'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });

const express = require('express');
const app = express();
app.use(express.json());
const usersApi = require('../api/users');
app.use('/api', usersApi.authorize);
app.use('/api/inventory', require('../api/inventory'));
app.use('/api/customers', require('../api/customers'));
app.use('/api/ledger', require('../api/ledger'));
app.use('/api/users', usersApi);
app.use('/api', require('../api/transactions'));

const server = app.listen(0, '127.0.0.1');
let token = '';

async function request(route, method = 'GET', body = null) {
  const headers = {};
  if (token) headers['X-Access-Token'] = token;
  if (body && !(body instanceof FormData)) headers['content-type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method,
    headers,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  return { status: response.status, data: /^[\[{]/.test(text) ? JSON.parse(text) : text };
}

function sale(id, product, date, paid, extra = {}) {
  const total = 30;
  return {
    _id: id,
    order: id,
    ref_number: '',
    status: 1,
    customer: 0,
    subtotal: total,
    discount: 0,
    tax: 0,
    total,
    paid,
    change: Math.max(Number(paid) - total, 0).toFixed(2),
    payment_type: 'Cash',
    till: 2,
    user: 'Test Owner',
    user_id: 1,
    date,
    items: [{ id: product._id, product_name: product.name, price: product.price, quantity: 1 }],
    ...extra
  };
}

async function main() {
  try {
    if (!server.listening) await once(server, 'listening');

    const setup = await request('/api/users/setup', 'POST', { username: 'history-owner', password: 'isolated-history-password' });
    assert.equal(setup.status, 200);
    token = setup.data.token;

    const productForm = new FormData();
    Object.entries({
      id: '', img: '', remove: '', name: 'History Test Medicine', barcode: '88001',
      expirationDate: '31-Dec-2035', price: '30.00', category: 'Test', supplier: '',
      quantity: '20', minStock: '2'
    }).forEach(([key, value]) => productForm.set(key, value));
    assert.equal((await request('/api/inventory/product', 'POST', productForm)).status, 200);
    const product = (await request('/api/inventory/products')).data[0];

    assert.equal((await request('/api/customers/customer', 'POST', {
      _id: '90001', name: 'History Test Customer', phone: '03000000000', credit_limit_cents: 100000
    })).status, 200);
    const customer = { id: '90001', name: 'History Test Customer' };

    assert.equal((await request('/api/new', 'POST', sale('CASH-1', product, '2026-10-27T04:00:00.000Z', 50))).status, 200);
    assert.equal((await request('/api/new', 'POST', sale('CREDIT-1', product, '2026-10-27T05:00:00.000Z', 0, {
      customer, payment_type: 'Credit', change: '0.00'
    }))).status, 200);
    assert.equal((await request('/api/new', 'POST', sale('MIXED-1', product, '2026-10-27T06:00:00.000Z', 10, {
      customer, change: '0.00'
    }))).status, 200);

    const held = sale('HELD-1', product, '2026-10-27T07:00:00.000Z', '', { status: 0, ref_number: 'TAB-1' });
    assert.equal((await request('/api/new', 'POST', held)).status, 200);
    let heldHistory = await request('/api/by-date?start=2026-10-27&end=2026-10-27&status=0&user=0&till=0');
    assert.equal(heldHistory.status, 200);
    assert.deepEqual(heldHistory.data.map(row => row.order), ['HELD-1']);
    assert.equal((await request('/api/new', 'PUT', { ...held, status: 1, paid: 30, change: '0.00' })).status, 200);
    assert.equal((await request('/api/new', 'PUT', { ...held, status: 1, paid: 30, change: '0.00' })).status, 200);

    assert.equal((await request('/api/new', 'POST', sale('END-OF-DAY', product, '2026-10-27T18:59:59.999Z', 30))).status, 200);
    assert.equal((await request('/api/new', 'POST', sale('NEXT-DAY', product, '2026-10-27T19:00:00.000Z', 30))).status, 200);

    const history = await request('/api/by-date?start=2026-10-27&end=2026-10-27&status=1&user=0&till=');
    assert.equal(history.status, 200);
    assert.deepEqual(history.data.map(row => row.order), ['END-OF-DAY', 'HELD-1', 'MIXED-1', 'CREDIT-1', 'CASH-1']);
    assert.equal(history.data.filter(row => row.order === 'HELD-1').length, 1);
    assert.equal(history.data.find(row => row.order === 'CASH-1').paid_amount, '30.00');
    assert.equal(history.data.find(row => row.order === 'CASH-1').change, '20.00');
    assert.equal(history.data.find(row => row.order === 'CREDIT-1').payment_type, 'Credit');
    assert.equal(history.data.find(row => row.order === 'CREDIT-1').outstanding, '30.00');
    assert.equal(history.data.find(row => row.order === 'MIXED-1').payment_type, 'Mixed');
    assert.equal(history.data.find(row => row.order === 'MIXED-1').outstanding, '20.00');
    assert.ok(history.data.every(row => row.user === 'Test Owner'));

    assert.equal((await request('/api/by-date?start=2026-10-27&end=2026-10-27&status=1&user=1&till=2')).data.length, 5);
    assert.equal((await request('/api/by-date?start=2026-10-27&end=2026-10-27&status=1&user=999&till=0')).data.length, 0);
    assert.equal((await request('/api/by-date?start=2026-10-28&end=2026-10-28&status=1&user=0&till=0')).data.length, 1);

    const payment = await request('/api/ledger/payments', 'POST', {
      party_type: 'customer', party_id: customer.id, amount: '15.00', payment_method: 'cash', notes: 'Partial history test payment'
    });
    assert.equal(payment.status, 201);
    const afterPayment = (await request('/api/CREDIT-1')).data;
    assert.equal(afterPayment.paid_amount, '15.00');
    assert.equal(afterPayment.outstanding, '15.00');
    assert.equal(afterPayment.customer.name, customer.name);
    assert.equal(afterPayment.items[0].product_name, product.name);

    const statement = (await request(`/api/ledger/customers/${customer.id}/statement`)).data;
    assert.equal(statement.current_receivable, '35.00');
    const trialBalance = (await request('/api/ledger/trial-balance')).data;
    assert.equal(trialBalance.is_balanced, true);

    const stock = (await request('/api/inventory/products')).data[0];
    assert.equal(Number(stock.quantity), 14);
    const persistedSales = require('../api/sqlite').db.prepare('SELECT COUNT(*) AS count FROM sales WHERE status=1').get();
    assert.equal(persistedSales.count, 6);

    console.log('Transaction history cash, credit, mixed, held-order, filters, Karachi date boundary, invoice, persistence, stock, Khata and journal tests passed.');
  } finally {
    server.close();
    require('../api/sqlite').db.close();
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'pharmaspot-transaction-history-')) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error('Transaction history test failed:', error);
  process.exitCode = 1;
});
