const { db, transaction, cents, pkr, audit } = require('./sqlite');

/**
 * Account Codes:
 * 1010 - Cash (Asset)
 * 1020 - Bank (Asset)
 * 1100 - Accounts Receivable (Asset)
 * 1200 - Merchandise Inventory (Asset)
 * 1300 - Supplier Advances (Asset)
 * 2010 - Accounts Payable (Liability)
 * 2100 - Customer Advances (Liability)
 * 3010 - Opening Balance Equity (Equity)
 * 3020 - Retained Earnings (Equity)
 * 4010 - Sales Revenue (Revenue)
 * 4020 - Sales Returns & Allowances (Revenue)
 * 5010 - Cost of Goods Sold (Expense)
 */

function generateEntryNumber(prefix = 'JE') {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const countRow = db.prepare("SELECT COUNT(*) AS count FROM journal_entries WHERE entry_number LIKE ?").get(`${prefix}-${dateStr}-%`);
  const seq = String((countRow ? countRow.count : 0) + 1).padStart(4, '0');
  return `${prefix}-${dateStr}-${seq}`;
}

/**
 * Posts a double-entry journal record. Must be executed within a SQLite transaction.
 * @param {Object} params
 * @param {string} params.entryDate ISO date string
 * @param {string} params.referenceType SALE | PURCHASE | PAYMENT | EXPENSE | RETURN | OPENING_BALANCE
 * @param {string|number} params.referenceId Unique reference
 * @param {string} params.description Human readable note
 * @param {number} [params.userId] Operator ID
 * @param {Array<Object>} params.lines Array of { accountId, debitCents, creditCents, partyType, partyId, lineDescription }
 */
function postJournalEntry({ entryDate, referenceType, referenceId, description, userId = null, lines = [] }) {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new Error('A journal entry must have at least two lines.');
  }

  let totalDebit = 0;
  let totalCredit = 0;

  for (const line of lines) {
    const debit = Number(line.debitCents || 0);
    const credit = Number(line.creditCents || 0);

    if (!Number.isSafeInteger(debit) || debit < 0 || !Number.isSafeInteger(credit) || credit < 0) {
      throw new Error('Invalid debit or credit amount in journal line.');
    }
    if ((debit > 0 && credit > 0) || (debit === 0 && credit === 0)) {
      throw new Error('Each line must specify either a debit or a credit, not both or neither.');
    }

    totalDebit += debit;
    totalCredit += credit;
  }

  if (totalDebit !== totalCredit) {
    throw new Error(`Unbalanced journal entry: Total Debits (${pkr(totalDebit)}) != Total Credits (${pkr(totalCredit)}).`);
  }
  if (totalDebit === 0) {
    throw new Error('Journal entry cannot have zero total amount.');
  }

  const entryNumber = generateEntryNumber('JE');
  const date = new Date(entryDate || Date.now()).toISOString();

  const insertEntry = db.prepare(`
    INSERT INTO journal_entries(entry_number, entry_date, reference_type, reference_id, description, user_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const entryResult = insertEntry.run(entryNumber, date, referenceType, String(referenceId), description, userId);
  const entryId = Number(entryResult.lastInsertRowid);

  const insertLine = db.prepare(`
    INSERT INTO journal_lines(entry_id, account_id, debit_cents, credit_cents, party_type, party_id, line_description)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const line of lines) {
    insertLine.run(
      entryId,
      Number(line.accountId),
      Number(line.debitCents || 0),
      Number(line.creditCents || 0),
      line.partyType || null,
      line.partyId != null ? String(line.partyId) : null,
      line.lineDescription || ''
    );
  }

  return { entryId, entryNumber, totalCents: totalDebit };
}

/**
 * Records an entry into the Daily Cashbook. Must be executed within a SQLite transaction.
 */
function recordCashbookEntry({ entryDate, entryType, inflowCents = 0, outflowCents = 0, referenceType = '', referenceId = '', description = '', userId = null }) {
  const inflow = Number(inflowCents || 0);
  const outflow = Number(outflowCents || 0);

  if (!Number.isSafeInteger(inflow) || inflow < 0 || !Number.isSafeInteger(outflow) || outflow < 0) {
    throw new Error('Invalid cashbook inflow or outflow amount.');
  }
  if (inflow === 0 && outflow === 0 && entryType !== 'OPENING' && entryType !== 'CLOSING') {
    throw new Error('Cashbook entry must have non-zero inflow or outflow.');
  }

  const lastRow = db.prepare('SELECT balance_cents FROM cashbook_entries ORDER BY id DESC LIMIT 1').get();
  const currentBalance = lastRow ? Number(lastRow.balance_cents) : 0;
  const newBalance = currentBalance + inflow - outflow;

  const date = new Date(entryDate || Date.now()).toISOString();

  const insert = db.prepare(`
    INSERT INTO cashbook_entries(entry_date, entry_type, inflow_cents, outflow_cents, balance_cents, reference_type, reference_id, description, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const res = insert.run(date, entryType, inflow, outflow, newBalance, referenceType, String(referenceId), description, userId);
  return { id: Number(res.lastInsertRowid), balanceCents: newBalance };
}

/**
 * Computes supplier outstanding payable from journal entries:
 * Credits to AP (2010) increase payable; Debits to AP (2010) decrease payable.
 */
function getSupplierPayableFromJournal(supplierId) {
  const row = db.prepare(`
    SELECT 
      COALESCE(SUM(credit_cents), 0) AS total_credits,
      COALESCE(SUM(debit_cents), 0) AS total_debits
    FROM journal_lines
    WHERE account_id = 2010 AND party_type = 'supplier' AND party_id = ?
  `).get(String(supplierId));

  const credits = row ? Number(row.total_credits) : 0;
  const debits = row ? Number(row.total_debits) : 0;
  return credits - debits; // Positive means we owe supplier
}

/**
 * Computes customer outstanding receivable from journal entries:
 * Debits to AR (1100) increase receivable; Credits to AR (1100) decrease receivable.
 */
function getCustomerReceivableFromJournal(customerId) {
  const row = db.prepare(`
    SELECT 
      COALESCE(SUM(debit_cents), 0) AS total_debits,
      COALESCE(SUM(credit_cents), 0) AS total_credits
    FROM journal_lines
    WHERE account_id = 1100 AND party_type = 'customer' AND party_id = ?
  `).get(String(customerId));

  const debits = row ? Number(row.total_debits) : 0;
  const credits = row ? Number(row.total_credits) : 0;
  return debits - credits; // Positive means customer owes us
}

/**
 * Gets cashbook current balance
 */
function getCashbookBalance() {
  const row = db.prepare('SELECT balance_cents FROM cashbook_entries ORDER BY id DESC LIMIT 1').get();
  return row ? Number(row.balance_cents) : 0;
}

module.exports = {
  postJournalEntry,
  recordCashbookEntry,
  getSupplierPayableFromJournal,
  getCustomerReceivableFromJournal,
  getCashbookBalance,
  generateEntryNumber
};
