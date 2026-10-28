const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmaspot-enterprise-test-'));
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
app.use('/api/categories', require('../api/categories'));
app.use('/api/settings', require('../api/settings'));
app.use('/api/suppliers', require('../api/suppliers'));
app.use('/api/purchases', require('../api/purchases'));
app.use('/api/ledger', require('../api/ledger'));
app.use('/api/expenses', require('../api/expenses'));
app.use('/api/users', usersApi);
app.use('/api', require('../api/transactions'));

const server = app.listen(0, '127.0.0.1');
let authToken = '';

async function request(route, method = 'GET', body = null) {
  const url = `http://127.0.0.1:${server.address().port}${route}`;
  const headers = { 'content-type': 'application/json' };
  if (authToken) headers['X-Access-Token'] = authToken;

  const response = await fetch(url, {
    method,
    headers: body instanceof FormData ? (authToken ? { 'X-Access-Token': authToken } : {}) : headers,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const data = (text.startsWith('{') || text.startsWith('[')) ? JSON.parse(text) : text;
  return { status: response.status, data };
}

async function runTests() {
  try {
    if (!server.listening) await once(server, 'listening');

    console.log('--- 1. AUTH & SETUP ---');
    const setupRes = await request('/api/users/setup', 'POST', { username: 'owner_user', password: 'OwnerPassword123!' });
    assert.equal(setupRes.status, 200, 'Owner setup failed');
    authToken = setupRes.data.token;
    assert.ok(authToken, 'Auth token missing');

    console.log('--- 2. SUPPLIER MANAGEMENT ---');
    // Create Supplier 1
    const s1Res = await request('/api/suppliers', 'POST', {
      name: 'ABC Pharma Distributor',
      contact_person: 'Tariq Mehmood',
      phone: '03001234567',
      email: 'abc@pharma.pk',
      address: 'Korangi Industrial Area, Karachi',
      payment_terms: 'Net 30',
      due_period_days: 30,
      opening_balance: 15000 // Rs. 15,000 opening payable
    });
    assert.equal(s1Res.status, 201, `Create supplier failed: ${JSON.stringify(s1Res.data)}`);
    const s1Id = s1Res.data.id;

    // Duplicate supplier check
    const s1Dup = await request('/api/suppliers', 'POST', { name: 'abc pharma distributor' });
    assert.equal(s1Dup.status, 409, 'Duplicate supplier allowed');

    // Verify supplier details and opening payable
    const s1Get = await request(`/api/suppliers/${s1Id}`);
    assert.equal(s1Get.status, 200);
    assert.equal(s1Get.data.name, 'ABC Pharma Distributor');
    assert.equal(s1Get.data.outstanding_payable, '15000.00');

    // Create Supplier 2 (no opening balance)
    const s2Res = await request('/api/suppliers', 'POST', {
      name: 'Sindh Medicos Wholesale',
      contact_person: 'Zubair Khan',
      phone: '03219876543'
    });
    assert.equal(s2Res.status, 201);
    const s2Id = s2Res.data.id;

    console.log('--- 3. PRODUCTS & INVENTORY ---');
    // Create Panadol 500mg
    const f1 = new FormData();
    for (const [k, v] of Object.entries({ barcode: '1001', name: 'Panadol 500mg', price: '15.00', quantity: '0', expirationDate: '31-Dec-2028', supplier: 'ABC Pharma Distributor' })) f1.set(k, v);
    const p1Res = await request('/api/inventory/product', 'POST', f1);
    assert.equal(p1Res.status, 200);

    // Create Brufen 400mg
    const f2 = new FormData();
    for (const [k, v] of Object.entries({ barcode: '1002', name: 'Brufen 400mg', price: '25.00', quantity: '0', expirationDate: '31-Dec-2028', supplier: 'ABC Pharma Distributor' })) f2.set(k, v);
    const p2Res = await request('/api/inventory/product', 'POST', f2);
    assert.equal(p2Res.status, 200);

    const products = (await request('/api/inventory/products')).data;
    const panadol = products.find(p => p.name === 'Panadol 500mg');
    const brufen = products.find(p => p.name === 'Brufen 400mg');
    assert.ok(panadol && brufen);

    console.log('--- 4. MEDICINE PURCHASING & RECEIVING ---');
    // Multi-item purchase from ABC Pharma Distributor:
    // Panadol 500mg: 100 units @ Rs. 10 = Rs. 1,000 (Batch: PANA-B1, Expiry: 31-Dec-2028, bonus: 10)
    // Brufen 400mg: 50 units @ Rs. 18 = Rs. 900 (Batch: BRUF-B1, Expiry: 30-Nov-2027)
    // Total = Rs. 1,900
    // Immediate payment: Rs. 500 cash
    // Remaining payable from invoice: Rs. 1,400
    const purRes = await request('/api/purchases', 'POST', {
      supplier_id: s1Id,
      invoice_no: 'INV-1025',
      invoice_date: '2026-10-26',
      status: 'received', // Receive and post immediately
      paid_amount: '500.00',
      payment_method: 'cash',
      items: [
        {
          product_id: panadol._id,
          batch_number: 'PANA-B1',
          expiry_date: '31-Dec-2028',
          quantity: 100,
          bonus_quantity: 10,
          unit_cost: '10.00'
        },
        {
          product_id: brufen._id,
          batch_number: 'BRUF-B1',
          expiry_date: '30-Nov-2027',
          quantity: 50,
          bonus_quantity: 0,
          unit_cost: '18.00'
        }
      ]
    });
    assert.equal(purRes.status, 201, `Purchase failed: ${JSON.stringify(purRes.data)}`);
    const purId = purRes.data.id;

    // Duplicate purchase invoice for same supplier rejected
    const dupPur = await request('/api/purchases', 'POST', {
      supplier_id: s1Id,
      invoice_no: 'INV-1025',
      items: [{ product_id: panadol._id, batch_number: 'B2', expiry_date: '31-Dec-2028', quantity: 10, unit_cost: '10' }]
    });
    assert.equal(dupPur.status, 409, 'Duplicate purchase invoice allowed');

    // Verify stock updated correctly (Panadol: 100 + 10 bonus = 110, Brufen: 50)
    const stockAfterPur = (await request('/api/inventory/products')).data;
    assert.equal(Number(stockAfterPur.find(p => p._id === panadol._id).quantity), 110);
    assert.equal(Number(stockAfterPur.find(p => p._id === brufen._id).quantity), 50);

    // Verify supplier payable: Opening 15,000 + Purchase 1,900 - Paid 500 = 16,400
    const s1AfterPur = (await request(`/api/suppliers/${s1Id}`)).data;
    assert.equal(s1AfterPur.outstanding_payable, '16400.00');

    console.log('--- 5. SUPPLIER PAYMENT ---');
    // Pay Rs. 6,400 to ABC Pharma Distributor via Bank transfer
    const payRes = await request('/api/ledger/payments', 'POST', {
      party_type: 'supplier',
      party_id: s1Id,
      amount: '6400.00',
      payment_method: 'bank',
      reference_number: 'TRX-BANK-9988',
      notes: 'Partial supplier settlement',
      allocations: [{ invoice_id: purId, amount: '1400.00' }] // Settle remainder of INV-1025
    });
    assert.equal(payRes.status, 201);

    // Supplier payable is now: 16,400 - 6,400 = 10,000
    const s1AfterPay = (await request(`/api/suppliers/${s1Id}`)).data;
    assert.equal(s1AfterPay.outstanding_payable, '10000.00');

    // Purchase INV-1025 is now fully paid
    const purAfterPay = (await request(`/api/purchases/${purId}`)).data;
    assert.equal(purAfterPay.payment_status, 'paid');
    assert.equal(purAfterPay.outstanding, '0.00');

    console.log('--- 6. CUSTOMER KHATA & CREDIT SALES ---');
    // Create customer Ahmed with credit limit Rs. 10,000
    const custRes = await request('/api/customers/customer', 'POST', {
      _id: '9001',
      name: 'Ahmed Tariq',
      phone: '03331122334',
      credit_limit_cents: 1000000 // Rs. 10,000
    });
    assert.equal(custRes.status, 200);

    // Customer opening balance: Rs. 2,000
    const obCust = await request('/api/ledger/opening-balance', 'POST', {
      party_type: 'customer',
      party_id: '9001',
      amount: '2000.00',
      notes: 'Previous month balance'
    });
    assert.equal(obCust.status, 201);

    // Check customer statement: receivable is 2,000
    const custStmt = (await request('/api/ledger/customers/9001/statement')).data;
    assert.equal(custStmt.current_receivable, '2000.00');

    // Mixed Sale: Customer Ahmed buys 10 Panadol (10 x 15 = 150) + 4 Brufen (4 x 25 = 100). Total = 250.
    // Pays Rs. 100 in cash. Remaining Rs. 150 added to Khata.
    const sale1 = {
      _id: 'SALE-101',
      status: 1,
      customer: '9001',
      total: 250,
      paid: 100, // Partial payment
      date: new Date().toISOString(),
      items: [
        { id: panadol._id, product_name: 'Panadol 500mg', price: '15.00', quantity: 10 },
        { id: brufen._id, product_name: 'Brufen 400mg', price: '25.00', quantity: 4 }
      ]
    };
    const saleRes = await request('/api/new', 'POST', sale1);
    assert.equal(saleRes.status, 200);

    // Verify stock deducted (Panadol: 110 - 10 = 100; Brufen: 50 - 4 = 46)
    const stockAfterSale = (await request('/api/inventory/products')).data;
    assert.equal(Number(stockAfterSale.find(p => p._id === panadol._id).quantity), 100);
    assert.equal(Number(stockAfterSale.find(p => p._id === brufen._id).quantity), 46);

    // Customer balance: 2,000 + 150 = 2,150
    const custAfterSale = (await request('/api/ledger/customers/9001/statement')).data;
    assert.equal(custAfterSale.current_receivable, '2150.00');

    console.log('--- 7. CUSTOMER PAYMENT ---');
    // Ahmed pays Rs. 1,000 cash
    const custPayRes = await request('/api/ledger/payments', 'POST', {
      party_type: 'customer',
      party_id: '9001',
      amount: '1000.00',
      payment_method: 'cash',
      notes: 'Cash payment towards Khata'
    });
    assert.equal(custPayRes.status, 201);

    // Ahmed's remaining balance: 2,150 - 1,000 = 1,150
    const custAfterPay = (await request('/api/ledger/customers/9001/statement')).data;
    assert.equal(custAfterPay.current_receivable, '1150.00');

    console.log('--- 8. PURCHASE RETURN ---');
    // Return 5 Panadol from purchase INV-1025 back to ABC Pharma Distributor
    const pretRes = await request(`/api/purchases/${purId}/return`, 'POST', {
      product_id: panadol._id,
      batch_number: 'PANA-B1',
      quantity: 5,
      reason: 'Damaged packing'
    });
    assert.equal(pretRes.status, 200);

    // Stock Panadol is now: 100 - 5 = 95
    const stockAfterPret = (await request('/api/inventory/products')).data;
    assert.equal(Number(stockAfterPret.find(p => p._id === panadol._id).quantity), 95);

    // ABC Pharma payable reduced by 5 x Rs. 10 = Rs. 50 (from 10,000 to 9,950)
    const s1AfterPret = (await request(`/api/suppliers/${s1Id}`)).data;
    assert.equal(s1AfterPret.outstanding_payable, '9950.00');

    console.log('--- 9. CUSTOMER RETURN ---');
    // Ahmed returns 2 Panadol from SALE-101 (2 x 15 = 30) for Khata credit adjustment
    const sretRes = await request('/api/return', 'POST', {
      sale_id: 'SALE-101',
      product_id: panadol._id,
      quantity: 2,
      return_to_stock: 1,
      reason: 'Wrong dosage requested by doctor',
      refund_method: 'credit'
    });
    assert.equal(sretRes.status, 200);

    // Stock Panadol restocked: 95 + 2 = 97
    const stockAfterSret = (await request('/api/inventory/products')).data;
    assert.equal(Number(stockAfterSret.find(p => p._id === panadol._id).quantity), 97);

    // Ahmed's balance reduced by Rs. 30: 1,150 - 30 = 1,120
    const custAfterSret = (await request('/api/ledger/customers/9001/statement')).data;
    assert.equal(custAfterSret.current_receivable, '1120.00');

    console.log('--- 10. EXPENSES & DAILY CASHBOOK ---');
    // Get expense categories
    const expCats = (await request('/api/expenses/categories')).data;
    const rentCat = expCats.find(c => c.name === 'Rent');
    assert.ok(rentCat);

    // Pay rent Rs. 2,000 via Cash
    const expRes = await request('/api/expenses', 'POST', {
      category_id: rentCat.id,
      amount: '2000.00',
      payment_method: 'cash',
      description: 'Monthly pharmacy shop rent'
    });
    assert.equal(expRes.status, 201);

    // Verify Cashbook:
    // Cash Inflows:
    // - Sale 101 cash: Rs. 100
    // - Customer Ahmed payment: Rs. 1,000
    // Total Inflow = Rs. 1,100
    // Cash Outflows:
    // - Supplier purchase initial payment: Rs. 500
    // - Rent expense: Rs. 2,000
    // Total Outflow = Rs. 2,500
    // Net Cashbook = 1,100 - 2,500 = -1,400 (or running balance from start)
    const cb = (await request('/api/ledger/cashbook')).data;
    assert.equal(cb.current_balance, '-1400.00');

    // Post an opening cash balance of Rs. 10,000 in cashbook
    const cbOpening = await request('/api/ledger/cashbook/entry', 'POST', {
      type: 'MANUAL_IN',
      amount: '10000.00',
      description: 'Opening Cash in Drawer'
    });
    assert.equal(cbOpening.status, 201);
    assert.equal(cbOpening.data.balance, '8600.00'); // 10,000 - 1,400 = 8,600

    console.log('--- 11. TRIAL BALANCE & DOUBLE-ENTRY INTEGRITY ---');
    const tb = (await request('/api/ledger/trial-balance')).data;
    assert.equal(tb.is_balanced, true, `Trial balance is not balanced! Total Debit: ${tb.total_debit}, Total Credit: ${tb.total_credit}`);
    console.log(`Trial balance verified: Debits (${tb.total_debit}) === Credits (${tb.total_credit})`);

    console.log('--- 12. AUDIT TRAIL & PRESERVATION ---');
    // Deleting supplier ABC Pharma with posted transactions must be rejected
    const delRes = await request(`/api/suppliers/${s1Id}`, 'DELETE');
    assert.equal(delRes.status, 409, 'Deleting supplier with history should be rejected');

    console.log('ALL ENTERPRISE SYSTEM TESTS PASSED SUCCESSFULLY!');
  } finally {
    server.close();
    require('../api/sqlite').db.close();
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'pharmaspot-enterprise-test-')) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

runTests().catch(err => {
  console.error('Enterprise test failed:', err);
  process.exitCode = 1;
});
