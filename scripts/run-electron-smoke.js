const path = require('path');
const { spawn } = require('child_process');

const electron = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.PORT = '43210';

const child = spawn(electron, [path.join(__dirname, 'electron-smoke.js'), ...process.argv.slice(2)], {
  env,
  stdio: 'inherit',
  windowsHide: true,
});

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error('Electron smoke test timed out');
  child.kill();
}, 30000);

child.on('error', error => {
  clearTimeout(timer);
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', code => {
  clearTimeout(timer);
  process.exitCode = timedOut ? 1 : (code ?? 1);
});
