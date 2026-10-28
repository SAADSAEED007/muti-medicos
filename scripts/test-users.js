const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmaspot-users-test-'));
process.env.APPDATA = root;
process.env.APPNAME = 'PharmaSpotTest';
fs.mkdirSync(path.join(root, process.env.APPNAME, 'server', 'databases'), { recursive: true });
const app = require('express')();
app.use(require('express').json());
const usersApi = require('../api/users');
app.use('/api', usersApi.authorize);
app.use('/api/users', usersApi);
const server = app.listen(0, '127.0.0.1');

async function request(route, method = 'GET', body, token) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
    method, body: body && JSON.stringify(body), headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { 'X-Access-Token': token } : {}) },
  });
  const text = await response.text();
  return { status: response.status, data: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text };
}

async function main() {
  try {
    if (!server.listening) await once(server, 'listening');
    assert.equal((await request('/users/check')).data.setupRequired, true);
    assert.equal((await request('/users/all')).status, 401);
    assert.equal((await request('/users/setup', 'POST', { username: 'owner', password: 'short' })).status, 400);
    const setup = await request('/users/setup', 'POST', { username: 'owner', password: 'secure-owner-pass-123' });
    assert.equal(setup.status, 200);
    let ownerToken = setup.data.token;
    assert.equal((await request('/users/check')).data.setupRequired, false);
    assert.equal((await request('/users/setup', 'POST', { username: 'intruder', password: 'secure-password-123' })).status, 403);
    assert.equal((await request('/users/login', 'POST', { username: 'owner', password: 'wrong' })).data.auth, false);
    const ownerLogin = (await request('/users/login', 'POST', { username: 'owner', password: 'secure-owner-pass-123' })).data;
    assert.equal(ownerLogin.auth, true);
    ownerToken = ownerLogin.token;
    assert.equal('password' in setup.data, false);
    assert.equal((await request('/users/all', 'GET', null, ownerToken)).data.some(user => 'password' in user), false);
    assert.equal((await request('/users/post', 'POST', { id: '', username: 'staff', fullname: 'Staff', password: 'short' }, ownerToken)).status, 400);
    const created = await request('/users/post', 'POST', { id: '', username: 'staff', fullname: 'Staff', password: 'secure-pass-123' }, ownerToken);
    assert.equal(created.status, 200);
    assert.equal('password' in created.data, false);
    const staff = (await request('/users/login', 'POST', { username: 'staff', password: 'secure-pass-123' })).data;
    assert.equal(staff.auth, true);
    assert.equal((await request('/inventory/products')).status, 401);
    assert.equal((await request('/inventory/product', 'POST', {}, staff.token)).status, 403);
    assert.equal((await request('/settings/post', 'POST', {}, staff.token)).status, 403);
    assert.equal((await request('/all', 'GET', null, staff.token)).status, 403);
    assert.equal((await request('/users/all', 'GET', null, staff.token)).status, 403);
    assert.equal((await request('/users/post', 'POST', { id: '', username: 'intruder', fullname: 'Intruder', password: 'secure-pass-123' }, staff.token)).status, 403);
    assert.equal((await request('/users/post', 'POST', { id: String(created.data._id), username: 'staff', fullname: 'Staff Updated', password: '', perm_products: 'on' }, staff.token)).status, 200);
    assert.equal((await request(`/users/user/${created.data._id}`, 'GET', null, staff.token)).data.perm_products, 0);
    assert.equal((await request(`/users/logout/${created.data._id}`, 'GET', null, staff.token)).status, 200);
    assert.equal((await request('/users/all', 'GET', null, staff.token)).status, 401);
    console.log('Owner setup, login, logout, user edits and role enforcement sample tests passed.');
  } finally {
    server.close();
    require('../api/sqlite').db.close();
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'pharmaspot-users-test-')) fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
