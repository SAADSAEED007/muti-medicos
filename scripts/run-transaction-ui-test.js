const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const electron = require('electron');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmaspot-transaction-ui-'));
const testAppData = path.join(root, 'appData');
fs.mkdirSync(testAppData, { recursive: true });

function runPhase(phase, port) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      TEST_APPDATA: testAppData,
      UI_TEST_PHASE: phase,
      PORT: String(port),
      PHARMASPOT_DISABLE_RELOADER: '1'
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [path.join(__dirname, 'electron-transaction-history.js')], {
      env,
      stdio: 'inherit',
      windowsHide: false
    });
    const timer = setTimeout(() => child.kill(), 100000);
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Electron ${phase} phase exited with code ${code}`));
    });
  });
}

(async () => {
  await runPhase('create', 43220);
  await runPhase('restart', 43221);
  console.log(`ELECTRON TRANSACTION UI TEST PASSED; isolated artifacts: ${root}`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
