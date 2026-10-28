const app = require('express')();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const validator = require('validator');
const { db, transaction } = require('./sqlite');

const fields = 'id,username,fullname,password,status,perm_products,perm_categories,perm_transactions,perm_users,perm_settings,session_hash,session_expires';
const byId = id => db.prepare(`SELECT ${fields} FROM users WHERE id=?`).get(id);
const byName = name => db.prepare(`SELECT ${fields} FROM users WHERE username=?`).get(name);
const permissions = ['perm_products', 'perm_categories', 'perm_transactions', 'perm_users', 'perm_settings'];
function safeUser(row) {
  if (!row) return null;
  const { id, session_hash, session_expires, password, ...rest } = row;
  return { _id: id, ...rest };
}
function session(row) {
  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare('UPDATE users SET session_hash=?,session_expires=? WHERE id=?')
    .run(hash, Date.now() + 12 * 60 * 60 * 1000, row.id);
  return { ...safeUser(row), auth: true, token };
}
function userId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid user ID.');
  return id;
}

app.authorize = function (req, res, next) {
  const route = req.path;
  if ((route === '/users/check' && req.method === 'GET') ||
      (route === '/users/login' && req.method === 'POST') ||
      (route === '/users/setup' && req.method === 'POST') ||
      (route === '/users/replace-default' && req.method === 'POST')) return next();
  const token = req.get('X-Access-Token') || '';
  if (!/^[a-f0-9]{64}$/.test(token)) return res.sendStatus(401);
  try {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const user = db.prepare(`SELECT ${fields} FROM users WHERE session_hash=? AND session_expires>?`).get(hash, Date.now());
    if (!user) return res.sendStatus(401);
    req.authUser = safeUser(user);
    let permission;
    if ((route.startsWith('/inventory/') || route.startsWith('/suppliers') || route.startsWith('/purchases')) && req.method !== 'GET' && route !== '/inventory/product/sku') permission = 'perm_products';
    else if (route.startsWith('/categories/') && req.method !== 'GET') permission = 'perm_categories';
    else if (route.startsWith('/settings/') && req.method !== 'GET') permission = 'perm_settings';
    else if (route.startsWith('/expenses') && req.method !== 'GET') permission = 'perm_transactions';
    else if (route.startsWith('/ledger/opening-balance') || route.startsWith('/ledger/cashbook/entry')) permission = 'perm_settings';
    else if (route === '/all' || route === '/by-date' || route.startsWith('/ledger/journal') || route.startsWith('/ledger/trial-balance')) permission = 'perm_transactions';
    else if (route === '/users/all' || (route.startsWith('/users/') && req.method === 'DELETE')) permission = 'perm_users';
    if (permission && user[permission] !== 1) return res.sendStatus(403);
    next();
  } catch (error) { console.error(error); res.sendStatus(500); }
};

