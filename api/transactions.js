const app = require('express')();
const crypto = require('crypto');
const Inventory = require('./inventory');
const { db, transaction, cents, pkr, extractCustomerId } = require('./sqlite');

function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function saleId(value) {
  const id = String(value ?? '');
  if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) throw new Error('Invalid sale ID.');
  return id;
}
function document(row) {
  if (!row) return null;
  const sale = JSON.parse(row.data_json);
  if (row.id == null) return sale;

  const totalCents = Number(row.total_cents || 0);
  const paidCents = Math.min(Number(row.paid_cents || 0), totalCents);
  const outstandingCents = Math.max(totalCents - paidCents, 0);
  let paymentType = sale.payment_type || 'Cash';
  if (row.status === 1 && outstandingCents > 0) {
    paymentType = paidCents > 0 ? 'Mixed' : 'Credit';
  }

  return {
    ...sale,
    _id: sale._id || row.id,
    order: sale.order || row.id,
    status: row.status,
    date: row.date,
    user_id: row.user_id == null ? sale.user_id : row.user_id,
    user: sale.user || row.user_name || (row.user_id == null ? 'Unknown' : `User ${row.user_id}`),
    total: pkr(totalCents),
    paid_amount: pkr(paidCents),
    outstanding: pkr(outstandingCents),
    payment_type: paymentType
  };
}
function find(id) { return db.prepare('SELECT * FROM sales WHERE id=?').get(id); }
const { postJournalEntry, recordCashbookEntry, getCustomerReceivableFromJournal } = require('./accounting');

function dateBoundary(value, endOfDay) {
  const text = String(value || '').trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const date = dateOnly
    ? new Date(`${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+05:00`)
    : new Date(text);
  return Number.isFinite(date.getTime()) ? date : null;
}

function paidAmounts(sale) {
  const discount = cents(sale.discount || 0);
  const tax = cents(sale.tax || 0);
  const total = cents(sale.total);
  const paid = cents(sale.paid || 0);
  if (!Array.isArray(sale.items) || sale.items.length === 0) throw new Error('Sale has no items.');
  const linesTotal = sale.items.reduce((sum, item) => {
    const quantity = Number(item.quantity);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('Invalid sale quantity.');
    return sum + cents(item.price) * quantity;
  }, 0);
  if (!Number.isSafeInteger(linesTotal) || discount > linesTotal || total !== linesTotal - discount + tax) {
    throw new Error('Sale totals or payment are invalid.');
  }

  const custId = extractCustomerId(sale.customer);
  const hasCustomer = !!custId;
  if (paid < total && !hasCustomer) {
    throw new Error('Customer must be selected for credit or partial payment sales.');
  }

  const actualPaid = Math.min(paid, total);
  const receivable = total - actualPaid;

  // If customer has a credit limit, check it
  if (receivable > 0 && hasCustomer) {
    const cust = db.prepare('SELECT credit_limit_cents FROM customers WHERE id = ?').get(custId);
    if (cust && cust.credit_limit_cents > 0) {
      const currentReceivable = getCustomerReceivableFromJournal(custId);
      if (currentReceivable + receivable > cust.credit_limit_cents) {
        throw new Error(`Customer credit limit exceeded. Max credit allowed: PKR ${(cust.credit_limit_cents / 100).toFixed(2)}, current outstanding: PKR ${(currentReceivable / 100).toFixed(2)}.`);
      }
    }
  }

  return { total, paid: actualPaid, receivable, customerId: custId };
}

function failpoint(name) {
  if (process.env.APPNAME === 'PharmaSpotTest' && process.env.PHARMASPOT_TEST_SALE_FAILPOINT === name) {
    process.kill(process.pid, 'SIGKILL');
  }
}

