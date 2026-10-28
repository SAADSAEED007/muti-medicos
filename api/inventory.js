const app = require('express')();
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const multer = require('multer');
const validator = require('validator');
const sanitizeFilename = require('sanitize-filename');
const { filterFile } = require('../assets/js/utils');
const { db, transaction, cents } = require('./sqlite');

const uploads = path.join(process.env.APPDATA, process.env.APPNAME, 'uploads');
fs.mkdirSync(uploads, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({ destination: uploads, filename: (_req, file, done) => done(null, `${Date.now()}${path.extname(file.originalname)}`) }),
  limits: { fileSize: 2097152 }, fileFilter: filterFile,
}).single('imagename');

const productQuery = `SELECT p.id AS _id, p.barcode, p.name, p.price_cents, p.expiration_date,
  p.category, p.supplier, p.stock_tracked AS stock, p.min_stock AS minStock,
  p.img, i.quantity FROM products p JOIN inventory i ON i.product_id = p.id`;
function product(row) {
  if (!row) return null;
  return { _id: row._id, barcode: row.barcode, name: row.name,
    price: (row.price_cents / 100).toFixed(2), expirationDate: row.expiration_date,
    category: row.category, supplier: row.supplier, stock: row.stock,
    minStock: row.minStock, img: row.img, quantity: row.quantity };
}
function byId(id) { return product(db.prepare(`${productQuery} WHERE p.id = ?`).get(id)); }
function validId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid product ID.');
  return id;
}

