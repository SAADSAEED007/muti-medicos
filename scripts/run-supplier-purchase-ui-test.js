const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const electron = require('electron');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmaspot-supplier-purchase-ui-'));
const testAppData = path.join(root, 'appData');
fs.mkdirSync(testAppData, { recursive: true });

function run(phase, port) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env, TEST_APPDATA: testAppData, UI_TEST_PHASE: phase, PORT: String(port),
      PHARMASPOT_DISABLE_RELOADER: '1'
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [path.join(__dirname, 'electron-supplier-purchase.js')], {
      env, stdio: 'inherit', windowsHide: true
    });
    const timeout = setTimeout(() => child.kill(), 100000);
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Electron supplier/purchase ${phase} phase exited with code ${code}`));
    });
  });
}

(async () => {
  await run('create', 43230);
  await run('restart', 43231);
  console.log(`ELECTRON SUPPLIER/PURCHASE UI TEST PASSED; isolated artifacts: ${root}`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