function savePaid(req, res, updating) {
  const sale = req.body;
  let id, amounts;
  try { id = saleId(sale._id); amounts = paidAmounts(sale); }
  catch (error) { return res.status(400).json({ error: 'Invalid sale', message: error.message }); }
  const payloadHash = hash(sale);
  try {
    const result = transaction(() => {
      const existing = find(id);
      if (existing && existing.status === 1) {
        if (existing.payload_hash === payloadHash) return 'duplicate';
        throw new Error('Sale ID already belongs to another completed sale.');
      }
      if (updating && (!existing || existing.status !== 0)) throw new Error('Held order is no longer available.');
      if (!updating && existing) throw new Error('Sale ID already exists.');
      failpoint('before_validation');
      const basket = Inventory.validateBasket(sale.items);
      const date = new Date(sale.date || Date.now());
      if (!Number.isFinite(date.getTime())) throw new Error('Invalid sale date.');
      const saved = { ...sale, _id: sale._id, status: 1 };
      const json = JSON.stringify(saved);
      if (updating) {
        db.prepare(`UPDATE sales SET status=1,date=?,user_id=?,total_cents=?,paid_cents=?,payload_hash=?,data_json=?
          WHERE id=? AND status=0`).run(date.toISOString(), Number(sale.user_id) || null,
          amounts.total, amounts.paid, payloadHash, json, id);
      } else {
        db.prepare(`INSERT INTO sales(id,status,date,user_id,total_cents,paid_cents,payload_hash,data_json)
          VALUES (?,1,?,?,?,?,?,?)`).run(id, date.toISOString(), Number(sale.user_id) || null,
          amounts.total, amounts.paid, payloadHash, json);
      }
      failpoint('after_sale');
      basket.lines.forEach((line, index) => {
        db.prepare(`INSERT INTO sale_items(sale_id,line_no,product_id,product_name,quantity,unit_price_cents)
          VALUES (?,?,?,?,?,?)`).run(id, index, line.id, line.productName, line.quantity, line.priceCents);
        if (index === 0) failpoint('after_first_item');
      });
      Inventory.deductBasket(basket.quantities);
      failpoint('after_stock');

      // Double-entry accounting posting
      const journalLines = [];
      if (amounts.paid > 0) {
        journalLines.push({
          accountId: 1010, // Cash
          debitCents: amounts.paid,
          creditCents: 0,
          lineDescription: `Cash received for Sale #${id}`
        });
      }
      if (amounts.receivable > 0) {
        journalLines.push({
          accountId: 1100, // Accounts Receivable
          debitCents: amounts.receivable,
          creditCents: 0,
          partyType: 'customer',
          partyId: amounts.customerId,
          lineDescription: `Khata credit for Sale #${id}`
        });
      }
      journalLines.push({
        accountId: 4010, // Sales Revenue
        debitCents: 0,
        creditCents: amounts.total,
        lineDescription: `Sales revenue for Sale #${id}`
      });

      postJournalEntry({
        entryDate: date.toISOString(),
        referenceType: amounts.receivable > 0 ? 'CREDIT_SALE' : 'SALE',
        referenceId: String(id),
        description: `Sale #${id}${amounts.receivable > 0 ? ' (Credit/Mixed)' : ''}`,
        userId: Number(sale.user_id) || null,
        lines: journalLines
      });

      // Cashbook entry for cash collected
      if (amounts.paid > 0) {
        recordCashbookEntry({
          entryDate: date.toISOString(),
          entryType: 'CASH_SALE',
          inflowCents: amounts.paid,
          outflowCents: 0,
          referenceType: 'SALE',
          referenceId: String(id),
          description: `Cash sale #${id}`,
          userId: Number(sale.user_id) || null
        });
      }

      failpoint('before_commit');
      return 'saved';
    });
    res.sendStatus(200);
  } catch (error) {
    if (/Sale ID|Held order|Insufficient stock|Price changed|expired|does not exist|Invalid sale quantity|credit limit/.test(error.message)) {
      return res.status(409).json({ error: 'Sale rejected', message: error.message });
    }
    console.error('Sale transaction failed:', error);
    res.status(500).json({ error: 'Sale failed', message: 'Nothing was charged to stock. Check the sale list before retrying.' });
  }
}

