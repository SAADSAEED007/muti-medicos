// Launch with Electron. Uses only TEST_APPDATA supplied by the parent runner.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
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
    VALUES (1,'ui-owner','UI Test Owner',?,1,1,1,1,1)`).run(password);
}
if (db.prepare('SELECT COUNT(*) AS count FROM products').get().count === 0) {
  db.prepare(`INSERT INTO products(id,barcode,name,price_cents,expiration_date,category,supplier,stock_tracked,min_stock,img)
    VALUES (1,99001,'UI Test Medicine',3000,'31-Dec-2035','Test','',1,2,'')`).run();
  db.prepare('INSERT INTO inventory(product_id,quantity) VALUES (1,10)').run();
}

let completed = false;
let loginSubmitted = false;
let rendererErrors = [];
const timeout = setTimeout(() => finish(new Error('Electron transaction UI test timed out.')), 90000);

function finish(error, window) {
  if (completed) return;
  completed = true;
  clearTimeout(timeout);
  if (error) {
    console.error('UI TEST FAILURE:', error);
    process.exitCode = 1;
    app.exit(1);
    return;
  }
  if (rendererErrors.length) {
    console.error('UI TEST RENDERER ERRORS:', JSON.stringify(rendererErrors));
    process.exitCode = 1;
    app.exit(1);
    return;
  }
  console.log(`UI TEST ${phase.toUpperCase()} PASSED`);
  process.exitCode = 0;
  app.exit(0);
}

function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

app.on('browser-window-created', (_event, window) => {
  window.webContents.on('console-message', (_event, level, message) => {
    const knownPlatformWarning = /Content Security Policy|Content-Security-Policy|Electron Security Warning/.test(message);
    if (level >= 2 && !knownPlatformWarning && !/DevTools/.test(message)) rendererErrors.push(message);
  });

  window.webContents.on('did-finish-load', async () => {
    if (completed) return;
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
          form.querySelector('[name=username]').value = 'ui-owner';
          form.querySelector('[name=password]').value = 'isolated-ui-password-123';
          form.requestSubmit();
        })()`);
        return;
      }
      if (!visibility.main) return;

      await pause(1800);
      for (const viewName of ['dashboard', 'purchases', 'suppliers', 'customers_khata', 'expenses', 'reports', 'pos']) {
        const navigationState = await window.webContents.executeJavaScript(`(() => {
          const tab = document.querySelector('[data-view="${viewName}"]');
          if (!tab) return { found: false, visible: false };
          tab.click();
          const view = document.querySelector('#${viewName}_view');
          return { found: true, visible: !!view && getComputedStyle(view).display !== 'none' };
        })()`);
        if (!navigationState.found || !navigationState.visible) {
          throw new Error(`Navigation failed for ${viewName}: ${JSON.stringify(navigationState)}`);
        }
        await pause(100);
      }

      if (phase === 'create') {
        const payload = {
          _id: 'UI-CASH-1', order: 'UI-CASH-1', ref_number: '', status: 1,
          customer: 0, subtotal: 30, discount: 0, tax: 0, total: 30,
          paid: 40, change: '10.00', payment_type: 'Cash', payment_info: '',
          till: 2, user: 'UI Test Owner', user_id: 1,
          date: '2026-10-27T10:00:00.000Z',
          items: [{ id: 1, product_name: 'UI Test Medicine', price: '30.00', quantity: 1 }]
        };
        await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
          $.ajax({
            url: 'http://localhost:${process.env.PORT}/api/new', type: 'POST',
            contentType: 'application/json; charset=utf-8', data: ${JSON.stringify(JSON.stringify(payload))},
            success: resolve, error: xhr => reject(new Error('Sale request failed: ' + xhr.status))
          });
        })`);
      }

      await window.webContents.executeJavaScript(`document.querySelector('#transactions').click()`);
      let state;
      for (let attempt = 0; attempt < 30; attempt++) {
        state = await window.webContents.executeJavaScript(`(() => {
          const rows = [...document.querySelectorAll('#transaction_list tr')];
          const target = rows.find(row => row.textContent.includes('UI-CASH-1'));
          return {
            targetFound: !!target,
            rowText: target ? target.textContent.replace(/\\s+/g, ' ').trim() : '',
            tableVisible: getComputedStyle(document.querySelector('#transactions_view')).display !== 'none',
            ledgerNav: !!document.querySelector('[data-view="ledger"]'),
            cashbookNav: !!document.querySelector('[data-view="cashbook"]'),
            ledgerView: !!document.querySelector('#ledger_view'),
            cashbookView: !!document.querySelector('#cashbook_view'),
            tillValue: document.querySelector('#tills').value,
            cashierValue: document.querySelector('#users').value
          };
        })()`);
        if (state.targetFound) break;
        await pause(250);
      }

      if (!state.targetFound || !state.tableVisible) throw new Error(`Completed sale was not visible: ${JSON.stringify(state)}`);
      if (state.ledgerNav || state.cashbookNav || state.ledgerView || state.cashbookView) throw new Error(`Removed accounting UI is still present: ${JSON.stringify(state)}`);
      if (!state.rowText.includes('PKR30') || !state.rowText.includes('PKR10') || !state.rowText.includes('Cash')) {
        throw new Error(`Transaction row values are incorrect: ${state.rowText}`);
      }

      async function applySelectFilter(selector, value, shouldFindSale) {
        console.log(`UI FILTER: ${selector}=${value}`);
        await window.webContents.executeJavaScript(`(() => { $(${JSON.stringify(selector)}).val(${JSON.stringify(value)}).trigger('change'); return true; })()`);
        for (let attempt = 0; attempt < 20; attempt++) {
          const result = await window.webContents.executeJavaScript(`(() => {
            const text = document.querySelector('#transaction_list').textContent;
            return { found: text.includes('UI-CASH-1'), empty: text.includes('No transactions available') };
          })()`);
          if ((shouldFindSale && result.found) || (!shouldFindSale && result.empty)) {
            console.log(`UI FILTER PASSED: ${selector}=${value}`);
            return;
          }
          await pause(200);
        }
        throw new Error(`Filter ${selector}=${value} did not refresh the transaction table as expected.`);
      }

      await applySelectFilter('#tills', '2', true);
      await applySelectFilter('#users', '1', true);
      await applySelectFilter('#status', '0', false);
      await applySelectFilter('#status', '1', true);
      await applySelectFilter('#tills', '0', true);
      await applySelectFilter('#users', '0', true);

      await window.webContents.executeJavaScript(`(() => {
        const row = [...document.querySelectorAll('#transaction_list tr')].find(entry => entry.textContent.includes('UI-CASH-1'));
        row.querySelector('button').click();
      })()`);
      let invoice;
      for (let attempt = 0; attempt < 25; attempt++) {
        invoice = await window.webContents.executeJavaScript(`(() => ({
          text: document.querySelector('#viewTransaction').textContent.replace(/\\s+/g, ' ').trim(),
          modalVisible: document.querySelector('#orderModal').classList.contains('in') &&
            getComputedStyle(document.querySelector('#orderModal')).display !== 'none'
        }))()`);
        if (invoice.modalVisible && invoice.text.includes('UI-CASH-1')) break;
        await pause(200);
      }
      if (!invoice.modalVisible || !invoice.text.includes('UI-CASH-1') || !invoice.text.includes('UI Test Medicine') || !invoice.text.includes('Outstanding')) {
        throw new Error(`Invoice view is incomplete: ${JSON.stringify(invoice)}`);
      }

      const screenshotPath = path.join(testAppData, `transactions-${phase}.png`);
      window.show();
      await pause(300);
      fs.writeFileSync(screenshotPath, (await window.capturePage()).toPNG());
      console.log('UI TEST STATE:', JSON.stringify({ ...state, invoiceVisible: invoice.modalVisible, screenshotPath }));
      finish(null, window);
    } catch (error) {
      finish(error, window);
    }
  });
});

require('../start');
