const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

async function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    }).on('error', reject);
  });
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function run() {
  const electronExe = require('electron');
  const asarPath = path.resolve(__dirname, '..', 'out', 'Multi Medicos-win32-x64', 'resources', 'app.asar');
  const packagedExe = process.env.PACKAGED_EXE ? path.resolve(process.env.PACKAGED_EXE) : '';
  if (!fs.existsSync(asarPath)) {
    throw new Error(`Packaged app.asar not found at: ${asarPath}`);
  }

  const testAppData = path.resolve(__dirname, '..', 'temp_pkg_test_appdata');
  if (fs.existsSync(testAppData)) {
    fs.rmSync(testAppData, { recursive: true, force: true });
  }
  fs.mkdirSync(testAppData, { recursive: true });

  const testPort = '43299';
  if (packagedExe && !fs.existsSync(packagedExe)) throw new Error(`Packaged executable not found: ${packagedExe}`);
  const launchExecutable = packagedExe || electronExe;
  const launchArguments = packagedExe ? [] : [asarPath];
  console.log(`Testing packaged application: ${packagedExe || asarPath}`);
  console.log(`Port: ${testPort}`);
  console.log(`Isolated APPDATA: ${testAppData}`);

  const env = {
    ...process.env,
    APPDATA: testAppData,
    TEST_APPDATA: testAppData,
    PORT: testPort,
    ELECTRON_ENABLE_LOGGING: '1'
  };
  delete env.ELECTRON_RUN_AS_NODE;

  let child = spawn(launchExecutable, launchArguments, {
    env,
    stdio: 'ignore'
  });

  child.on('error', (err) => {
    console.error('Child error:', err);
  });

  // Poll for API
  console.log(`Polling http://127.0.0.1:${testPort}/ ...`);
  let isOnline = false;
  for (let i = 0; i < 30; i++) {
    await wait(1000);
    try {
      const res = await httpGet(`http://127.0.0.1:${testPort}/`);
      if (res.status === 200 && res.raw && res.raw.includes('POS Server Online')) {
        isOnline = true;
        break;
      }
    } catch {}
  }

  if (!isOnline) {
    try {
      const { execSync } = require('child_process');
      execSync(`taskkill /pid ${child.pid} /f /t`, { stdio: 'ignore' });
    } catch {}
    throw new Error(`Packaged app.asar failed to respond on port ${testPort}`);
  }

  console.log('Packaged app.asar HTTP server online!');

  // Verify /api/users/check returns setupRequired: true
  const checkRes = await httpGet(`http://127.0.0.1:${testPort}/api/users/check`);
  console.log('GET /api/users/check:', checkRes);
  if (checkRes.status !== 200 || !checkRes.data.setupRequired) {
    throw new Error('Expected setupRequired: true');
  }

  // Create Owner Account via /api/users/setup
  console.log('Setting up owner account...');
  const setupRes = await httpPost(`http://127.0.0.1:${testPort}/api/users/setup`, {
    username: 'admin',
    password: 'Password12345!'
  });
  console.log('POST /api/users/setup status:', setupRes.status);
  if (setupRes.status !== 200 || !setupRes.data.token) {
    throw new Error('Owner setup failed');
  }

  const token = setupRes.data.token;
  const headers = {
    'X-Access-Token': token,
    'X-Key': 'admin'
  };

  // Test enterprise endpoints
  const supRes = await httpGet(`http://127.0.0.1:${testPort}/api/suppliers/all`, headers);
  console.log('GET /api/suppliers/all status:', supRes.status, 'records:', supRes.data.length);

  const purRes = await httpGet(`http://127.0.0.1:${testPort}/api/purchases/all`, headers);
  console.log('GET /api/purchases/all status:', purRes.status, 'records:', purRes.data.length);

  const dashRes = await httpGet(`http://127.0.0.1:${testPort}/api/ledger/dashboard-summary`, headers);
  console.log('GET /api/ledger/dashboard-summary status:', dashRes.status, 'data:', dashRes.data);

  const expRes = await httpGet(`http://127.0.0.1:${testPort}/api/expenses/all`, headers);
  console.log('GET /api/expenses/all status:', expRes.status, 'records:', expRes.data.length);

  // Verify SQLite database created on disk
  const dbFile = path.join(testAppData, 'PharmaSpot', 'server', 'databases', 'pharmacy.sqlite');
  if (!fs.existsSync(dbFile)) {
    throw new Error(`Database file missing at: ${dbFile}`);
  }
  const dbStat = fs.statSync(dbFile);
  console.log(`Verified SQLite database created under test APPDATA: ${dbFile} (${dbStat.size} bytes)`);

  // Terminate and relaunch to verify that the installed-style executable reads
  // the same SQLite data after a complete process restart.
  console.log('Restarting packaged app to verify persistence...');
  try {
    const { execSync } = require('child_process');
    execSync(`taskkill /pid ${child.pid} /f /t`, { stdio: 'ignore' });
  } catch {}
  await wait(2000);

  child = spawn(launchExecutable, launchArguments, { env, stdio: 'ignore' });
  let restarted = false;
  for (let i = 0; i < 30; i++) {
    await wait(1000);
    try {
      const res = await httpGet(`http://127.0.0.1:${testPort}/api/users/check`);
      if (res.status === 200 && res.data && res.data.setupRequired === false) {
        restarted = true;
        break;
      }
    } catch {}
  }
  try {
    const { execSync } = require('child_process');
    execSync(`taskkill /pid ${child.pid} /f /t`, { stdio: 'ignore' });
  } catch {}
  if (!restarted) throw new Error('Packaged application did not preserve the owner/database after restart.');
  console.log('Packaged application restart persistence verified.');
  await wait(1000);

  // Clean test directory
  try {
    fs.rmSync(testAppData, { recursive: true, force: true });
  } catch (e) {
    console.log('Deferred test AppData cleanup:', e.message);
  }

  console.log('\n============================================================');
  console.log('PACKAGED APP.ASAR + SQLITE + API VERIFICATION PASSED 100%!');
  console.log('============================================================\n');
}

run().catch((err) => {
  console.error('\nPACKAGED ASAR VERIFICATION FAILED:', err);
  process.exit(1);
});