app.get('/', (_req, res) => res.send('Transactions API'));
app.get('/all', (_req, res) => {
  try { res.json(db.prepare('SELECT s.*, u.fullname AS user_name FROM sales s LEFT JOIN users u ON u.id=s.user_id ORDER BY s.date DESC').all().map(document)); }
  catch (error) { console.error(error); res.sendStatus(500); }
});
app.get('/on-hold', (_req, res) => {
  try { res.json(db.prepare('SELECT s.*, u.fullname AS user_name FROM sales s LEFT JOIN users u ON u.id=s.user_id WHERE s.status=0').all().map(document).filter(row => row.ref_number !== '')); }
  catch (error) { console.error(error); res.sendStatus(500); }
});
app.get('/customer-orders', (_req, res) => {
  try { res.json(db.prepare('SELECT s.*, u.fullname AS user_name FROM sales s LEFT JOIN users u ON u.id=s.user_id WHERE s.status=0').all().map(document).filter(row => row.customer !== '0' && row.ref_number === '')); }
  catch (error) { console.error(error); res.sendStatus(500); }
});
app.get('/by-date', (req, res) => {
  const start = dateBoundary(req.query.start, false);
  const end = dateBoundary(req.query.end, true);
  const status = Number(req.query.status);
  if (!start || !end || start > end || ![0, 1].includes(status)) return res.sendStatus(400);
  try {
    let rows = db.prepare(`SELECT s.*, u.fullname AS user_name FROM sales s
      LEFT JOIN users u ON u.id=s.user_id
      WHERE s.date >= ? AND s.date <= ? AND s.status=? ORDER BY s.date DESC`)
      .all(start.toISOString(), end.toISOString(), status).map(document);
    const user = Number(req.query.user || 0);
    const till = Number(req.query.till || 0);
    if (user !== 0) rows = rows.filter(row => Number(row.user_id) === user);
    if (till !== 0) rows = rows.filter(row => Number(row.till) === till);
    res.json(rows);
  } catch (error) { console.error(error); res.sendStatus(500); }
});

app.post('/new', (req, res) => {
  if (req.body.status === 1) return savePaid(req, res, false);
  if (req.body.status !== 0) return res.sendStatus(400);
  try {
    const id = saleId(req.body._id);
    const date = new Date(req.body.date || Date.now());
    if (!Number.isFinite(date.getTime())) return res.sendStatus(400);
    const payloadHash = hash(req.body);
    const existing = find(id);
    if (existing) return res.sendStatus(existing.payload_hash === payloadHash ? 200 : 409);
    db.prepare(`INSERT INTO sales(id,status,date,user_id,total_cents,paid_cents,payload_hash,data_json)
      VALUES (?,0,?,?,?,?,?,?)`).run(id, date.toISOString(), Number(req.body.user_id) || null,
      0, 0, payloadHash, JSON.stringify(req.body));
    res.sendStatus(200);
  } catch (error) { console.error(error); res.sendStatus(500); }
});
app.put('/new', (req, res) => {
  if (req.body.status === 1) return savePaid(req, res, true);
  if (req.body.status !== 0) return res.sendStatus(400);
  try {
    const id = saleId(req.body._id);
    const existing = find(id);
    if (!existing || existing.status !== 0) return res.sendStatus(409);
    db.prepare('UPDATE sales SET payload_hash=?,data_json=? WHERE id=? AND status=0')
      .run(hash(req.body), JSON.stringify(req.body), id);
    res.sendStatus(200);
  } catch (error) { console.error(error); res.sendStatus(500); }
});
app.post('/delete', (req, res) => {
  try { res.sendStatus(db.prepare('DELETE FROM sales WHERE id=? AND status=0').run(saleId(req.body.orderId)).changes === 1 ? 200 : 409); }
  catch (error) { res.sendStatus(400); }
});
app.get('/:transactionId', (req, res) => {
  try { res.json(document(find(saleId(req.params.transactionId)))); }
  catch (error) { res.sendStatus(400); }
});

