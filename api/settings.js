const app = require('express')();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const validator = require('validator');
const sanitizeFilename = require('sanitize-filename');
const { filterFile } = require('../assets/js/utils');
const { db } = require('./sqlite');

const uploads = path.join(process.env.APPDATA, process.env.APPNAME, 'uploads');
fs.mkdirSync(uploads, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({ destination: uploads, filename: (_req, file, done) => done(null, `logo${path.extname(file.originalname)}`) }),
  limits: { fileSize: 2097152 }, fileFilter: filterFile,
}).single('imagename');

app.get('/', (_req, res) => res.send('Settings API'));
app.get('/get', (_req, res) => {
  try {
    const row = db.prepare('SELECT data_json FROM settings WHERE id=1').get();
    res.json(row ? { _id: 1, settings: JSON.parse(row.data_json) } : { settings: null });
  } catch (error) { console.error(error); res.sendStatus(500); }
});
app.post('/post', (req, res) => upload(req, res, error => {
  if (error) return res.status(400).json({ error: 'Upload Error', message: error.message });
  try {
    const body = req.body;
    let image = req.file ? sanitizeFilename(req.file.filename) : sanitizeFilename(body.img || '');
    if (body.remove === '1' && !req.file) image = '';
    const clean = value => validator.escape(String(value || ''));
    const settings = {
      app: clean(body.app), store: clean(body.store), address_one: clean(body.address_one),
      address_two: clean(body.address_two), contact: clean(body.contact), tax: clean(body.tax),
      symbol: clean(body.symbol), percentage: clean(body.percentage),
      charge_tax: body.charge_tax === 'on', quick_billing: body.quick_billing === 'on',
      footer: clean(body.footer), img: image,
    };
    if (!settings.store || !settings.symbol) return res.status(400).json({ error: 'Invalid settings', message: 'Store and currency are required.' });
    db.prepare(`INSERT INTO settings(id,data_json) VALUES (1,?)
      ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json`).run(JSON.stringify(settings));
    res.sendStatus(200);
  } catch (saveError) {
    console.error(saveError);
    res.status(500).json({ error: 'Settings save failed', message: 'Settings were not saved.' });
  }
}));
module.exports = app;
