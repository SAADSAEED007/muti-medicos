const app = require('express')();
const validator = require('validator');
const { db } = require('./sqlite');

function category(row) { return row ? { ...JSON.parse(row.data_json), _id: row.id, name: row.name } : null; }
function id(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error('Invalid category ID.');
  return result;
}
app.get('/', (_req, res) => res.send('Category API'));
app.get('/all', (_req, res) => {
  try { res.json(db.prepare('SELECT * FROM categories ORDER BY name').all().map(category)); }
  catch (error) { console.error(error); res.sendStatus(500); }
});
app.post('/category', (req, res) => {
  try {
    const name = validator.escape(String(req.body.name || ''));
    if (!name) return res.sendStatus(400);
    const data = { ...req.body, name };
    db.prepare('INSERT INTO categories(name,data_json) VALUES (?,?)').run(name, JSON.stringify(data));
    res.sendStatus(200);
  } catch (error) { console.error(error); res.sendStatus(500); }
});
app.put('/category', (req, res) => {
  try {
    const key = id(req.body.id);
    const name = validator.escape(String(req.body.name || ''));
    if (!name) return res.sendStatus(400);
    const data = { ...req.body, _id: key, name };
    res.sendStatus(db.prepare('UPDATE categories SET name=?,data_json=? WHERE id=?').run(name, JSON.stringify(data), key).changes === 1 ? 200 : 404);
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.delete('/category/:categoryId', (req, res) => {
  try { res.sendStatus(db.prepare('DELETE FROM categories WHERE id=?').run(id(req.params.categoryId)).changes === 1 ? 200 : 404); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
module.exports = app;
