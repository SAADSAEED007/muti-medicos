const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const appData = process.env.APPDATA;
const appName = process.env.APPNAME;
if (!appData || !appName) throw new Error('Application data path is unavailable. Database was not opened.');
const directory = path.join(appData, appName, 'server', 'databases');
fs.mkdirSync(directory, { recursive: true });
const filename = path.join(directory, 'pharmacy.sqlite');
const db = new DatabaseSync(filename, { timeout: 5000 });

try {
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
  if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1 ||
      db.prepare('PRAGMA journal_mode').get().journal_mode.toLowerCase() !== 'wal' ||
      db.prepare('PRAGMA synchronous').get().synchronous !== 2) {
    throw new Error('Required SQLite durability settings were not applied.');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, fullname TEXT NOT NULL,
      password TEXT NOT NULL, status TEXT NOT NULL DEFAULT '',
      perm_products INTEGER NOT NULL DEFAULT 0, perm_categories INTEGER NOT NULL DEFAULT 0,
      perm_transactions INTEGER NOT NULL DEFAULT 0, perm_users INTEGER NOT NULL DEFAULT 0,
      perm_settings INTEGER NOT NULL DEFAULT 0,
      session_hash TEXT UNIQUE, session_expires INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, data_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, data_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY, barcode INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
      expiration_date TEXT NOT NULL, category TEXT NOT NULL DEFAULT '',
      supplier TEXT NOT NULL DEFAULT '', stock_tracked INTEGER NOT NULL DEFAULT 1,
      min_stock INTEGER NOT NULL DEFAULT 0, img TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS inventory (
      product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE RESTRICT,
      quantity INTEGER NOT NULL CHECK(quantity >= 0)
    );
    CREATE TABLE IF NOT EXISTS stock_adjustments (
      id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id),
      before_quantity INTEGER NOT NULL, after_quantity INTEGER NOT NULL,
      reason TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY, status INTEGER NOT NULL CHECK(status IN (0, 1)),
      date TEXT NOT NULL, user_id INTEGER, total_cents INTEGER NOT NULL DEFAULT 0,
      paid_cents INTEGER NOT NULL DEFAULT 0, payload_hash TEXT NOT NULL,
      data_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sale_items (
      sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      line_no INTEGER NOT NULL, product_id INTEGER NOT NULL REFERENCES products(id),
      product_name TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0),
      unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents >= 0),
      PRIMARY KEY (sale_id, line_no)
    );
    CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id = 1), data_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_sales_date_status ON sales(date, status);
    CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);
    CREATE INDEX IF NOT EXISTS idx_products_expiry ON products(expiration_date);

    -- Suppliers
    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      contact_person TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      opening_balance_cents INTEGER NOT NULL DEFAULT 0,
      payment_terms TEXT NOT NULL DEFAULT 'Net 30',
      due_period_days INTEGER NOT NULL DEFAULT 30,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Purchases
    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_no TEXT NOT NULL,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
      invoice_date TEXT NOT NULL,
      purchase_date TEXT NOT NULL,
      receiving_date TEXT,
      due_date TEXT,
      purchase_status TEXT NOT NULL DEFAULT 'draft' CHECK(purchase_status IN ('draft', 'received', 'cancelled')),
      payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid', 'partially_paid', 'paid')),
      total_cents INTEGER NOT NULL DEFAULT 0 CHECK(total_cents >= 0),
      paid_cents INTEGER NOT NULL DEFAULT 0 CHECK(paid_cents >= 0),
      notes TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(supplier_id, invoice_no)
    );

    -- Purchase Items
    CREATE TABLE IF NOT EXISTS purchase_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      product_name TEXT NOT NULL,
      manufacturer TEXT NOT NULL DEFAULT '',
      strength TEXT NOT NULL DEFAULT '',
      dosage_form TEXT NOT NULL DEFAULT '',
      batch_number TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      purchase_unit TEXT NOT NULL DEFAULT 'Box',
      units_per_pack INTEGER NOT NULL DEFAULT 1 CHECK(units_per_pack >= 1),
      bonus_quantity INTEGER NOT NULL DEFAULT 0 CHECK(bonus_quantity >= 0),
      unit_cost_cents INTEGER NOT NULL CHECK(unit_cost_cents >= 0),
      discount_cents INTEGER NOT NULL DEFAULT 0 CHECK(discount_cents >= 0),
      tax_cents INTEGER NOT NULL DEFAULT 0 CHECK(tax_cents >= 0),
      line_total_cents INTEGER NOT NULL CHECK(line_total_cents >= 0),
      retail_price_cents INTEGER CHECK(retail_price_cents IS NULL OR retail_price_cents >= 0)
    );

    -- Inventory Batches (FEFO Tracking)
    CREATE TABLE IF NOT EXISTS inventory_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      supplier_id INTEGER REFERENCES suppliers(id),
      purchase_id INTEGER REFERENCES purchases(id),
      batch_number TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      initial_quantity INTEGER NOT NULL CHECK(initial_quantity >= 0),
      quantity_available INTEGER NOT NULL CHECK(quantity_available >= 0),
      unit_cost_cents INTEGER NOT NULL CHECK(unit_cost_cents >= 0),
      received_date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(product_id, batch_number, expiry_date)
    );

    -- Stock Movements Audit
    CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      batch_id INTEGER REFERENCES inventory_batches(id),
      movement_type TEXT NOT NULL CHECK(movement_type IN ('PURCHASE_RECEIPT', 'SALE', 'PURCHASE_RETURN', 'SALE_RETURN', 'ADJUSTMENT', 'OPENING_STOCK')),
      quantity INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reference_id TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      notes TEXT NOT NULL DEFAULT '',
      recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Double-Entry Chart of Accounts
    CREATE TABLE IF NOT EXISTS ledger_accounts (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
      description TEXT NOT NULL DEFAULT ''
    );

    -- Journal Entries
    CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_number TEXT NOT NULL UNIQUE,
      entry_date TEXT NOT NULL,
      reference_type TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      description TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Journal Lines (Double-Entry lines: debits = credits)
    CREATE TABLE IF NOT EXISTS journal_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES ledger_accounts(id),
      debit_cents INTEGER NOT NULL DEFAULT 0 CHECK(debit_cents >= 0),
      credit_cents INTEGER NOT NULL DEFAULT 0 CHECK(credit_cents >= 0),
      party_type TEXT CHECK(party_type IS NULL OR party_type IN ('customer', 'supplier')),
      party_id TEXT,
      line_description TEXT NOT NULL DEFAULT '',
      CHECK((debit_cents > 0 AND credit_cents = 0) OR (credit_cents > 0 AND debit_cents = 0))
    );

    -- Payments (Supplier & Customer)
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_number TEXT NOT NULL UNIQUE,
      party_type TEXT NOT NULL CHECK(party_type IN ('supplier', 'customer')),
      party_id TEXT NOT NULL,
      payment_date TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
      payment_method TEXT NOT NULL CHECK(payment_method IN ('cash', 'bank', 'easypaisa', 'jazzcash', 'other')),
      reference_number TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Payment Allocations to Invoices
    CREATE TABLE IF NOT EXISTS payment_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
      invoice_type TEXT NOT NULL CHECK(invoice_type IN ('purchase', 'sale')),
      invoice_id TEXT NOT NULL,
      allocated_cents INTEGER NOT NULL CHECK(allocated_cents > 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Purchase Returns (Supplier Returns)
    CREATE TABLE IF NOT EXISTS purchase_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_number TEXT NOT NULL UNIQUE,
      purchase_id INTEGER NOT NULL REFERENCES purchases(id),
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      batch_id INTEGER REFERENCES inventory_batches(id),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      unit_cost_cents INTEGER NOT NULL CHECK(unit_cost_cents >= 0),
      total_cents INTEGER NOT NULL CHECK(total_cents >= 0),
      reason TEXT NOT NULL DEFAULT '',
      return_date TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Sales Returns (Customer Returns)
    CREATE TABLE IF NOT EXISTS sales_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_number TEXT NOT NULL UNIQUE,
      sale_id TEXT NOT NULL REFERENCES sales(id),
      customer_id TEXT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      batch_id INTEGER REFERENCES inventory_batches(id),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents >= 0),
      refund_cents INTEGER NOT NULL CHECK(refund_cents >= 0),
      return_to_stock INTEGER NOT NULL DEFAULT 1 CHECK(return_to_stock IN (0, 1)),
      reason TEXT NOT NULL DEFAULT '',
      return_date TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Expense Categories & Expenses
    CREATE TABLE IF NOT EXISTS expense_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      account_id INTEGER NOT NULL REFERENCES ledger_accounts(id)
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_number TEXT NOT NULL UNIQUE,
      category_id INTEGER NOT NULL REFERENCES expense_categories(id),
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
      expense_date TEXT NOT NULL,
      payment_method TEXT NOT NULL CHECK(payment_method IN ('cash', 'bank', 'easypaisa', 'jazzcash', 'other')),
      description TEXT NOT NULL DEFAULT '',
      reference_number TEXT NOT NULL DEFAULT '',
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Daily Cashbook
    CREATE TABLE IF NOT EXISTS cashbook_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_date TEXT NOT NULL,
      entry_type TEXT NOT NULL CHECK(entry_type IN ('OPENING', 'CASH_SALE', 'CUSTOMER_PAYMENT', 'SUPPLIER_PAYMENT', 'EXPENSE', 'MANUAL_IN', 'MANUAL_OUT', 'CLOSING')),
      inflow_cents INTEGER NOT NULL DEFAULT 0 CHECK(inflow_cents >= 0),
      outflow_cents INTEGER NOT NULL DEFAULT 0 CHECK(outflow_cents >= 0),
      balance_cents INTEGER NOT NULL,
      reference_type TEXT NOT NULL DEFAULT '',
      reference_id TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Audit Logs
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      ip_address TEXT NOT NULL DEFAULT '127.0.0.1',
      timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id);
    CREATE INDEX IF NOT EXISTS idx_inventory_batches_product ON inventory_batches(product_id, expiry_date);
    CREATE INDEX IF NOT EXISTS idx_journal_entries_date ON journal_entries(entry_date);
    CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id);
    CREATE INDEX IF NOT EXISTS idx_journal_lines_party ON journal_lines(party_type, party_id);
    CREATE INDEX IF NOT EXISTS idx_payments_party ON payments(party_type, party_id);
    CREATE INDEX IF NOT EXISTS idx_cashbook_date ON cashbook_entries(entry_date);
    CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
  `);

  // Idempotently add missing columns to customers table if not already present
  const customerColumns = db.prepare("PRAGMA table_info('customers')").all().map(c => c.name);
  if (!customerColumns.includes('phone')) db.exec("ALTER TABLE customers ADD COLUMN phone TEXT NOT NULL DEFAULT ''");
  if (!customerColumns.includes('address')) db.exec("ALTER TABLE customers ADD COLUMN address TEXT NOT NULL DEFAULT ''");
  if (!customerColumns.includes('credit_limit_cents')) db.exec("ALTER TABLE customers ADD COLUMN credit_limit_cents INTEGER NOT NULL DEFAULT 0");
  if (!customerColumns.includes('opening_balance_cents')) db.exec("ALTER TABLE customers ADD COLUMN opening_balance_cents INTEGER NOT NULL DEFAULT 0");
  if (!customerColumns.includes('status')) db.exec("ALTER TABLE customers ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");

  // Seed default Chart of Accounts
  const seedAccounts = [
    [1010, '1010', 'Cash', 'asset', 'Physical cash in drawer/till'],
    [1020, '1020', 'Bank', 'asset', 'Bank account deposits and transfers'],
    [1100, '1100', 'Accounts Receivable', 'asset', 'Customer Khata / Udhaar receivables'],
    [1200, '1200', 'Merchandise Inventory', 'asset', 'Total medicine inventory at purchase cost'],
    [1300, '1300', 'Supplier Advances', 'asset', 'Advance payments made to suppliers'],
    [2010, '2010', 'Accounts Payable', 'liability', 'Outstanding amounts payable to suppliers'],
    [2100, '2100', 'Customer Advances', 'liability', 'Advance deposits received from customers'],
    [3010, '3010', 'Opening Balance Equity', 'equity', 'Equity offsetting pre-system opening balances'],
    [3020, '3020', 'Retained Earnings', 'equity', 'Accumulated earnings from operations'],
    [4010, '4010', 'Sales Revenue', 'revenue', 'Income from medicine and retail sales'],
    [4020, '4020', 'Sales Returns & Allowances', 'revenue', 'Contra revenue from customer returns'],
    [5010, '5010', 'Cost of Goods Sold', 'expense', 'Purchase cost of goods sold'],
    [6010, '6010', 'Rent Expense', 'expense', 'Pharmacy premises rental'],
    [6020, '6020', 'Electricity Expense', 'expense', 'Utility electricity bills'],
    [6030, '6030', 'Internet Expense', 'expense', 'Broadband and communications'],
    [6040, '6040', 'Salaries Expense', 'expense', 'Staff wages and compensation'],
    [6050, '6050', 'Maintenance Expense', 'expense', 'Facility and equipment repairs'],
    [6060, '6060', 'Transportation Expense', 'expense', 'Freight, carriage and travel'],
    [6070, '6070', 'Supplies Expense', 'expense', 'Packaging, stationery and consumables'],
    [6090, '6090', 'Miscellaneous Expense', 'expense', 'Other general operating expenses']
  ];
  const insertAccount = db.prepare('INSERT OR IGNORE INTO ledger_accounts(id, code, name, type, description) VALUES (?, ?, ?, ?, ?)');
  seedAccounts.forEach(acc => insertAccount.run(...acc));

  // Seed default Expense Categories
  const seedCategories = [
    ['Rent', 6010],
    ['Electricity', 6020],
    ['Internet', 6030],
    ['Salaries', 6040],
    ['Maintenance', 6050],
    ['Transportation', 6060],
    ['Supplies', 6070],
    ['Miscellaneous', 6090]
  ];
  const insertExpCat = db.prepare('INSERT OR IGNORE INTO expense_categories(name, account_id) VALUES (?, ?)');
  seedCategories.forEach(cat => insertExpCat.run(...cat));

  db.prepare('INSERT OR IGNORE INTO settings(id,data_json) VALUES (1,?)').run(JSON.stringify({
    app: 'Standalone', store: 'Multi Medicos', address_one: 'GreenTown',
    address_two: 'Karachi', contact: '03196573297', tax: '', symbol: 'PKR',
    percentage: '0', charge_tax: false, quick_billing: false,
    footer: '', img: 'multi-medicos-logo.png',
  }));
  const integrity = db.prepare('PRAGMA quick_check').get();
  if (Object.values(integrity)[0] !== 'ok') throw new Error('SQLite integrity check failed.');
} catch (error) {
  db.close();
  throw new Error(`SQLite initialization failed: ${error.message}`);
}

function transaction(work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function cents(value, allowNegative = false) {
  const number = Number(value);
  if (!Number.isFinite(number) || (!allowNegative && number < 0) || Math.abs(number * 100 - Math.round(number * 100)) > 0.0001) {
    throw new Error('Invalid money amount.');
  }
  const result = Math.round(number * 100);
  if (!Number.isSafeInteger(result)) throw new Error('Money amount is too large.');
  return result;
}

function pkr(centsAmount) {
  const num = Number(centsAmount) || 0;
  return (num / 100).toFixed(2);
}

function extractCustomerId(customer) {
  if (!customer || customer === '0' || customer === 0) return null;
  if (typeof customer === 'object') {
    const id = customer.id ?? customer._id;
    return id !== undefined && id !== null ? String(id) : null;
  }
  if (typeof customer === 'string') {
    const trimmed = customer.trim();
    if (trimmed === '' || trimmed === '0') return null;
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          const id = parsed.id ?? parsed._id;
          return id !== undefined && id !== null ? String(id) : null;
        }
      } catch {}
    }
    return trimmed;
  }
  return String(customer);
}

function audit(userId, action, entityType, entityId, details = {}, ip = '127.0.0.1') {
  try {
    db.prepare(`
      INSERT INTO audit_logs(user_id, action, entity_type, entity_id, details_json, ip_address)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      userId ? Number(userId) : null,
      String(action),
      String(entityType),
      String(entityId ?? ''),
      typeof details === 'string' ? details : JSON.stringify(details || {}),
      String(ip || '127.0.0.1')
    );
  } catch (err) {
    console.error('Audit log failed:', err.message);
  }
}

// Automatic repair for any journal lines where customer party_id was stringified as [object Object]
try {
  const brokenLines = db.prepare(`
    SELECT jl.id, s.data_json
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    JOIN sales s ON s.id = je.reference_id
    WHERE jl.account_id = 1100 AND (jl.party_id = '[object Object]' OR jl.party_id IS NULL OR jl.party_id = '')
  `).all();

  for (const bl of brokenLines) {
    try {
      const data = JSON.parse(bl.data_json);
      const cId = extractCustomerId(data.customer);
      if (cId) {
        db.prepare('UPDATE journal_lines SET party_id = ? WHERE id = ?').run(cId, bl.id);
      }
    } catch {}
  }
} catch (e) {
  console.error('Error repairing journal lines:', e);
}

module.exports = { db, filename, transaction, cents, pkr, audit, extractCustomerId };

