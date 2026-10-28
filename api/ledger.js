const express = require('express');
const app = express();
const validator = require('validator');
const { db, transaction, cents, pkr, audit, extractCustomerId } = require('./sqlite');
const { postJournalEntry, recordCashbookEntry, getSupplierPayableFromJournal, getCustomerReceivableFromJournal, getCashbookBalance } = require('./accounting');

function formatNumber(val) {
  const num = Number(val);
  if (!Number.isSafeInteger(num) || num <= 0) throw new Error('Invalid ID parameter.');
  return num;
}

// ==========================================
// PAYMENTS (SUPPLIER & CUSTOMER)
// ==========================================

// GET all payments
app.get('/payments', (req, res) => {
  try {
    const { party_type, party_id, start, end } = req.query;
    let query = `
      SELECT p.*, u.fullname AS user_name
      FROM payments p
      LEFT JOIN users u ON u.id = p.user_id
      WHERE 1=1
    `;
    const params = [];

    if (party_type) {
      query += ' AND p.party_type = ?';
      params.push(party_type);
    }
    if (party_id) {
      query += ' AND p.party_id = ?';
      params.push(String(party_id));
    }
    if (start) {
      query += ' AND p.payment_date >= ?';
      params.push(new Date(start).toISOString().slice(0, 10));
    }
    if (end) {
      query += ' AND p.payment_date <= ?';
      params.push(new Date(end).toISOString().slice(0, 10));
    }

    query += ' ORDER BY p.payment_date DESC, p.id DESC';
    const rows = db.prepare(query).all(...params);

    res.json(rows.map(row => ({
      id: row.id,
      payment_number: row.payment_number,
      party_type: row.party_type,
      party_id: row.party_id,
      payment_date: row.payment_date,
      amount: pkr(row.amount_cents),
      amount_cents: row.amount_cents,
      payment_method: row.payment_method,
      reference_number: row.reference_number,
      notes: row.notes,
      recorded_by: row.user_name || 'System',
      created_at: row.created_at
    })));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST record payment (with optional multi-invoice allocation)
app.post('/payments', (req, res) => {
  try {
    const body = req.body;
    const partyType = body.party_type;
    if (!['supplier', 'customer'].includes(partyType)) {
      return res.status(400).json({ error: 'Party type must be "supplier" or "customer".' });
    }

    const partyId = String(body.party_id || '').trim();
    if (!partyId) return res.status(400).json({ error: 'Party ID is required.' });

    // Validate party exists
    let partyName = '';
    if (partyType === 'supplier') {
      const s = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(formatNumber(partyId));
      if (!s) return res.status(404).json({ error: 'Supplier not found.' });
      partyName = s.name;
    } else {
      const c = db.prepare('SELECT name FROM customers WHERE id = ?').get(partyId);
      if (!c) return res.status(404).json({ error: 'Customer not found.' });
      partyName = c.name;
    }

    const amountCents = cents(body.amount);
    if (amountCents <= 0) return res.status(400).json({ error: 'Payment amount must be greater than zero.' });

    const paymentMethod = ['cash', 'bank', 'easypaisa', 'jazzcash', 'other'].includes(body.payment_method) ? body.payment_method : 'cash';
    const paymentDate = new Date(body.payment_date || Date.now()).toISOString();
    const referenceNumber = validator.escape(String(body.reference_number || '')).trim();
    const notes = validator.escape(String(body.notes || '')).trim();
    const userId = req.authUser ? req.authUser._id : null;

    const allocations = Array.isArray(body.allocations) ? body.allocations : [];

    const paymentNumber = `PAY-${Date.now().toString().slice(-8)}`;

    const paymentId = transaction(() => {
      // 1. Insert payment record
      const payRes = db.prepare(`
        INSERT INTO payments(payment_number, party_type, party_id, payment_date, amount_cents, payment_method, reference_number, notes, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(paymentNumber, partyType, partyId, paymentDate, amountCents, paymentMethod, referenceNumber, notes, userId);

      const pid = Number(payRes.lastInsertRowid);

      // 2. Process allocations
      let totalAllocatedCents = 0;
      if (allocations.length > 0) {
        for (const alloc of allocations) {
          const invId = String(alloc.invoice_id);
          const allocCents = cents(alloc.amount);
          if (allocCents <= 0) continue;

          totalAllocatedCents += allocCents;

          if (partyType === 'supplier') {
            // Allocate to purchase
            const purchase = db.prepare('SELECT * FROM purchases WHERE id = ? AND supplier_id = ?').get(invId, partyId);
            if (!purchase) throw new Error(`Purchase invoice ID ${invId} does not belong to this supplier.`);

            const newPaid = purchase.paid_cents + allocCents;
            const newStatus = newPaid >= purchase.total_cents ? 'paid' : 'partially_paid';

            db.prepare('UPDATE purchases SET paid_cents = ?, payment_status = ? WHERE id = ?').run(newPaid, newStatus, invId);
            db.prepare("INSERT INTO payment_allocations(payment_id, invoice_type, invoice_id, allocated_cents) VALUES (?, 'purchase', ?, ?)")
              .run(pid, invId, allocCents);
          } else {
            // Allocate to customer credit sale
            const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(invId);
            if (!sale) throw new Error(`Sale ID ${invId} not found.`);

            const newPaid = sale.paid_cents + allocCents;
            db.prepare('UPDATE sales SET paid_cents = ? WHERE id = ?').run(newPaid, invId);
            db.prepare("INSERT INTO payment_allocations(payment_id, invoice_type, invoice_id, allocated_cents) VALUES (?, 'sale', ?, ?)")
              .run(pid, invId, allocCents);
          }
        }

        if (totalAllocatedCents > amountCents) {
          throw new Error('Total allocated amount cannot exceed total payment amount.');
        }
      } else {
        // Automatic FIFO allocation when no explicit invoices specified
        let remaining = amountCents;
        if (partyType === 'customer') {
          const unpaidSales = db.prepare(`
            SELECT id, total_cents, paid_cents, data_json
            FROM sales
            WHERE status = 1 AND total_cents > paid_cents
            ORDER BY date ASC, id ASC
          `).all().filter(s => {
            try {
              const data = JSON.parse(s.data_json);
              return extractCustomerId(data.customer) === partyId;
            } catch (_) { return false; }
          });

          for (const s of unpaidSales) {
            if (remaining <= 0) break;
            const outstanding = s.total_cents - s.paid_cents;
            const alloc = Math.min(remaining, outstanding);
            const newPaid = s.paid_cents + alloc;
            db.prepare('UPDATE sales SET paid_cents = ? WHERE id = ?').run(newPaid, s.id);
            db.prepare("INSERT INTO payment_allocations(payment_id, invoice_type, invoice_id, allocated_cents) VALUES (?, 'sale', ?, ?)")
              .run(pid, s.id, alloc);
            remaining -= alloc;
          }
        } else if (partyType === 'supplier') {
          const unpaidPurchases = db.prepare(`
            SELECT id, total_cents, paid_cents
            FROM purchases
            WHERE supplier_id = ? AND purchase_status = 'received' AND payment_status != 'paid' AND total_cents > paid_cents
            ORDER BY purchase_date ASC, id ASC
          `).all(Number(partyId));

          for (const p of unpaidPurchases) {
            if (remaining <= 0) break;
            const outstanding = p.total_cents - p.paid_cents;
            const alloc = Math.min(remaining, outstanding);
            const newPaid = p.paid_cents + alloc;
            const newStatus = newPaid >= p.total_cents ? 'paid' : 'partially_paid';
            db.prepare('UPDATE purchases SET paid_cents = ?, payment_status = ? WHERE id = ?').run(newPaid, newStatus, p.id);
            db.prepare("INSERT INTO payment_allocations(payment_id, invoice_type, invoice_id, allocated_cents) VALUES (?, 'purchase', ?, ?)")
              .run(pid, String(p.id), alloc);
            remaining -= alloc;
          }
        }
      }

      // 3. Post Double-Entry:
      const assetAccount = paymentMethod === 'bank' ? 1020 : 1010;

      if (partyType === 'supplier') {
        // Supplier payment: Debit AP (2010), Credit Cash/Bank (1010/1020)
        postJournalEntry({
          entryDate: paymentDate,
          referenceType: 'SUPPLIER_PAYMENT',
          referenceId: paymentNumber,
          description: `Payment to supplier ${partyName} (${paymentMethod})`,
          userId,
          lines: [
            {
              accountId: 2010, // Accounts Payable
              debitCents: amountCents,
              creditCents: 0,
              partyType: 'supplier',
              partyId: partyId,
              lineDescription: `Payment settlement to ${partyName}`
            },
            {
              accountId: assetAccount, // Cash or Bank
              debitCents: 0,
              creditCents: amountCents,
              lineDescription: `Payment via ${paymentMethod}`
            }
          ]
        });

        // Cashbook Outflow if cash
        if (paymentMethod === 'cash') {
          recordCashbookEntry({
            entryDate: paymentDate,
            entryType: 'SUPPLIER_PAYMENT',
            inflowCents: 0,
            outflowCents: amountCents,
            referenceType: 'PAYMENT',
            referenceId: paymentNumber,
            description: `Payment to supplier ${partyName}`,
            userId
          });
        }
      } else {
        // Customer payment: Debit Cash/Bank (1010/1020), Credit AR (1100)
        postJournalEntry({
          entryDate: paymentDate,
          referenceType: 'CUSTOMER_PAYMENT',
          referenceId: paymentNumber,
          description: `Payment received from customer ${partyName} (${paymentMethod})`,
          userId,
          lines: [
            {
              accountId: assetAccount, // Cash or Bank
              debitCents: amountCents,
              creditCents: 0,
              lineDescription: `Received payment via ${paymentMethod}`
            },
            {
              accountId: 1100, // Accounts Receivable
              debitCents: 0,
              creditCents: amountCents,
              partyType: 'customer',
              partyId: partyId,
              lineDescription: `Khata collection from ${partyName}`
            }
          ]
        });

        // Cashbook Inflow if cash
        if (paymentMethod === 'cash') {
          recordCashbookEntry({
            entryDate: paymentDate,
            entryType: 'CUSTOMER_PAYMENT',
            inflowCents: amountCents,
            outflowCents: 0,
            referenceType: 'PAYMENT',
            referenceId: paymentNumber,
            description: `Payment received from customer ${partyName}`,
            userId
          });
        }
      }

      audit(userId, 'RECORD_PAYMENT', 'payment', pid, {
        payment_number: paymentNumber,
        party_type: partyType,
        party_id: partyId,
        amount: pkr(amountCents),
        payment_method: paymentMethod
      });

      return pid;
    });

    res.status(201).json({ id: paymentId, payment_number: paymentNumber, message: 'Payment recorded and posted successfully.' });
  } catch (error) {
    console.error('Error recording payment:', error);
    res.status(400).json({ error: error.message });
  }
});

// ==========================================
// CUSTOMER LEDGER & KHATA
// ==========================================

// GET customer ledger statement & outstanding
app.get('/customers/:id/statement', (req, res) => {
  try {
    const customerId = String(req.params.id);
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });

    const startDate = req.query.start ? new Date(req.query.start).toISOString() : '1970-01-01T00:00:00.000Z';
    const endDate = req.query.end ? new Date(req.query.end).toISOString() : '2099-12-31T23:59:59.999Z';

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
      WHERE jl.account_id = 1100 AND jl.party_type = 'customer' AND jl.party_id = ?
        AND je.entry_date >= ? AND je.entry_date <= ?
      ORDER BY je.entry_date ASC, je.id ASC, jl.id ASC
    `).all(customerId, startDate, endDate);

    let runningReceivableCents = 0;
    const transactions = lines.map(line => {
      // Debits to AR increase receivable; Credits decrease receivable
      runningReceivableCents += Number(line.debit_cents) - Number(line.credit_cents);
      return {
        date: line.entry_date,
        reference_number: line.entry_number,
        reference_type: line.reference_type,
        description: line.line_description || line.description,
        debit: line.debit_cents > 0 ? pkr(line.debit_cents) : '',
        credit: line.credit_cents > 0 ? pkr(line.credit_cents) : '',
        balance: pkr(runningReceivableCents)
      };
    });

    const currentBalanceCents = getCustomerReceivableFromJournal(customerId);

    res.json({
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        credit_limit: pkr(customer.credit_limit_cents || 0),
        credit_limit_cents: customer.credit_limit_cents || 0
      },
      current_receivable: pkr(currentBalanceCents),
      current_receivable_cents: currentBalanceCents,
      transactions
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET customer unpaid / credit sales
app.get('/customers/:id/unpaid-sales', (req, res) => {
  try {
    const customerId = String(req.params.id);
    const rows = db.prepare(`
      SELECT id, date, total_cents, paid_cents, data_json
      FROM sales
      WHERE status = 1 AND total_cents > paid_cents
      ORDER BY date ASC
    `).all();

    // Filter sales where customer id matches inside JSON
    const customerSales = rows.filter(row => {
      try {
        const data = JSON.parse(row.data_json);
        return extractCustomerId(data.customer) === customerId;
      } catch (_) {
        return false;
      }
    });

    res.json(customerSales.map(s => ({
      id: s.id,
      date: s.date,
      total: pkr(s.total_cents),
      paid: pkr(s.paid_cents),
      outstanding: pkr(s.total_cents - s.paid_cents),
      outstanding_cents: s.total_cents - s.paid_cents
    })));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==========================================
// OPENING BALANCES
// ==========================================

app.post('/opening-balance', (req, res) => {
  try {
    const { party_type, party_id, amount, date, notes } = req.body;
    if (!['supplier', 'customer'].includes(party_type)) {
      return res.status(400).json({ error: 'Party type must be "supplier" or "customer".' });
    }

    const pid = String(party_id || '').trim();
    if (!pid) return res.status(400).json({ error: 'Party ID is required.' });

    const amountCents = cents(amount);
    if (amountCents <= 0) return res.status(400).json({ error: 'Amount must be greater than zero.' });

    const effectiveDate = new Date(date || Date.now()).toISOString();
    const userId = req.authUser ? req.authUser._id : null;

    let partyName = '';
    if (party_type === 'supplier') {
      const s = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(formatNumber(pid));
      if (!s) return res.status(404).json({ error: 'Supplier not found.' });
      partyName = s.name;
    } else {
      const c = db.prepare('SELECT name FROM customers WHERE id = ?').get(pid);
      if (!c) return res.status(404).json({ error: 'Customer not found.' });
      partyName = c.name;
    }

    const refId = `OB-${party_type.toUpperCase()}-${pid}`;

    transaction(() => {
      // Check if opening balance already posted
      const existing = db.prepare("SELECT id FROM journal_entries WHERE reference_type = 'OPENING_BALANCE' AND reference_id = ?").get(refId);
      if (existing) {
        throw new Error(`An opening balance has already been posted for this ${party_type}. Use an adjustment entry to correct balances.`);
      }

      if (party_type === 'supplier') {
        // Supplier opening payable: Debit Opening Equity (3010), Credit AP (2010)
        db.prepare('UPDATE suppliers SET opening_balance_cents = ? WHERE id = ?').run(amountCents, formatNumber(pid));

        postJournalEntry({
          entryDate: effectiveDate,
          referenceType: 'OPENING_BALANCE',
          referenceId: refId,
          description: `Opening balance for supplier ${partyName}: ${notes || ''}`,
          userId,
          lines: [
            {
              accountId: 3010, // Opening Balance Equity
              debitCents: amountCents,
              creditCents: 0,
              lineDescription: `Opening equity offset for ${partyName}`
            },
            {
              accountId: 2010, // Accounts Payable
              debitCents: 0,
              creditCents: amountCents,
              partyType: 'supplier',
              partyId: pid,
              lineDescription: `Opening balance payable to ${partyName}`
            }
          ]
        });
      } else {
        // Customer opening receivable: Debit AR (1100), Credit Opening Equity (3010)
        db.prepare('UPDATE customers SET opening_balance_cents = ? WHERE id = ?').run(amountCents, pid);

        postJournalEntry({
          entryDate: effectiveDate,
          referenceType: 'OPENING_BALANCE',
          referenceId: refId,
          description: `Opening balance for customer ${partyName}: ${notes || ''}`,
          userId,
          lines: [
            {
              accountId: 1100, // Accounts Receivable
              debitCents: amountCents,
              creditCents: 0,
              partyType: 'customer',
              partyId: pid,
              lineDescription: `Opening receivable from ${partyName}`
            },
            {
              accountId: 3010, // Opening Balance Equity
              debitCents: 0,
              creditCents: amountCents,
              lineDescription: `Opening equity offset for ${partyName}`
            }
          ]
        });
      }

      audit(userId, 'POST_OPENING_BALANCE', party_type, pid, { amount: pkr(amountCents), notes });
    });

    res.status(201).json({ message: 'Opening balance posted successfully.' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==========================================
// DAILY CASHBOOK
// ==========================================

app.get('/cashbook', (req, res) => {
  try {
    const { date, start, end } = req.query;
    let query = 'SELECT cb.*, u.fullname AS user_name FROM cashbook_entries cb LEFT JOIN users u ON u.id = cb.user_id WHERE 1=1';
    const params = [];

    if (date) {
      query += ' AND date(cb.entry_date) = date(?)';
      params.push(new Date(date).toISOString().slice(0, 10));
    } else if (start && end) {
      query += ' AND date(cb.entry_date) >= date(?) AND date(cb.entry_date) <= date(?)';
      params.push(new Date(start).toISOString().slice(0, 10), new Date(end).toISOString().slice(0, 10));
    }

    query += ' ORDER BY cb.id ASC';
    const rows = db.prepare(query).all(...params);

    const currentBalanceCents = getCashbookBalance();

    res.json({
      current_balance: pkr(currentBalanceCents),
      current_balance_cents: currentBalanceCents,
      entries: rows.map(r => ({
        id: r.id,
        date: r.entry_date,
        type: r.entry_type,
        inflow: r.inflow_cents > 0 ? pkr(r.inflow_cents) : '',
        inflow_cents: r.inflow_cents,
        outflow: r.outflow_cents > 0 ? pkr(r.outflow_cents) : '',
        outflow_cents: r.outflow_cents,
        balance: pkr(r.balance_cents),
        balance_cents: r.balance_cents,
        description: r.description,
        reference_type: r.reference_type,
        reference_id: r.reference_id,
        recorded_by: r.user_name || 'System'
      }))
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST cash adjustment / manual entry (Cash-in or Cash-out)
app.post('/cashbook/entry', (req, res) => {
  try {
    const { type, amount, description, date } = req.body;
    if (!['MANUAL_IN', 'MANUAL_OUT', 'OPENING', 'CLOSING'].includes(type)) {
      return res.status(400).json({ error: 'Invalid cashbook entry type.' });
    }

    const amountCents = cents(amount);
    const userId = req.authUser ? req.authUser._id : null;
    const entryDate = new Date(date || Date.now()).toISOString();

    const inflowCents = (type === 'MANUAL_IN' || type === 'OPENING') ? amountCents : 0;
    const outflowCents = (type === 'MANUAL_OUT' || type === 'CLOSING') ? amountCents : 0;

    const result = transaction(() => {
      const cb = recordCashbookEntry({
        entryDate,
        entryType: type,
        inflowCents,
        outflowCents,
        referenceType: 'MANUAL',
        referenceId: `CB-${Date.now().toString().slice(-6)}`,
        description: validator.escape(String(description || type)).trim(),
        userId
      });

      // Also create journal entry for cash adjustment to keep journal in sync:
      // If MANUAL_IN: Debit Cash (1010), Credit Owner Equity (3020)
      // If MANUAL_OUT: Debit Owner Equity (3020), Credit Cash (1010)
      if (type === 'MANUAL_IN') {
        postJournalEntry({
          entryDate,
          referenceType: 'CASHBOOK_ADJUSTMENT',
          referenceId: `CB-${cb.id}`,
          description: description || 'Manual Cash In',
          userId,
          lines: [
            { accountId: 1010, debitCents: amountCents, creditCents: 0, lineDescription: 'Cash inflow' },
            { accountId: 3020, debitCents: 0, creditCents: amountCents, lineDescription: 'Equity offset for cash inflow' }
          ]
        });
      } else if (type === 'MANUAL_OUT') {
        postJournalEntry({
          entryDate,
          referenceType: 'CASHBOOK_ADJUSTMENT',
          referenceId: `CB-${cb.id}`,
          description: description || 'Manual Cash Out',
          userId,
          lines: [
            { accountId: 3020, debitCents: amountCents, creditCents: 0, lineDescription: 'Equity offset for cash outflow' },
            { accountId: 1010, debitCents: 0, creditCents: amountCents, lineDescription: 'Cash outflow' }
          ]
        });
      }

      audit(userId, 'CASHBOOK_ENTRY', 'cashbook', cb.id, { type, amount: pkr(amountCents), description });
      return cb;
    });

    res.status(201).json({ message: 'Cashbook entry recorded.', balance: pkr(result.balanceCents) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==========================================
// JOURNAL & TRIAL BALANCE
// ==========================================

app.get('/journal', (req, res) => {
  try {
    const { start, end } = req.query;
    let query = `
      SELECT je.*, u.fullname AS user_name
      FROM journal_entries je
      LEFT JOIN users u ON u.id = je.user_id
      WHERE 1=1
    `;
    const params = [];
    if (start) {
      query += ' AND date(je.entry_date) >= date(?)';
      params.push(new Date(start).toISOString().slice(0, 10));
    }
    if (end) {
      query += ' AND date(je.entry_date) <= date(?)';
      params.push(new Date(end).toISOString().slice(0, 10));
    }

    query += ' ORDER BY je.entry_date DESC, je.id DESC LIMIT 200';
    const entries = db.prepare(query).all(...params);

    const getLines = db.prepare(`
      SELECT jl.*, la.code AS account_code, la.name AS account_name, la.type AS account_type
      FROM journal_lines jl
      JOIN ledger_accounts la ON la.id = jl.account_id
      WHERE jl.entry_id = ?
      ORDER BY jl.id ASC
    `);

    const result = entries.map(entry => {
      const lines = getLines.all(entry.id);
      return {
        id: entry.id,
        entry_number: entry.entry_number,
        entry_date: entry.entry_date,
        reference_type: entry.reference_type,
        reference_id: entry.reference_id,
        description: entry.description,
        created_by: entry.user_name || 'System',
        lines: lines.map(l => ({
          account_code: l.account_code,
          account_name: l.account_name,
          debit: l.debit_cents > 0 ? pkr(l.debit_cents) : '',
          credit: l.credit_cents > 0 ? pkr(l.credit_cents) : '',
          party_type: l.party_type,
          party_id: l.party_id,
          line_description: l.line_description
        }))
      };
    });

    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/trial-balance', (_req, res) => {
  try {
    const accounts = db.prepare(`
      SELECT 
        la.id, la.code, la.name, la.type,
        COALESCE(SUM(jl.debit_cents), 0) AS total_debit_cents,
        COALESCE(SUM(jl.credit_cents), 0) AS total_credit_cents
      FROM ledger_accounts la
      LEFT JOIN journal_lines jl ON jl.account_id = la.id
      GROUP BY la.id
      ORDER BY la.code ASC
    `).all();

    let totalDebits = 0;
    let totalCredits = 0;

    const rows = accounts.map(acc => {
      const d = Number(acc.total_debit_cents);
      const c = Number(acc.total_credit_cents);
      totalDebits += d;
      totalCredits += c;

      // Net balance according to normal account balance:
      // Assets & Expenses: normal debit (debit - credit)
      // Liabilities, Equity, Revenue: normal credit (credit - debit)
      let netBalance = 0;
      if (['asset', 'expense'].includes(acc.type)) {
        netBalance = d - c;
      } else {
        netBalance = c - d;
      }

      return {
        code: acc.code,
        name: acc.name,
        type: acc.type,
        total_debit: pkr(d),
        total_credit: pkr(c),
        net_balance: pkr(netBalance),
        net_balance_cents: netBalance
      };
    });

    res.json({
      accounts: rows,
      total_debit: pkr(totalDebits),
      total_credit: pkr(totalCredits),
      is_balanced: totalDebits === totalCredits
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Financial summary dashboard metrics
app.get('/dashboard-summary', (_req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);

    // 1. Total Receivables
    const arRow = db.prepare(`
      SELECT COALESCE(SUM(debit_cents), 0) - COALESCE(SUM(credit_cents), 0) AS balance
      FROM journal_lines WHERE account_id = 1100
    `).get();
    const totalReceivables = Math.max(0, Number(arRow ? arRow.balance : 0));

    // 2. Total Payables
    const apRow = db.prepare(`
      SELECT COALESCE(SUM(credit_cents), 0) - COALESCE(SUM(debit_cents), 0) AS balance
      FROM journal_lines WHERE account_id = 2010
    `).get();
    const totalPayables = Math.max(0, Number(apRow ? apRow.balance : 0));

    // 3. Current Cash in Till / Cashbook
    const currentCash = getCashbookBalance();

    // 4. Today's Collections (Customer Payments + Cash Sales)
    const collectionsRow = db.prepare(`
      SELECT COALESCE(SUM(inflow_cents), 0) AS total
      FROM cashbook_entries
      WHERE date(entry_date) = date(?) AND entry_type IN ('CASH_SALE', 'CUSTOMER_PAYMENT')
    `).get(today);
    const todayCollections = Number(collectionsRow ? collectionsRow.total : 0);

    // 5. Today's Supplier Payments
    const supplierPayRow = db.prepare(`
      SELECT COALESCE(SUM(amount_cents), 0) AS total
      FROM payments
      WHERE party_type = 'supplier' AND date(payment_date) = date(?)
    `).get(today);
    const todaySupplierPayments = Number(supplierPayRow ? supplierPayRow.total : 0);

    // 6. Today's Expenses
    const expenseRow = db.prepare(`
      SELECT COALESCE(SUM(amount_cents), 0) AS total
      FROM expenses
      WHERE date(expense_date) = date(?)
    `).get(today);
    const todayExpenses = Number(expenseRow ? expenseRow.total : 0);

    // 7. Overdue accounts count
    const overdueSuppliers = db.prepare(`
      SELECT COUNT(*) AS count
      FROM purchases
      WHERE purchase_status = 'received' AND payment_status != 'paid' AND due_date IS NOT NULL AND date(due_date) < date(?)
    `).get(today).count;

    res.json({
      total_receivables: pkr(totalReceivables),
      total_receivables_cents: totalReceivables,
      total_payables: pkr(totalPayables),
      total_payables_cents: totalPayables,
      cash_balance: pkr(currentCash),
      cash_balance_cents: currentCash,
      today_collections: pkr(todayCollections),
      today_collections_cents: todayCollections,
      today_supplier_payments: pkr(todaySupplierPayments),
      today_supplier_payments_cents: todaySupplierPayments,
      today_expenses: pkr(todayExpenses),
      today_expenses_cents: todayExpenses,
      overdue_invoices_count: overdueSuppliers
    });
  } catch (error) {
    console.error('Error fetching dashboard summary:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = app;
