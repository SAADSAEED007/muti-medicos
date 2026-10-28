const express = require('express');
const app = express();
const validator = require('validator');
const { db, transaction, cents, pkr, audit } = require('./sqlite');
const { postJournalEntry, recordCashbookEntry } = require('./accounting');

function expenseId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid expense ID.');
  return id;
}

// GET expense categories
app.get('/categories', (_req, res) => {
  try {
    const rows = db.prepare(`
      SELECT ec.*, la.name AS account_name, la.code AS account_code
      FROM expense_categories ec
      JOIN ledger_accounts la ON la.id = ec.account_id
      ORDER BY ec.name ASC
    `).all();
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST create expense category
app.post('/categories', (req, res) => {
  try {
    const name = validator.escape(String(req.body.name || '')).trim();
    if (!name) return res.status(400).json({ error: 'Category name is required.' });

    let accountId = Number(req.body.account_id);
    if (!accountId) {
      // Default to 6090 Miscellaneous Expense if not specified
      accountId = 6090;
    }

    const existing = db.prepare('SELECT id FROM expense_categories WHERE LOWER(name) = LOWER(?)').get(name);
    if (existing) return res.status(409).json({ error: 'Expense category already exists.' });

    const insert = db.prepare('INSERT INTO expense_categories(name, account_id) VALUES (?, ?)');
    const result = insert.run(name, accountId);
    res.status(201).json({ id: Number(result.lastInsertRowid), message: 'Category created successfully.' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET expenses with filters
app.get('/all', (req, res) => {
  try {
    const { category_id, start, end, payment_method } = req.query;
    let query = `
      SELECT e.*, ec.name AS category_name, u.fullname AS user_name
      FROM expenses e
      JOIN expense_categories ec ON ec.id = e.category_id
      LEFT JOIN users u ON u.id = e.user_id
      WHERE 1=1
    `;
    const params = [];

    if (category_id) {
      query += ' AND e.category_id = ?';
      params.push(expenseId(category_id));
    }
    if (payment_method) {
      query += ' AND e.payment_method = ?';
      params.push(payment_method);
    }
    if (start) {
      query += ' AND date(e.expense_date) >= date(?)';
      params.push(new Date(start).toISOString().slice(0, 10));
    }
    if (end) {
      query += ' AND date(e.expense_date) <= date(?)';
      params.push(new Date(end).toISOString().slice(0, 10));
    }

    query += ' ORDER BY e.expense_date DESC, e.id DESC';
    const rows = db.prepare(query).all(...params);

    res.json(rows.map(row => ({
      id: row.id,
      expense_number: row.expense_number,
      category_id: row.category_id,
      category_name: row.category_name,
      amount: pkr(row.amount_cents),
      amount_cents: row.amount_cents,
      expense_date: row.expense_date,
      payment_method: row.payment_method,
      description: row.description,
      reference_number: row.reference_number,
      recorded_by: row.user_name || 'System',
      created_at: row.created_at
    })));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST add expense
app.post('/', (req, res) => {
  try {
    const body = req.body;
    const categoryId = Number(body.category_id);
    if (!Number.isSafeInteger(categoryId) || categoryId <= 0) {
      return res.status(400).json({ error: 'Valid category is required.' });
    }

    const category = db.prepare(`
      SELECT ec.*, la.id AS account_id, la.name AS account_name
      FROM expense_categories ec
      JOIN ledger_accounts la ON la.id = ec.account_id
      WHERE ec.id = ?
    `).get(categoryId);

    if (!category) return res.status(404).json({ error: 'Expense category not found.' });

    const amountCents = cents(body.amount);
    if (amountCents <= 0) return res.status(400).json({ error: 'Expense amount must be greater than zero.' });

    const expenseDate = new Date(body.expense_date || Date.now()).toISOString();
    const paymentMethod = ['cash', 'bank', 'easypaisa', 'jazzcash', 'other'].includes(body.payment_method) ? body.payment_method : 'cash';
    const description = validator.escape(String(body.description || '')).trim();
    const referenceNumber = validator.escape(String(body.reference_number || '')).trim();
    const userId = req.authUser ? req.authUser._id : null;

    const expenseNumber = `EXP-${Date.now().toString().slice(-8)}`;

    const expenseIdRes = transaction(() => {
      // 1. Insert expense record
      const insert = db.prepare(`
        INSERT INTO expenses(expense_number, category_id, amount_cents, expense_date, payment_method, description, reference_number, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertRes = insert.run(expenseNumber, categoryId, amountCents, expenseDate, paymentMethod, description, referenceNumber, userId);
      const newId = Number(insertRes.lastInsertRowid);

      // 2. Double-Entry:
      // Debit: Category's Expense Account (e.g. 6010, 6020, etc.)
      // Credit: Cash (1010) or Bank (1020)
      const assetAccount = paymentMethod === 'bank' ? 1020 : 1010;

      postJournalEntry({
        entryDate: expenseDate,
        referenceType: 'EXPENSE',
        referenceId: expenseNumber,
        description: `Expense (${category.name}): ${description || expenseNumber}`,
        userId,
        lines: [
          {
            accountId: category.account_id, // Expense account
            debitCents: amountCents,
            creditCents: 0,
            lineDescription: `${category.name}: ${description}`
          },
          {
            accountId: assetAccount, // Cash or Bank
            debitCents: 0,
            creditCents: amountCents,
            lineDescription: `Paid via ${paymentMethod}`
          }
        ]
      });

      // 3. Cashbook outflow if cash
      if (paymentMethod === 'cash') {
        recordCashbookEntry({
          entryDate: expenseDate,
          entryType: 'EXPENSE',
          inflowCents: 0,
          outflowCents: amountCents,
          referenceType: 'EXPENSE',
          referenceId: expenseNumber,
          description: `${category.name} Expense: ${description}`,
          userId
        });
      }

      audit(userId, 'CREATE_EXPENSE', 'expense', newId, {
        expense_number: expenseNumber,
        category: category.name,
        amount: pkr(amountCents),
        payment_method: paymentMethod
      });

      return newId;
    });

    res.status(201).json({ id: expenseIdRes, expense_number: expenseNumber, message: 'Expense recorded successfully.' });
  } catch (error) {
    console.error('Error creating expense:', error);
    res.status(400).json({ error: error.message });
  }
});

// GET monthly expense report
app.get('/monthly-summary', (req, res) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const rows = db.prepare(`
      SELECT 
        strftime('%m', expense_date) AS month,
        ec.name AS category_name,
        SUM(e.amount_cents) AS total_cents
      FROM expenses e
      JOIN expense_categories ec ON ec.id = e.category_id
      WHERE strftime('%Y', expense_date) = ?
      GROUP BY month, ec.name
      ORDER BY month ASC, total_cents DESC
    `).all(String(year));

    res.json(rows.map(r => ({
      month: r.month,
      category: r.category_name,
      total: pkr(r.total_cents),
      total_cents: r.total_cents
    })));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = app;
