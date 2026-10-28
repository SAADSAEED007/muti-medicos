const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const testAppData = process.env.TEST_APPDATA;
const phase = process.env.UI_TEST_PHASE || 'create';
if (!testAppData) throw new Error('TEST_APPDATA is required.');
fs.mkdirSync(testAppData, { recursive: true });
app.setPath('appData', testAppData);
process.env.APPDATA = testAppData;
process.env.APPNAME = 'PharmaSpot';

const { db } = require('../api/sqlite');
if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count === 0) {
  const password = require('bcrypt').hashSync('isolated-ui-password-123', 10);
  db.prepare(`INSERT INTO users(id,username,fullname,password,perm_users,perm_products,perm_categories,perm_transactions,perm_settings)
    VALUES (1,'purchase-owner','Purchase UI Owner',?,1,1,1,1,1)`).run(password);
}
if (db.prepare('SELECT COUNT(*) AS count FROM products').get().count === 0) {
  db.prepare("INSERT INTO categories(id,name,data_json) VALUES (1,'Pain Relief','{\"name\":\"Pain Relief\"}')").run();
  db.prepare("INSERT INTO categories(id,name,data_json) VALUES (2,'Other Medicines','{\"name\":\"Other Medicines\"}')").run();
  db.prepare(`INSERT INTO products(id,barcode,name,price_cents,expiration_date,category,supplier,stock_tracked,min_stock,img)
    VALUES (1,88001,'Existing Selector Medicine',2500,'31-Dec-2035','1','',1,0,'')`).run();
  db.prepare('INSERT INTO inventory(product_id,quantity) VALUES (1,0)').run();
  db.prepare(`INSERT INTO products(id,barcode,name,price_cents,expiration_date,category,supplier,stock_tracked,min_stock,img)
    VALUES (2,88002,'Search Target Capsule',1800,'31-Dec-2035','2','',1,0,'')`).run();
  db.prepare('INSERT INTO inventory(product_id,quantity) VALUES (2,5)').run();
}

let complete = false;
let loginSubmitted = false;
const rendererErrors = [];
const timeout = setTimeout(() => finish(new Error('Electron supplier/purchase UI test timed out.')), 90000);

function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function finish(error) {
  if (complete) return;
  complete = true;
  clearTimeout(timeout);
  if (!error && rendererErrors.length) error = new Error(`Renderer errors: ${JSON.stringify(rendererErrors)}`);
  if (error) {
    console.error('UI TEST FAILURE:', error);
    process.exitCode = 1;
    app.exit(1);
    return;
  }
  console.log(`SUPPLIER/PURCHASE UI ${phase.toUpperCase()} PASSED`);
  process.exitCode = 0;
  app.exit(0);
}

