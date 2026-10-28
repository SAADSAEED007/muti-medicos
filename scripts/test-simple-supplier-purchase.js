const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmaspot-simple-purchase-'));
process.env.APPDATA = root;
process.env.APPNAME = 'PharmaSpotSimplePurchaseTest';
fs.mkdirSync(path.join(root, process.env.APPNAME, 'server', 'databases'), { recursive: true });
fs.mkdirSync(path.join(root, process.env.APPNAME, 'uploads'), { recursive: true });

const express = require('express');
const app = express();
app.use(express.json());
const usersApi = require('../api/users');
app.use('/api', usersApi.authorize);
app.use('/api/inventory', require('../api/inventory'));
app.use('/api/suppliers', require('../api/suppliers'));
app.use('/api/purchases', require('../api/purchases'));
app.use('/api/ledger', require('../api/ledger'));
app.use('/api/users', usersApi);

const server = app.listen(0, '127.0.0.1');
let token = '';

async function request(route, method = 'GET', body) {
  const headers = token ? { 'X-Access-Token': token } : {};
  if (!(body instanceof FormData)) headers['content-type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method, headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

(async () => {
  try {
    if (!server.listening) await once(server, 'listening');
    const setup = await request('/api/users/setup', 'POST', { username: 'owner', password: 'OwnerPassword123!' });
    assert.equal(setup.status, 200);
    token = setup.data.token;

    const createdSupplier = await request('/api/suppliers', 'POST', {
      name: 'Simple Karachi Supplier', phone: '03001234567', address: 'Saddar, Karachi'
    });
    assert.equal(createdSupplier.status, 201);
    const supplierId = createdSupplier.data.id;
    const nameOnlySupplier = await request('/api/suppliers', 'POST', { name: 'Name Only Supplier' });
    assert.equal(nameOnlySupplier.status, 201, 'supplier with only a name was rejected');
    let supplier = await request(`/api/suppliers/${supplierId}`);
    assert.equal(supplier.data.phone, '03001234567', 'phone leading zero was not preserved');
    assert.equal(supplier.data.payment_terms, 'Net 30');

    const editedSupplier = await request(`/api/suppliers/${supplierId}`, 'PUT', {
      name: 'Simple Karachi Supplier', phone: '02134567890', address: 'M.A. Jinnah Road, Karachi',
      payment_terms: 'Net 15', due_period_days: 15
    });
    assert.equal(editedSupplier.status, 200);
    supplier = await request(`/api/suppliers/${supplierId}`);
    assert.equal(supplier.data.address, 'M.A. Jinnah Road, Karachi');
    assert.equal(supplier.data.due_period_days, 15);

    const quickMedicine = new FormData();
    for (const [key, value] of Object.entries({
      id: '', quick_add: '1', barcode: '', name: 'Quick Test Tablet 10mg', price: '20.00',
      expirationDate: '', category: 'Test Medicines', supplier: '', quantity: '0', minStock: '0'
    })) quickMedicine.set(key, value);
    const medicineResponse = await request('/api/inventory/product', 'POST', quickMedicine);
    assert.equal(medicineResponse.status, 200, JSON.stringify(medicineResponse.data));
    const medicine = medicineResponse.data.product;
    assert.ok(Number.isSafeInteger(Number(medicine.barcode)));
    assert.equal(Number(medicine.quantity), 0, 'quick add changed stock before purchase receipt');

    const duplicateMedicine = new FormData();
    for (const [key, value] of quickMedicine.entries()) duplicateMedicine.set(key, value);
    const duplicateMedicineResponse = await request('/api/inventory/product', 'POST', duplicateMedicine);
    assert.equal(duplicateMedicineResponse.status, 409, 'exact duplicate medicine name was silently created');

    const draft = await request('/api/purchases', 'POST', {
      supplier_id: supplierId, invoice_no: 'SIMPLE-DRAFT-1', invoice_date: '2026-10-27',
      status: 'draft', paid_amount: '10.00', payment_method: 'cash',
      items: [{ product_id: medicine._id, batch_number: 'QT-001', expiry_date: '2028-12-31', quantity: 3, bonus_quantity: 1, unit_cost: '12.00' }]
    });
    assert.equal(draft.status, 201, JSON.stringify(draft.data));
    let products = (await request('/api/inventory/products')).data;
    assert.equal(Number(products.find(item => item._id === medicine._id).quantity), 0, 'draft changed inventory');

    const received = await request(`/api/purchases/${draft.data.id}/receive`, 'POST', {});
    assert.equal(received.status, 200, JSON.stringify(received.data));
    products = (await request('/api/inventory/products')).data;
    const receivedMedicine = products.find(item => item._id === medicine._id);
    assert.equal(Number(receivedMedicine.quantity), 4, 'received quantity did not include bonus exactly once');
    assert.equal(receivedMedicine.expirationDate, '31-Dec-2028', 'first batch expiry was not made available to legacy POS validation');

    const receivedTwice = await request(`/api/purchases/${draft.data.id}/receive`, 'POST', {});
    assert.equal(receivedTwice.status, 409, 'purchase could be received twice');
    const duplicateInvoice = await request('/api/purchases', 'POST', {
      supplier_id: supplierId, invoice_no: 'SIMPLE-DRAFT-1', invoice_date: '2026-10-27', status: 'draft',
      items: [{ product_id: medicine._id, batch_number: 'QT-002', expiry_date: '2029-12-31', quantity: 1, unit_cost: '12.00' }]
    });
    assert.equal(duplicateInvoice.status, 409, 'duplicate supplier invoice was accepted');

    const purchase = await request(`/api/purchases/${draft.data.id}`);
    assert.equal(purchase.data.total, '36.00');
    assert.equal(purchase.data.paid, '10.00');
    assert.equal(purchase.data.outstanding, '26.00');
    assert.equal((await request(`/api/suppliers/${supplierId}`)).data.outstanding_payable, '26.00');

    const fullyPaid = await request('/api/purchases', 'POST', {
      supplier_id: supplierId, invoice_no: 'SIMPLE-PAID-1', invoice_date: '2026-10-27', status: 'received',
      paid_amount: '5.00', payment_method: 'bank',
      items: [{ product_id: medicine._id, batch_number: 'QT-PAID', expiry_date: '2029-12-31', quantity: 1, unit_cost: '5.00' }]
    });
    assert.equal(fullyPaid.status, 201);
    assert.equal((await request(`/api/purchases/${fullyPaid.data.id}`)).data.payment_status, 'paid');

    const unpaid = await request('/api/purchases', 'POST', {
      supplier_id: supplierId, invoice_no: 'SIMPLE-UNPAID-1', invoice_date: '2026-10-27', status: 'received',
      paid_amount: '0.00', payment_method: 'cash',
      items: [{ product_id: medicine._id, batch_number: 'QT-UNPAID', expiry_date: '2030-12-31', quantity: 1, unit_cost: '6.00' }]
    });
    assert.equal(unpaid.status, 201);
    assert.equal((await request(`/api/purchases/${unpaid.data.id}`)).data.payment_status, 'unpaid');
    assert.equal((await request(`/api/suppliers/${supplierId}`)).data.outstanding_payable, '32.00');

    const laterPayment = await request('/api/ledger/payments', 'POST', {
      party_type: 'supplier', party_id: supplierId, amount: '2.00', payment_method: 'cash',
      allocations: [{ invoice_id: unpaid.data.id, amount: '2.00' }]
    });
    assert.equal(laterPayment.status, 201);
    assert.equal((await request(`/api/suppliers/${supplierId}`)).data.outstanding_payable, '30.00');
    assert.equal((await request(`/api/purchases/${unpaid.data.id}`)).data.outstanding, '4.00');

    const trial = await request('/api/ledger/trial-balance');
    assert.equal(trial.status, 200);
    assert.equal(trial.data.total_debits_cents, trial.data.total_credits_cents, 'journal is not balanced');
    console.log('SIMPLE SUPPLIER/PURCHASE API TEST PASSED');
  } finally {
    server.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
