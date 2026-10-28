const path = require('path');
const { spawn } = require('child_process');

const electron = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.PORT = '43288';

const runner = path.join(__dirname, 'electron-ui-runner.js');
const child = spawn(electron, [runner], {
  env,
  stdio: 'inherit',
  windowsHide: true,
});

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error('UI verification test timed out');
  child.kill();
}, 45000);

child.on('error', error => {
  clearTimeout(timer);
  console.error(error);
  process.exitCode = 1;
});

child.on('exit', code => {
  clearTimeout(timer);
  process.exitCode = timedOut ? 1 : (code ?? 1);
});
