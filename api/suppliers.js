const express = require('express');
const app = express();
const validator = require('validator');
const { db, transaction, cents, pkr, audit } = require('./sqlite');
const { postJournalEntry, getSupplierPayableFromJournal } = require('./accounting');

function supplierId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid supplier ID.');
  return id;
}

function contactFields(body) {
  const phone = validator.escape(String(body.phone || '')).trim();
  const email = validator.escape(String(body.email || '')).trim();
  if (phone && !/^(?:\+92|0092|0)?[0-9][0-9\s-]{8,14}$/.test(phone)) {
    throw new Error('Enter a valid Pakistani phone number, for example 0300 1234567.');
  }
  if (email && !validator.isEmail(email)) {
    throw new Error('Enter a valid email address or leave it blank.');
  }
  return { phone, email };
}

function formatSupplier(row) {
  if (!row) return null;
  const openingBalanceCents = Number(row.opening_balance_cents || 0);
  const payableCents = getSupplierPayableFromJournal(row.id);

  return {
    id: row.id,
    name: row.name,
    contact_person: row.contact_person,
    phone: row.phone,
    email: row.email,
    address: row.address,
    opening_balance: pkr(openingBalanceCents),
    opening_balance_cents: openingBalanceCents,
    payment_terms: row.payment_terms,
    due_period_days: row.due_period_days,
    outstanding_payable: pkr(payableCents),
    outstanding_payable_cents: payableCents,
    status: row.status,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

// GET all suppliers
app.get('/all', (_req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM suppliers ORDER BY name ASC').all();
    res.json(rows.map(formatSupplier));
  } catch (error) {
    console.error('Error fetching suppliers:', error);
    res.status(500).json({ error: 'Failed to fetch suppliers', message: error.message });
  }
});

// GET supplier by ID
app.get('/:id', (req, res) => {
  try {
    const id = supplierId(req.params.id);
    const row = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Supplier not found' });

    const data = formatSupplier(row);

    // Summary statistics
    const purchasesStats = db.prepare(`
      SELECT 
        COUNT(*) AS total_count,
        COALESCE(SUM(total_cents), 0) AS total_cents,
        COALESCE(SUM(paid_cents), 0) AS total_paid_cents
      FROM purchases
      WHERE supplier_id = ? AND purchase_status = 'received'
    `).get(id);

    const paymentsStats = db.prepare(`
      SELECT 
        COUNT(*) AS total_count,
        COALESCE(SUM(amount_cents), 0) AS total_cents
      FROM payments
      WHERE party_type = 'supplier' AND party_id = ?
    `).get(String(id));

    const returnsStats = db.prepare(`
      SELECT 
        COUNT(*) AS total_count,
        COALESCE(SUM(total_cents), 0) AS total_cents
      FROM purchase_returns
      WHERE supplier_id = ?
    `).get(id);

    data.stats = {
      purchases_count: purchasesStats ? purchasesStats.total_count : 0,
      total_purchased: pkr(purchasesStats ? purchasesStats.total_cents : 0),
      payments_count: paymentsStats ? paymentsStats.total_count : 0,
      total_paid: pkr(paymentsStats ? paymentsStats.total_cents : 0),
      returns_count: returnsStats ? returnsStats.total_count : 0,
      total_returned: pkr(returnsStats ? returnsStats.total_cents : 0)
    };

    res.json(data);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST create supplier
app.post('/', (req, res) => {
  try {
    const body = req.body;
    const name = validator.escape(String(body.name || '')).trim();
    if (!name) return res.status(400).json({ error: 'Supplier company name is required.' });

    const contactPerson = validator.escape(String(body.contact_person || '')).trim();
    const { phone, email } = contactFields(body);
    const address = validator.escape(String(body.address || '')).trim();
    const paymentTerms = validator.escape(String(body.payment_terms || 'Net 30')).trim();
    const duePeriodDays = body.due_period_days === '' || body.due_period_days == null ? 30 : Number(body.due_period_days);
    const notes = validator.escape(String(body.notes || '')).trim();
    const status = body.status === 'inactive' ? 'inactive' : 'active';
    const openingBalanceInput = body.opening_balance || 0;
    const openingBalanceCents = cents(openingBalanceInput);

    if (!Number.isSafeInteger(duePeriodDays) || duePeriodDays < 0) {
      return res.status(400).json({ error: 'Due period days must be a non-negative integer.' });
    }

    // Check duplicate name
    const existing = db.prepare('SELECT id FROM suppliers WHERE LOWER(name) = LOWER(?)').get(name);
    if (existing) {
      return res.status(409).json({ error: 'Duplicate supplier', message: 'A supplier with this name already exists.' });
    }

    const userId = req.authUser ? req.authUser._id : null;

    const result = transaction(() => {
      const insert = db.prepare(`
        INSERT INTO suppliers(name, contact_person, phone, email, address, opening_balance_cents, payment_terms, due_period_days, status, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertRes = insert.run(name, contactPerson, phone, email, address, openingBalanceCents, paymentTerms, duePeriodDays, status, notes);
      const newSupplierId = Number(insertRes.lastInsertRowid);

      // If opening balance > 0, post double entry to accounting:
      // Debit: Opening Balance Equity (3010)
      // Credit: Accounts Payable (2010), party_type='supplier', party_id=newSupplierId
      if (openingBalanceCents > 0) {
        postJournalEntry({
          entryDate: new Date().toISOString(),
          referenceType: 'OPENING_BALANCE',
          referenceId: `SUP-OB-${newSupplierId}`,
          description: `Opening balance payable for supplier ${name}`,
          userId,
          lines: [
            {
              accountId: 3010, // Opening Balance Equity
              debitCents: openingBalanceCents,
              creditCents: 0,
              lineDescription: `Opening balance equity offset for supplier ${name}`
            },
            {
              accountId: 2010, // Accounts Payable
              debitCents: 0,
              creditCents: openingBalanceCents,
              partyType: 'supplier',
              partyId: newSupplierId,
              lineDescription: `Opening balance payable to ${name}`
            }
          ]
        });
      }

      audit(userId, 'CREATE_SUPPLIER', 'supplier', newSupplierId, { name, opening_balance: openingBalanceInput });
      return newSupplierId;
    });

    res.status(201).json({ id: result, message: 'Supplier created successfully.' });
  } catch (error) {
    console.error('Error creating supplier:', error);
    res.status(error.message.includes('duplicate') ? 409 : 400).json({ error: error.message });
  }
});

// PUT update supplier
app.put('/:id', (req, res) => {
  try {
    const id = supplierId(req.params.id);
    const existing = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Supplier not found' });

    const body = req.body;
    const name = validator.escape(String(body.name || '')).trim();
    if (!name) return res.status(400).json({ error: 'Supplier company name is required.' });

    // Check duplicate name on another supplier
    const duplicate = db.prepare('SELECT id FROM suppliers WHERE LOWER(name) = LOWER(?) AND id != ?').get(name, id);
    if (duplicate) {
      return res.status(409).json({ error: 'Duplicate supplier', message: 'Another supplier with this name already exists.' });
    }

    const contactPerson = validator.escape(String(body.contact_person || '')).trim();
    const { phone, email } = contactFields(body);
    const address = validator.escape(String(body.address || '')).trim();
    const paymentTerms = validator.escape(String(body.payment_terms || existing.payment_terms)).trim();
    const duePeriodDays = Number(body.due_period_days ?? existing.due_period_days);
    const status = body.status === 'inactive' ? 'inactive' : 'active';
    const notes = validator.escape(String(body.notes || '')).trim();

    if (!Number.isSafeInteger(duePeriodDays) || duePeriodDays < 0) {
      return res.status(400).json({ error: 'Due period days must be a non-negative integer.' });
    }

    const userId = req.authUser ? req.authUser._id : null;

    db.prepare(`
      UPDATE suppliers
      SET name = ?, contact_person = ?, phone = ?, email = ?, address = ?,
          payment_terms = ?, due_period_days = ?, status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(name, contactPerson, phone, email, address, paymentTerms, duePeriodDays, status, notes, id);

    audit(userId, 'UPDATE_SUPPLIER', 'supplier', id, { name, status });
    res.json({ message: 'Supplier updated successfully.' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// DELETE supplier
app.delete('/:id', (req, res) => {
  try {
    const id = supplierId(req.params.id);
    const existing = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Supplier not found.' });

    // Check if supplier has any financial records
    const purchasesCount = db.prepare('SELECT COUNT(*) AS count FROM purchases WHERE supplier_id = ?').get(id).count;
    const paymentsCount = db.prepare("SELECT COUNT(*) AS count FROM payments WHERE party_type = 'supplier' AND party_id = ?").get(String(id)).count;
    const returnsCount = db.prepare('SELECT COUNT(*) AS count FROM purchase_returns WHERE supplier_id = ?').get(id).count;
    const batchesCount = db.prepare('SELECT COUNT(*) AS count FROM inventory_batches WHERE supplier_id = ?').get(id).count;

    if (purchasesCount > 0 || paymentsCount > 0 || returnsCount > 0 || batchesCount > 0) {
      return res.status(409).json({
        error: 'Cannot delete supplier',
        message: 'This supplier has historical purchases, payments, or returns. Deactivate the supplier instead to maintain audit integrity.'
      });
    }

    transaction(() => {
      // Clean up opening balance journal entries if any
      const jeRow = db.prepare("SELECT id FROM journal_entries WHERE reference_type = 'OPENING_BALANCE' AND reference_id = ?").get(`SUP-OB-${id}`);
      if (jeRow) {
        db.prepare('DELETE FROM journal_entries WHERE id = ?').run(jeRow.id);
      }
      db.prepare('DELETE FROM suppliers WHERE id = ?').run(id);
    });

    const userId = req.authUser ? req.authUser._id : null;
    audit(userId, 'DELETE_SUPPLIER', 'supplier', id, { name: existing.name });

    res.json({ message: 'Supplier deleted successfully.' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET supplier purchase history
app.get('/:id/purchases', (req, res) => {
  try {
    const id = supplierId(req.params.id);
    const rows = db.prepare(`
      SELECT p.*, u.fullname AS created_by_name
      FROM purchases p
      LEFT JOIN users u ON u.id = p.created_by
      WHERE p.supplier_id = ?
      ORDER BY p.purchase_date DESC, p.id DESC
    `).all(id);

    res.json(rows.map(row => ({
      id: row.id,
      invoice_no: row.invoice_no,
      invoice_date: row.invoice_date,
      purchase_date: row.purchase_date,
      receiving_date: row.receiving_date,
      due_date: row.due_date,
      purchase_status: row.purchase_status,
      payment_status: row.payment_status,
      total: pkr(row.total_cents),
      paid: pkr(row.paid_cents),
      outstanding: pkr(row.total_cents - row.paid_cents),
      notes: row.notes,
      created_by: row.created_by_name || 'System'
    })));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET supplier payments history
app.get('/:id/payments', (req, res) => {
  try {
    const id = supplierId(req.params.id);
    const rows = db.prepare(`
      SELECT p.*, u.fullname AS user_name
      FROM payments p
      LEFT JOIN users u ON u.id = p.user_id
      WHERE p.party_type = 'supplier' AND p.party_id = ?
      ORDER BY p.payment_date DESC, p.id DESC
    `).all(String(id));

    res.json(rows.map(row => ({
      id: row.id,
      payment_number: row.payment_number,
      payment_date: row.payment_date,
      amount: pkr(row.amount_cents),
      payment_method: row.payment_method,
      reference_number: row.reference_number,
      notes: row.notes,
      recorded_by: row.user_name || 'System'
    })));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET supplier medicine-wise purchase history
app.get('/:id/medicines', (req, res) => {
  try {
    const id = supplierId(req.params.id);
    const rows = db.prepare(`
      SELECT 
        pi.product_id,
        pi.product_name,
        pi.batch_number,
        pi.expiry_date,
        SUM(pi.quantity) AS total_quantity,
        SUM(pi.bonus_quantity) AS total_bonus,
        AVG(pi.unit_cost_cents) AS avg_unit_cost_cents,
        SUM(pi.line_total_cents) AS total_spend_cents,
        MAX(p.receiving_date) AS last_received_date
      FROM purchase_items pi
      JOIN purchases p ON p.id = pi.purchase_id
      WHERE p.supplier_id = ? AND p.purchase_status = 'received'
      GROUP BY pi.product_id, pi.batch_number
      ORDER BY last_received_date DESC
    `).all(id);

    res.json(rows.map(row => ({
      product_id: row.product_id,
      product_name: row.product_name,
      batch_number: row.batch_number,
      expiry_date: row.expiry_date,
      total_quantity: row.total_quantity,
      total_bonus: row.total_bonus,
      avg_unit_cost: pkr(Math.round(row.avg_unit_cost_cents)),
      total_spend: pkr(row.total_spend_cents),
      last_received_date: row.last_received_date
    })));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET supplier unpaid / partially paid invoices
app.get('/:id/invoices/unpaid', (req, res) => {
  try {
    const id = supplierId(req.params.id);
    const rows = db.prepare(`
      SELECT *
      FROM purchases
      WHERE supplier_id = ? AND purchase_status = 'received' AND payment_status != 'paid'
      ORDER BY invoice_date ASC, id ASC
    `).all(id);

    res.json(rows.map(row => ({
      id: row.id,
      invoice_no: row.invoice_no,
      invoice_date: row.invoice_date,
      due_date: row.due_date,
      total: pkr(row.total_cents),
      paid: pkr(row.paid_cents),
      outstanding: pkr(row.total_cents - row.paid_cents),
      outstanding_cents: row.total_cents - row.paid_cents,
      payment_status: row.payment_status
    })));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET supplier returns
app.get('/:id/returns', (req, res) => {
  try {
    const id = supplierId(req.params.id);
    const rows = db.prepare(`
      SELECT pr.*, p.name AS product_name, u.fullname AS user_name
      FROM purchase_returns pr
      JOIN products p ON p.id = pr.product_id
      LEFT JOIN users u ON u.id = pr.user_id
      WHERE pr.supplier_id = ?
      ORDER BY pr.return_date DESC
    `).all(id);

    res.json(rows.map(row => ({
      id: row.id,
      return_number: row.return_number,
      purchase_id: row.purchase_id,
      product_name: row.product_name,
      quantity: row.quantity,
      unit_cost: pkr(row.unit_cost_cents),
      total: pkr(row.total_cents),
      reason: row.reason,
      return_date: row.return_date,
      recorded_by: row.user_name || 'System'
    })));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET supplier account statement (chronological ledger)
app.get('/:id/statement', (req, res) => {
  try {
    const id = supplierId(req.params.id);
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    const startDate = req.query.start ? new Date(req.query.start).toISOString() : '1970-01-01T00:00:00.000Z';
    const endDate = req.query.end ? new Date(req.query.end).toISOString() : '2099-12-31T23:59:59.999Z';

    // Get journal lines for this supplier
    const lines = db.prepare(`
      SELECT 
        je.entry_date,
        je.entry_number,
        je.reference_type,
        je.reference_id,
        je.description,
        jl.debit_cents,
        jl.credit_cents,
        jl.line_description
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.account_id = 2010 AND jl.party_type = 'supplier' AND jl.party_id = ?
        AND je.entry_date >= ? AND je.entry_date <= ?
      ORDER BY je.entry_date ASC, je.id ASC, jl.id ASC
    `).all(String(id), startDate, endDate);

    let runningPayableCents = 0;
    const statementItems = lines.map(line => {
      // Credits to AP increase payable; Debits decrease payable
      runningPayableCents += Number(line.credit_cents) - Number(line.debit_cents);
      return {
        date: line.entry_date,
        reference_number: line.entry_number,
        reference_type: line.reference_type,
        description: line.line_description || line.description,
        debit: line.debit_cents > 0 ? pkr(line.debit_cents) : '',
        credit: line.credit_cents > 0 ? pkr(line.credit_cents) : '',
        balance: pkr(runningPayableCents)
      };
    });

    res.json({
      supplier: {
        id: supplier.id,
        name: supplier.name,
        contact_person: supplier.contact_person,
        phone: supplier.phone
      },
      current_payable: pkr(runningPayableCents),
      transactions: statementItems
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = app;
