const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const bcrypt = require('bcrypt');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmaspot-default-test-'));
process.env.APPDATA = root;
process.env.APPNAME = 'PharmaSpotTest';
const dataDir = path.join(root, process.env.APPNAME, 'server', 'databases');
fs.mkdirSync(dataDir, { recursive: true });

async function main() {
  const password = await bcrypt.hash('admin', 10);
  const db = require('../api/sqlite').db;
  db.prepare(`INSERT INTO users(id,username,fullname,password,perm_users,perm_products,perm_transactions,perm_categories,perm_settings)
    VALUES (1,'admin','Administrator',?,1,1,1,1,1)`).run(password);
  const usersApi = require('../api/users');
  const app = require('express')();
  app.use(require('express').json());
  app.use('/api', usersApi.authorize);
  app.use('/api/users', usersApi);
  const server = app.listen(0, '127.0.0.1');
  try {
    if (!server.listening) await once(server, 'listening');
    const request = async (route, body) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/users${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const text = await response.text();
      return { status: response.status, data: text.startsWith('{') ? JSON.parse(text) : text };
    };
    assert.equal((await request('/login', { username: 'admin', password: 'admin' })).data.changeRequired, true);
    assert.equal((await request('/replace-default', { oldPassword: 'admin', newPassword: 'short' })).status, 400);
    const changed = await request('/replace-default', { oldPassword: 'admin', newPassword: 'new-owner-password-123' });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.auth, true);
    assert.equal((await request('/login', { username: 'admin', password: 'admin' })).data.auth, false);
    assert.equal((await request('/login', { username: 'admin', password: 'new-owner-password-123' })).data.auth, true);
    console.log('Legacy default password replacement sample test passed.');
  } finally {
    server.close();
    db.close();
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'pharmaspot-default-test-')) fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
