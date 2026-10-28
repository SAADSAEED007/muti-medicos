const app = require('express')();
const validator = require('validator');
const { db } = require('./sqlite');

function customer(row) { return row ? { ...JSON.parse(row.data_json), _id: Number(row.id), name: row.name } : null; }
function customerId(value) {
  const id = String(value ?? '');
  if (!/^[0-9]{1,20}$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error('Invalid customer ID.');
  return id;
}
app.get('/', (_req, res) => res.send('Customer API'));
app.get('/all', (_req, res) => {
  try { res.json(db.prepare('SELECT * FROM customers ORDER BY name').all().map(customer)); }
  catch (error) { console.error(error); res.sendStatus(500); }
});
app.get('/customer/:customerId', (req, res) => {
  try { res.json(customer(db.prepare('SELECT * FROM customers WHERE id=?').get(customerId(req.params.customerId)))); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/customer', (req, res) => {
  try {
    const id = customerId(req.body._id);
    const name = validator.escape(String(req.body.name || ''));
    if (!name) return res.sendStatus(400);
    const data = { ...req.body, _id: Number(id), name };
    db.prepare('INSERT INTO customers(id,name,data_json) VALUES (?,?,?)').run(id, name, JSON.stringify(data));
    res.sendStatus(200);
  } catch (error) { res.status(409).json({ error: 'Customer save failed', message: error.message }); }
});
app.put('/customer', (req, res) => {
  try {
    const id = customerId(req.body._id);
    const name = validator.escape(String(req.body.name || ''));
    if (!name) return res.sendStatus(400);
    const data = { ...req.body, _id: Number(id), name };
    res.sendStatus(db.prepare('UPDATE customers SET name=?,data_json=? WHERE id=?').run(name, JSON.stringify(data), id).changes === 1 ? 200 : 404);
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.delete('/customer/:customerId', (req, res) => {
  try { res.sendStatus(db.prepare('DELETE FROM customers WHERE id=?').run(customerId(req.params.customerId)).changes === 1 ? 200 : 404); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
module.exports = app;