app.get('/', (_req, res) => res.send('Users API'));
app.get('/check', (_req, res) => {
  try { res.json({ setupRequired: db.prepare('SELECT COUNT(*) AS count FROM users').get().count === 0 }); }
  catch (error) { res.sendStatus(500); }
});
app.post('/setup', async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = req.body.password;
  if (!username || typeof password !== 'string' || password.length < 12) {
    return res.status(400).json({ error: 'Choose a username and a password of at least 12 characters.' });
  }
  try {
    if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count !== 0) return res.sendStatus(403);
    const hash = await bcrypt.hash(password, 10);
    transaction(() => {
      if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count !== 0) throw new Error('Owner already exists.');
      db.prepare(`INSERT INTO users(id,username,fullname,password,perm_products,perm_categories,
        perm_transactions,perm_users,perm_settings) VALUES (1,?,?,?,1,1,1,1,1)`)
        .run(validator.escape(username), 'Owner', hash);
    });
    res.json(session(byId(1)));
  } catch (error) { res.status(409).json({ error: 'Owner setup failed', message: error.message }); }
});
app.post('/login', async (req, res) => {
  if (typeof req.body.username !== 'string' || typeof req.body.password !== 'string') return res.json({ auth: false });
  try {
    const user = byName(validator.escape(req.body.username));
    if (!user || !(await bcrypt.compare(req.body.password, user.password))) return res.json({ auth: false });
    if (user.id === 1 && req.body.password === 'admin') return res.json({ changeRequired: true });
    db.prepare('UPDATE users SET status=? WHERE id=?').run(`Logged In_${new Date()}`, user.id);
    res.json(session(byId(user.id)));
  } catch (error) { console.error(error); res.sendStatus(500); }
});
app.post('/replace-default', async (req, res) => {
  const newPassword = req.body.newPassword;
  if (typeof newPassword !== 'string' || newPassword.length < 12 || newPassword === 'admin') return res.sendStatus(400);
  try {
    const owner = byId(1);
    if (!owner) return res.sendStatus(404);
    if (!(await bcrypt.compare('admin', owner.password)) || !(await bcrypt.compare(req.body.oldPassword || '', owner.password))) return res.sendStatus(403);
    db.prepare('UPDATE users SET password=?,session_hash=NULL,session_expires=0 WHERE id=1').run(await bcrypt.hash(newPassword, 10));
    res.json(session(byId(1)));
  } catch (error) { console.error(error); res.sendStatus(500); }
});
app.get('/all', (_req, res) => {
  try { res.json(db.prepare(`SELECT ${fields} FROM users ORDER BY id`).all().map(safeUser)); }
  catch (error) { console.error(error); res.sendStatus(500); }
});
app.get('/user/:userId', (req, res) => {
  try {
    const user = byId(userId(req.params.userId));
    if (!user) return res.sendStatus(404);
    if (req.authUser._id !== user.id && req.authUser.perm_users !== 1) return res.sendStatus(403);
    res.json(safeUser(user));
  } catch (error) { res.sendStatus(400); }
});
app.get('/logout/:userId', (req, res) => {
  try {
    const id = userId(req.params.userId);
    if (req.authUser._id !== id) return res.sendStatus(403);
    db.prepare('UPDATE users SET status=?,session_hash=NULL,session_expires=0 WHERE id=?').run(`Logged Out_${new Date()}`, id);
    res.sendStatus(200);
  } catch (error) { res.sendStatus(400); }
});
app.delete('/user/:userId', (req, res) => {
  try {
    const id = userId(req.params.userId);
    if (id === 1) return res.status(403).json({ error: 'Owner account cannot be deleted.' });
    res.sendStatus(db.prepare('DELETE FROM users WHERE id=?').run(id).changes === 1 ? 200 : 404);
  } catch (error) { res.sendStatus(400); }
});
app.post('/post', async (req, res) => {
  try {
    const id = req.body.id === '' ? null : userId(req.body.id);
    const manager = req.authUser && req.authUser.perm_users === 1;
    const own = id === req.authUser._id;
    if ((!manager && !own) || (id === 1 && req.authUser._id !== 1)) return res.sendStatus(403);
    const username = validator.escape(String(req.body.username || ''));
    const fullname = validator.escape(String(req.body.fullname || ''));
    const password = String(req.body.password || '');
    if (!username || !fullname) return res.status(400).json({ error: 'Invalid user', message: 'Name and username are required.' });
    if ((!id || password) && password.length < (id === 1 ? 12 : 8)) return res.status(400).json({ error: 'Invalid password', message: 'Use a longer password.' });
    const existing = id ? byId(id) : null;
    if (id && !existing) return res.sendStatus(404);
    const hash = password ? await bcrypt.hash(password, 10) : existing.password;
    const perms = Object.fromEntries(permissions.map(key => [key,
      id === 1 ? 1 : manager ? (req.body[key] === 'on' || req.body[key] === 1 ? 1 : 0) : existing[key]]));
    if (!id) {
      const result = db.prepare(`INSERT INTO users(username,fullname,password,perm_products,perm_categories,
        perm_transactions,perm_users,perm_settings) VALUES (?,?,?,?,?,?,?,?)`).run(
          username, fullname, hash, ...permissions.map(key => perms[key]));
      return res.json(safeUser(byId(Number(result.lastInsertRowid))));
    }
    db.prepare(`UPDATE users SET username=?,fullname=?,password=?,perm_products=?,perm_categories=?,
      perm_transactions=?,perm_users=?,perm_settings=?,session_hash=?,session_expires=? WHERE id=?`).run(
        username, fullname, hash, ...permissions.map(key => perms[key]),
        password ? null : existing.session_hash, password ? 0 : existing.session_expires, id);
    res.sendStatus(200);
  } catch (error) {
    if (/UNIQUE constraint failed/.test(error.message)) return res.status(409).json({ error: 'Username already exists.' });
    console.error(error);
    res.status(500).json({ error: 'User save failed', message: 'User was not saved.' });
  }
});

module.exports = app;