async function waitFor(window, expression, label, attempts = 50) {
  for (let index = 0; index < attempts; index++) {
    const result = await window.webContents.executeJavaScript(`(() => ${expression})()`);
    if (result) return result;
    await pause(200);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

app.on('browser-window-created', (_event, window) => {
  window.once('ready-to-show', () => {
    window.unmaximize();
    window.setBounds({ x: 0, y: 0, width: 1366, height: 768 });
  });
  window.webContents.on('console-message', (_event, level, message) => {
    const ignored = /Content Security Policy|Content-Security-Policy|Electron Security Warning|DevTools/.test(message);
    if (level >= 2 && !ignored) rendererErrors.push(message);
  });

  window.webContents.on('did-finish-load', async () => {
    if (complete) return;
    try {
      await pause(700);
      const visibility = await window.webContents.executeJavaScript(`(() => ({
        login: getComputedStyle(document.querySelector('#login')).display !== 'none',
        main: getComputedStyle(document.querySelector('#main_app')).display !== 'none'
      }))()`);
      if (visibility.login) {
        if (loginSubmitted) return;
        loginSubmitted = true;
        await window.webContents.executeJavaScript(`(() => {
          const form = document.querySelector('#account');
          form.querySelector('[name=username]').value = 'purchase-owner';
          form.querySelector('[name=password]').value = 'isolated-ui-password-123';
          form.requestSubmit();
        })()`);
        return;
      }
      if (!visibility.main) return;

      await pause(1400);
      await waitFor(window, `document.querySelectorAll('#parent .box').length >= 2`, 'POS product cards');
      async function searchPos(query) {
        await window.webContents.executeJavaScript(`(() => {
          const input = document.querySelector('#search');
          input.value = ${JSON.stringify(query)};
          $(input).trigger('input');
        })()`);
        await pause(100);
        return window.webContents.executeJavaScript(`(() => [...document.querySelectorAll('#parent .box')]
          .filter(card => getComputedStyle(card).display !== 'none')
          .map(card => card.querySelector('.product-card-name').textContent.trim()))()`);
      }
      const nameMatches = await searchPos('selector');
      const skuMatches = await searchPos('88002');
      const specialMatches = await searchPos('[');
      const clearedMatches = await searchPos('');
      await window.webContents.executeJavaScript(`(() => { $('#categories').val('1').trigger('change'); return true; })()`);
      await pause(100);
      const categoryMatches = await window.webContents.executeJavaScript(`(() => [...document.querySelectorAll('#parent .box')]
        .filter(card => getComputedStyle(card).display !== 'none')
        .map(card => card.querySelector('.product-card-name').textContent.trim()))()`);
      await window.webContents.executeJavaScript(`(() => { $('#categories').val('0').trigger('change'); return true; })()`);
      if (nameMatches.length !== 1 || nameMatches[0] !== 'Existing Selector Medicine' ||
          skuMatches.length !== 1 || skuMatches[0] !== 'Search Target Capsule' ||
          specialMatches.length !== 0 || clearedMatches.length < 2 ||
          categoryMatches.length !== 1 || categoryMatches[0] !== 'Existing Selector Medicine') {
        throw new Error(`POS search results are incorrect: ${JSON.stringify({ nameMatches, skuMatches, specialMatches, clearedMatches, categoryMatches })}`);
      }
      console.log('POS SEARCH UI PASSED:', JSON.stringify({ nameMatches, skuMatches, specialMatches, categoryMatches, clearedCount: clearedMatches.length }));
      await window.webContents.executeJavaScript(`document.querySelector('[data-view="purchases"]').click()`);
      await pause(300);

      if (phase === 'create') {
        console.log('UI STAGE: open purchase modal');
        await window.webContents.executeJavaScript(`document.querySelector('#btn_new_purchase').click()`);
        await waitFor(window, `document.querySelectorAll('#pur_medicine_results .purchase-search-option').length > 0`, 'SQLite medicines in purchase selector');
        console.log('UI STAGE: medicine selector loaded');
        const initialSelector = await window.webContents.executeJavaScript(`(() => ({
          text: document.querySelector('#pur_medicine_results').textContent,
          supplierEnabled: !document.querySelector('#pur_supplier_search').disabled,
          medicineEnabled: !document.querySelector('#pur_medicine_search').disabled
        }))()`);
        if (!initialSelector.text.includes('Existing Selector Medicine') || !initialSelector.supplierEnabled || !initialSelector.medicineEnabled) {
          throw new Error(`Medicine selector did not load: ${JSON.stringify(initialSelector)}`);
        }

        await window.webContents.executeJavaScript(`document.querySelector('#btn_purchase_add_supplier').click()`);
        await waitFor(window, `document.querySelector('#modal_supplier').classList.contains('in')`, 'supplier modal');
        console.log('UI STAGE: submit supplier');
        await window.webContents.executeJavaScript(`(() => {
          document.querySelector('#supplier_name_input').value = 'UI Karachi Supplier';
          document.querySelector('#supplier_phone_input').value = '03001234567';
          document.querySelector('#supplier_address_input').value = 'Saddar, Karachi';
          document.querySelector('#form_supplier').requestSubmit();
        })()`);
        await pause(1200);
        const supplierHandoffState = await window.webContents.executeJavaScript(`(() => ({
          purchaseModal: document.querySelector('#modal_new_purchase').classList.contains('in'),
          supplierModal: document.querySelector('#modal_supplier').classList.contains('in'),
          selectedId: document.querySelector('#pur_supplier_select').value,
          selectedName: document.querySelector('#pur_supplier_search').value,
          returnData: $('#modal_supplier').data('return-to-purchase'),
          supplierRows: document.querySelector('#suppliers_table_body').textContent
        }))()`);
        console.log('UI SUPPLIER HANDOFF:', JSON.stringify(supplierHandoffState));
        await waitFor(window, `document.querySelector('#pur_supplier_select').value !== ''`, 'new supplier auto-selection');
        console.log('UI STAGE: supplier selected');

        await window.webContents.executeJavaScript(`document.querySelector('#btn_quick_add_medicine').click()`);
        await waitFor(window, `document.querySelector('#modal_quick_medicine').classList.contains('in')`, 'quick medicine modal');
        console.log('UI STAGE: submit quick medicine');
        await window.webContents.executeJavaScript(`(() => {
          document.querySelector('#quick_med_name').value = 'UI Quick Medicine 20mg';
          document.querySelector('#quick_med_selling_price').value = '20.00';
          document.querySelector('#quick_med_cost_price').value = '12.00';
          document.querySelector('#quick_med_category').value = 'UI Test';
          document.querySelector('#form_quick_medicine').requestSubmit();
        })()`);
        await waitFor(window, `document.querySelectorAll('#purchase_items_cards .purchase-item-card').length === 1`, 'quick medicine purchase card');
        console.log('UI STAGE: quick medicine selected');

        await window.webContents.executeJavaScript(`(() => {
          document.querySelector('#pur_invoice_no').value = 'UI-PURCHASE-1';
          document.querySelector('#pur_date_input').value = '2026-10-27';
          const card = document.querySelector('#purchase_items_cards .purchase-item-card');
          card.querySelector('.pur-item-qty').value = '3';
          card.querySelector('.pur-item-cost').value = '12.00';
          card.querySelector('.pur-item-batch').value = 'UI-BATCH-1';
          card.querySelector('.pur-item-expiry').value = '2028-12-31';
          card.querySelector('.pur-item-bonus').value = '1';
          $(card.querySelector('.pur-item-qty')).trigger('input');
          $('#pur_payment_mode').val('partial').trigger('change');
          document.querySelector('#pur_paid_now').value = '10.00';
          $('#pur_paid_now').trigger('input');
        })()`);

        const modalState = await window.webContents.executeJavaScript(`(() => {
          const body = document.querySelector('.purchase-modal-body');
          const footer = document.querySelector('#modal_new_purchase .modal-footer');
          return {
            width: window.innerWidth, height: window.innerHeight,
            modalVisible: document.querySelector('#modal_new_purchase').classList.contains('in'),
            bodyScrollable: body.scrollHeight >= body.clientHeight,
            horizontalOverflow: body.scrollWidth > body.clientWidth,
            horizontalScrollable: body.scrollWidth > body.clientWidth && getComputedStyle(body).overflowX !== 'hidden',
            footerVisible: footer.getBoundingClientRect().top < window.innerHeight,
            total: document.querySelector('#pur_grand_total').textContent,
            paid: document.querySelector('#pur_summary_paid').textContent,
            remaining: document.querySelector('#pur_summary_remaining').textContent
          };
        })()`);
        console.log('UI PURCHASE MODAL:', JSON.stringify(modalState));
        if (modalState.width > 1366 || modalState.height > 768 || modalState.horizontalScrollable || !modalState.modalVisible || !modalState.footerVisible || modalState.total !== '36.00' || modalState.paid !== '10.00' || modalState.remaining !== '26.00') {
          throw new Error(`Purchase modal state is incorrect: ${JSON.stringify(modalState)}`);
        }
        await window.webContents.executeJavaScript(`document.querySelector('#form_new_purchase').requestSubmit()`);
        console.log('UI STAGE: submitted purchase');
        await waitFor(window, `document.querySelector('#purchases_table_body').textContent.includes('UI-PURCHASE-1')`, 'saved purchase row');
        console.log('UI STAGE: purchase row visible');
      } else {
        await waitFor(window, `document.querySelector('#purchases_table_body').textContent.includes('UI-PURCHASE-1')`, 'persisted purchase row');
      }

      const supplier = db.prepare("SELECT * FROM suppliers WHERE name = 'UI Karachi Supplier'").get();
      const medicine = db.prepare("SELECT p.*, i.quantity FROM products p JOIN inventory i ON i.product_id=p.id WHERE p.name='UI Quick Medicine 20mg'").get();
      const purchase = db.prepare("SELECT * FROM purchases WHERE invoice_no='UI-PURCHASE-1'").get();
      const movementCount = medicine ? db.prepare("SELECT COUNT(*) AS count FROM stock_movements WHERE product_id=? AND movement_type='PURCHASE_RECEIPT'").get(medicine.id).count : 0;
      if (!supplier || supplier.phone !== '03001234567' || !medicine || medicine.quantity !== 4 || medicine.expiration_date !== '31-Dec-2028' ||
          !purchase || purchase.total_cents !== 3600 || purchase.paid_cents !== 1000 || purchase.purchase_status !== 'received' || movementCount !== 1) {
        throw new Error(`Persisted purchase data is incorrect: ${JSON.stringify({ supplier, medicine, purchase, movementCount })}`);
      }

      const screenshotPath = path.join(testAppData, `supplier-purchase-${phase}.png`);
      window.show();
      await pause(300);
      fs.writeFileSync(screenshotPath, (await window.capturePage()).toPNG());
      console.log('SUPPLIER/PURCHASE UI STATE:', JSON.stringify({ phase, screenshotPath, quantity: medicine.quantity, total: purchase.total_cents, paid: purchase.paid_cents }));
      finish();
    } catch (error) {
      finish(error);
    }
  });
});

require('../start');
