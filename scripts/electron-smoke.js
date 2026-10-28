// Launch with Electron, not Node. Uses an isolated appData directory.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const legacy = process.argv.includes('--legacy');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmaspot-electron-smoke-'));
const dataPath = path.join(testRoot, 'appData');
fs.mkdirSync(dataPath, { recursive: true });
if (legacy) {
  process.env.APPDATA = dataPath;
  process.env.APPNAME = 'PharmaSpot';
  const { db } = require('../api/sqlite');
  const password = require('bcrypt').hashSync('admin', 10);
  db.prepare(`INSERT INTO users(id,username,fullname,password,perm_users,perm_products,perm_categories,perm_transactions,perm_settings)
    VALUES (1,'admin','Administrator',?,1,1,1,1,1)`).run(password);
}
app.setPath('appData', dataPath);
BrowserWindow.prototype.show = function () {};

app.on('browser-window-created', (_event, window) => {
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.error('RENDERER:', message);
  });
  window.webContents.once('did-finish-load', async () => {
    let failed = false;
    try {
      console.log('SMOKE: loaded');
      window.setSize(1024, 768);
      await new Promise(resolve => setTimeout(resolve, 1500));
      const state = await window.webContents.executeJavaScript(`(() => {
        const logo = document.querySelector('#login img');
        const loader = document.querySelector('.splash img');
        return { loginLoaded: logo.complete && logo.naturalWidth > 0, loaderLoaded: loader.complete && loader.naturalWidth > 0,
          loginSource: logo.getAttribute('src'), loaderSource: loader.getAttribute('src'),
          loginVisible: getComputedStyle(document.querySelector('#login')).display !== 'none',
          background: getComputedStyle(document.body).backgroundImage };
      })()`);
      if (legacy) {
        console.log(JSON.stringify({ state }));
        await window.webContents.executeJavaScript(`(() => {
          const form = document.querySelector('#account');
          form.querySelector('[name=username]').value = 'admin';
          form.querySelector('[name=password]').value = 'admin';
          form.requestSubmit();
        })()`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        const legacyState = await window.webContents.executeJavaScript(`({loginDisplay:getComputedStyle(document.querySelector('#login')).display,dialog:document.querySelector('#NXConfirmValidationInput')?.type || ''})`);
        console.log(JSON.stringify({ legacyState }));
        if (legacyState.dialog !== 'password') throw new Error('Password replacement dialog did not open.');
        await window.webContents.executeJavaScript(`document.querySelector('#NXConfirmValidationInput').value='isolated-new-password-123'; document.querySelector('#NXConfirmButtonOk').click()`);
        await new Promise(resolve => setTimeout(resolve, 500));
        const confirmState = await window.webContents.executeJavaScript(`({dialog:document.querySelector('#NXConfirmValidationInput')?.type || '',title:document.querySelector('#NotiflixConfirmWrap h5')?.textContent || ''})`);
        console.log(JSON.stringify({ confirmState }));
        if (confirmState.dialog !== 'password') throw new Error('Password confirmation dialog did not open.');
        await window.webContents.executeJavaScript(`document.querySelector('#NXConfirmValidationInput').value='isolated-new-password-123'; document.querySelector('#NXConfirmButtonOk').click()`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        const loggedIn = await window.webContents.executeJavaScript(`({loginDisplay:getComputedStyle(document.querySelector('#login')).display,mainDisplay:getComputedStyle(document.querySelector('#main_app')).display})`);
        console.log(JSON.stringify({ loggedIn }));
        if (loggedIn.loginDisplay !== 'none' || loggedIn.mainDisplay === 'none') failed = true;
        return;
      }
      await window.webContents.executeJavaScript(`document.querySelector('.splash').classList.remove('hidden'); document.querySelector('.splash').style.cssText += 'display:flex;opacity:1;animation:none'; document.querySelector('#login').style.display='none';`);
      fs.writeFileSync(path.join(testRoot, 'loader.png'), (await window.webContents.capturePage()).toPNG());
      console.log('SMOKE: loader captured');
      await window.webContents.executeJavaScript(`document.querySelector('.splash').style.display='none'; document.querySelector('#login').style.display='block';`);
      fs.writeFileSync(path.join(testRoot, 'login.png'), (await window.webContents.capturePage()).toPNG());
      console.log('SMOKE: login captured');
      console.log(JSON.stringify({ ...state, screenshots: testRoot }));
      if (!state.loginLoaded || !state.loaderLoaded) failed = true;
      await window.webContents.executeJavaScript(`(() => {
        const form = document.querySelector('#account');
        form.querySelector('[name=username]').value = 'test-owner';
        form.querySelector('[name=password]').value = 'short';
        form.requestSubmit();
      })()`);
      await new Promise(resolve => setTimeout(resolve, 700));
      const rejected = await window.webContents.executeJavaScript(`({button:document.querySelector('#account button').textContent,alert:document.querySelector('.notiflix-report-content')?.textContent || '',loginDisplay:getComputedStyle(document.querySelector('#login')).display})`);
      console.log(JSON.stringify({ rejected }));
      await window.webContents.executeJavaScript(`(() => {
        const form = document.querySelector('#account');
        form.querySelector('[name=username]').value = 'test-owner';
        form.querySelector('[name=password]').value = 'isolated-test-password-123';
        form.requestSubmit();
      })()`);
      await new Promise(resolve => setTimeout(resolve, 3000));
      const login = await window.webContents.executeJavaScript(`({loginDisplay:getComputedStyle(document.querySelector('#login')).display,mainDisplay:getComputedStyle(document.querySelector('#main_app')).display,button:document.querySelector('#account button').textContent})`);
      console.log(JSON.stringify({ login }));
      if (login.loginDisplay !== 'none' || login.mainDisplay === 'none') failed = true;
    } catch (err) { console.error(err); failed = true; }
    finally { app.exit(failed ? 1 : 0); }
  });
});

require('../start');