app.get('/', (_req, res) => res.send('Inventory API'));
app.get('/products', (_req, res) => {
  try { res.json(db.prepare(productQuery).all().map(product)); }
  catch (error) { console.error(error); res.sendStatus(500); }
});
app.get('/product/:productId', (req, res) => {
  try { res.json(byId(validId(req.params.productId))); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/product/sku', (req, res) => {
  const barcode = Number(req.body.skuCode);
  if (!Number.isSafeInteger(barcode)) return res.json({});
  try { res.json(product(db.prepare(`${productQuery} WHERE p.barcode = ?`).get(barcode)) || {}); }
  catch (error) { console.error(error); res.sendStatus(500); }
});

app.post('/product', (req, res) => upload(req, res, error => {
  if (error) return res.status(400).json({ error: 'Upload Error', message: error.message });
  try {
    const body = req.body;
    const id = body.id === '' || body.id == null ? null : validId(body.id);
    const barcodeInput = String(body.barcode ?? '').trim();
    const barcode = barcodeInput === '' ? null : Number(barcodeInput);
    const quantity = body.quantity === '' ? 0 : Number(body.quantity);
    const minStock = Number(body.minStock || 0);
    const priceCents = cents(body.price);
    if ((barcode !== null && (!Number.isSafeInteger(barcode) || barcode < 0)) || !Number.isSafeInteger(quantity) || quantity < 0 ||
        !Number.isSafeInteger(minStock) || minStock < 0 || !body.name) {
      return res.status(400).json({ error: 'Invalid product', message: 'Barcode, price and stock must be valid non-negative numbers.' });
    }
    if (!id && body.quick_add === '1') {
      const sameName = db.prepare('SELECT id FROM products WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))').get(String(body.name));
      if (sameName) {
        return res.status(409).json({ error: 'Medicine already exists', message: 'A medicine with this exact name is already registered. Select it from the purchase search.' });
      }
    }
    const existing = id ? byId(id) : null;
    if (id && !existing) return res.sendStatus(404);
    let image = req.file ? sanitizeFilename(req.file.filename) : sanitizeFilename(body.img || '');
    if (body.remove === '1' && !req.file) image = '';
    const fields = {
      barcode, name: validator.escape(String(body.name)), priceCents,
      expirationDate: validator.escape(String(body.expirationDate || '')),
      category: validator.escape(String(body.category || '')),
      supplier: validator.escape(String(body.supplier || '')),
      stock: body.stock === 'on' ? 0 : 1, minStock, image, quantity,
    };
    let savedProductId = id;
    transaction(() => {
      let productId = id;
      const savedBarcode = barcode === null
        ? Number(db.prepare('SELECT COALESCE(MAX(barcode), 1000000000) + 1 AS barcode FROM products').get().barcode)
        : barcode;
      if (id) {
        db.prepare(`UPDATE products SET barcode=?, name=?, price_cents=?, expiration_date=?, category=?,
          supplier=?, stock_tracked=?, min_stock=?, img=? WHERE id=?`).run(
          savedBarcode, fields.name, fields.priceCents, fields.expirationDate, fields.category,
          fields.supplier, fields.stock, fields.minStock, fields.image, id);
        db.prepare('UPDATE inventory SET quantity=? WHERE product_id=?').run(quantity, id);
      } else {
        productId = Number(db.prepare(`INSERT INTO products
          (barcode,name,price_cents,expiration_date,category,supplier,stock_tracked,min_stock,img)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(savedBarcode, fields.name, fields.priceCents,
          fields.expirationDate, fields.category, fields.supplier, fields.stock, fields.minStock, fields.image).lastInsertRowid);
        db.prepare('INSERT INTO inventory(product_id,quantity) VALUES (?,?)').run(productId, quantity);
      }
      savedProductId = productId;
      if (!existing || Number(existing.quantity) !== quantity) {
        db.prepare(`INSERT INTO stock_adjustments(product_id,before_quantity,after_quantity,reason)
          VALUES (?,?,?,?)`).run(productId, existing ? Number(existing.quantity) : 0, quantity, id ? 'Product edit' : 'Initial stock');
      }
    });
    if (body.remove === '1' && existing && existing.img && !req.file) {
      const oldFile = path.join(uploads, sanitizeFilename(existing.img));
      try { fs.unlinkSync(oldFile); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') console.error(unlinkError); }
    }
    res.status(200).json({ id: savedProductId, product: byId(savedProductId) });
  } catch (error) {
    if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(error.message)) {
      return res.status(409).json({ error: 'Duplicate barcode', message: 'A product with this barcode already exists.' });
    }
    if (/Invalid|non-negative|Money/.test(error.message)) return res.status(400).json({ error: 'Invalid product', message: error.message });
    console.error(error);
    res.status(500).json({ error: 'Product save failed', message: 'Product was not saved.' });
  }
}));

app.delete('/product/:productId', (req, res) => {
  try {
    const id = validId(req.params.productId);
    transaction(() => {
      db.prepare('DELETE FROM stock_adjustments WHERE product_id=?').run(id);
      db.prepare('DELETE FROM inventory WHERE product_id=?').run(id);
      if (db.prepare('DELETE FROM products WHERE id=?').run(id).changes !== 1) throw new Error('Product not found.');
    });
    res.sendStatus(200);
  } catch (error) {
    res.status(/FOREIGN KEY constraint/.test(error.message) ? 409 : 400).json({ error: 'Product delete failed', message: error.message });
  }
});

// Used inside the same SQLite transaction as the sale and its item records.
app.validateBasket = function (items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('Sale has no items.');
  const quantities = new Map();
  const lines = [];
  for (const item of items) {
    const id = validId(item.id);
    const quantity = Number(item.quantity);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('Invalid sale quantity.');
    const current = byId(id);
    if (!current) throw new Error(`Product ${id} does not exist.`);
    if (cents(item.price) !== cents(current.price)) throw new Error(`Price changed for ${current.name}. Refresh the basket.`);
    const expiry = moment.utc(current.expirationDate, 'DD-MMM-YYYY', true).utcOffset(300, true);
    if (!expiry.isValid() || expiry.isSameOrBefore(moment().utcOffset(300), 'day')) {
      throw new Error(`${current.name} is expired or has an invalid expiry date.`);
    }
    quantities.set(id, (quantities.get(id) || 0) + quantity);
    lines.push({ id, quantity, productName: current.name, priceCents: cents(current.price) });
  }
  for (const [id, quantity] of quantities) {
    const current = byId(id);
    if (current.stock === 1 && Number(current.quantity) < quantity) throw new Error(`Insufficient stock for ${current.name}.`);
  }
  return { quantities, lines };
};

app.deductBasket = function (quantities) {
  let index = 0;
  for (const [id, quantity] of quantities) {
    const current = byId(id);
    if (current.stock !== 1) continue;
    const result = db.prepare('UPDATE inventory SET quantity=quantity-? WHERE product_id=? AND quantity>=?').run(quantity, id, quantity);
    if (result.changes !== 1) throw new Error(`Insufficient stock for ${current.name}.`);

    // FEFO batch deduction (First Expired First Out)
    const batches = db.prepare('SELECT * FROM inventory_batches WHERE product_id = ? AND quantity_available > 0 ORDER BY expiry_date ASC, id ASC').all(id);
    let remaining = quantity;
    for (const b of batches) {
      if (remaining <= 0) break;
      const take = Math.min(b.quantity_available, remaining);
      db.prepare('UPDATE inventory_batches SET quantity_available = quantity_available - ? WHERE id = ?').run(take, b.id);
      remaining -= take;
    }

    if (++index === 1 && process.env.APPNAME === 'PharmaSpotTest' &&
        process.env.PHARMASPOT_TEST_SALE_FAILPOINT === 'after_first_stock') process.kill(process.pid, 'SIGKILL');
  }
};

module.exports = app;