// POST Customer return / refund
app.post('/return', (req, res) => {
  try {
    const { sale_id, product_id, quantity, return_to_stock, reason, refund_method } = req.body;
    const sId = saleId(sale_id);
    const saleRow = find(sId);
    if (!saleRow || saleRow.status !== 1) {
      return res.status(404).json({ error: 'Sale not found or not completed.' });
    }

    const pId = Number(product_id);
    const returnQty = Number(quantity);
    if (!Number.isSafeInteger(pId) || pId <= 0) return res.status(400).json({ error: 'Invalid product ID.' });
    if (!Number.isSafeInteger(returnQty) || returnQty <= 0) return res.status(400).json({ error: 'Return quantity must be positive.' });

    // Find sale item
    const saleItem = db.prepare('SELECT * FROM sale_items WHERE sale_id = ? AND product_id = ?').get(sId, pId);
    if (!saleItem) {
      return res.status(404).json({ error: 'Product was not part of this sale.' });
    }

    // Check previously returned quantity for this item
    const prevReturns = db.prepare(`
      SELECT COALESCE(SUM(quantity), 0) AS total_returned
      FROM sales_returns
      WHERE sale_id = ? AND product_id = ?
    `).get(sId, pId);
    const previouslyReturned = Number(prevReturns ? prevReturns.total_returned : 0);

    if (previouslyReturned + returnQty > saleItem.quantity) {
      return res.status(409).json({
        error: 'Return quantity exceeded',
        message: `Already returned ${previouslyReturned} of ${saleItem.quantity} units. Maximum returnable: ${saleItem.quantity - previouslyReturned}.`
      });
    }

    const isRestockable = return_to_stock === false || return_to_stock === 0 ? 0 : 1;
    const unitPriceCents = saleItem.unit_price_cents;
    const refundCents = unitPriceCents * returnQty;
    const returnNumber = `SRET-${sId}-${Date.now().toString().slice(-6)}`;
    const returnDate = new Date().toISOString();
    const userId = req.authUser ? req.authUser._id : null;

    let customerId = null;
    try {
      const saleData = JSON.parse(saleRow.data_json);
      customerId = extractCustomerId(saleData.customer);
    } catch (_) {}

    transaction(() => {
      // 1. If restockable, increment stock
      if (isRestockable === 1) {
        db.prepare('UPDATE inventory SET quantity = quantity + ? WHERE product_id = ?').run(returnQty, pId);
        const curStock = db.prepare('SELECT quantity FROM inventory WHERE product_id = ?').get(pId).quantity;
        db.prepare(`
          INSERT INTO stock_movements(product_id, movement_type, quantity, balance_after, reference_id, user_id, notes)
          VALUES (?, 'SALE_RETURN', ?, ?, ?, ?, ?)
        `).run(pId, returnQty, curStock, returnNumber, userId, `Return from sale #${sId}: ${reason || ''}`);
      }

      // 2. Insert sales_returns record
      db.prepare(`
        INSERT INTO sales_returns(return_number, sale_id, customer_id, product_id, quantity, unit_price_cents, refund_cents, return_to_stock, reason, return_date, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(returnNumber, sId, customerId, pId, returnQty, unitPriceCents, refundCents, isRestockable, String(reason || ''), returnDate, userId);

      // 3. Double-entry accounting:
      // Debit: Sales Returns & Allowances (4020)
      // Credit:
      // If customer has outstanding receivable balance, credit customer AR (1100).
      // Else, credit Cash (1010) or Bank (1020) with cashbook outflow.
      let creditAccountId = 1010;
      let partyType = null;
      let partyId = null;
      const isCashRefund = refund_method !== 'credit' && !customerId;

      if (customerId && refund_method === 'credit') {
        creditAccountId = 1100;
        partyType = 'customer';
        partyId = customerId;
      } else if (refund_method === 'bank') {
        creditAccountId = 1020;
      }

      postJournalEntry({
        entryDate: returnDate,
        referenceType: 'SALE_RETURN',
        referenceId: returnNumber,
        description: `Customer Return #${returnNumber} (Sale #${sId})`,
        userId,
        lines: [
          {
            accountId: 4020, // Sales Returns & Allowances
            debitCents: refundCents,
            creditCents: 0,
            lineDescription: `Return for ${saleItem.product_name} x ${returnQty}`
          },
          {
            accountId: creditAccountId,
            debitCents: 0,
            creditCents: refundCents,
            partyType,
            partyId,
            lineDescription: customerId && refund_method === 'credit' ? `Khata credit adjustment` : `Refund payout`
          }
        ]
      });

      // 4. If cash payout, record in cashbook
      if (creditAccountId === 1010) {
        recordCashbookEntry({
          entryDate: returnDate,
          entryType: 'MANUAL_OUT',
          inflowCents: 0,
          outflowCents: refundCents,
          referenceType: 'SALE_RETURN',
          referenceId: returnNumber,
          description: `Cash refund for Sale #${sId} (${saleItem.product_name})`,
          userId
        });
      }
    });

    res.json({ message: 'Return and refund processed successfully.', return_number: returnNumber, refund_amount: (refundCents / 100).toFixed(2) });
  } catch (error) {
    console.error('Customer return failed:', error);
    res.status(400).json({ error: error.message });
  }
});

module.exports = app;
