const express = require('express');
const app = express();
const validator = require('validator');
const moment = require('moment');
const { db, transaction, cents, pkr, audit } = require('./sqlite');
const { postJournalEntry, recordCashbookEntry } = require('./accounting');

function purchaseId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid purchase ID.');
  return id;
}

function supplierId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid supplier ID.');
  return id;
}

const PAYMENT_METHODS = new Set(['cash', 'bank', 'easypaisa', 'jazzcash', 'other']);

function paymentMethod(value) {
  const method = String(value || 'cash').toLowerCase();
  if (!PAYMENT_METHODS.has(method)) throw new Error('Unsupported payment method.');
  return method;
}

function isoDate(value, label) {
  const date = String(value || '').trim();
  if (!moment(date, 'YYYY-MM-DD', true).isValid()) {
    throw new Error(`${label} must be a valid date.`);
  }
  return date;
}

function batchExpiry(value, medicineName) {
  const date = String(value || '').trim();
  const valid = moment(date, ['YYYY-MM-DD', 'DD-MMM-YYYY'], true);
  if (!valid.isValid()) throw new Error(`Expiry date is invalid for medicine ${medicineName}.`);
  return date;
}

function formatPurchase(row) {
  if (!row) return null;
  const totalCents = Number(row.total_cents || 0);
  const paidCents = Number(row.paid_cents || 0);
  const outstandingCents = Math.max(0, totalCents - paidCents);

  return {
    id: row.id,
    invoice_no: row.invoice_no,
    supplier_id: row.supplier_id,
    supplier_name: row.supplier_name,
    supplier_phone: row.supplier_phone,
    invoice_date: row.invoice_date,
    purchase_date: row.purchase_date,
    receiving_date: row.receiving_date,
    due_date: row.due_date,
    purchase_status: row.purchase_status,
    payment_status: row.payment_status,
    total: pkr(totalCents),
    total_cents: totalCents,
    paid: pkr(paidCents),
    paid_cents: paidCents,
    outstanding: pkr(outstandingCents),
    outstanding_cents: outstandingCents,
    notes: row.notes,
    created_by: row.created_by_name || 'System',
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

// GET all purchases with filters
app.get('/all', (req, res) => {
  try {
    const { supplier_id, status, start, end } = req.query;
    let query = `
      SELECT p.*, s.name AS supplier_name, s.phone AS supplier_phone, u.fullname AS created_by_name
      FROM purchases p
      JOIN suppliers s ON s.id = p.supplier_id
      LEFT JOIN users u ON u.id = p.created_by
      WHERE 1=1
    `;
    const params = [];

    if (supplier_id) {
      query += ' AND p.supplier_id = ?';
      params.push(supplierId(supplier_id));
    }
    if (status) {
      query += ' AND p.purchase_status = ?';
      params.push(status);
    }
    if (start) {
      query += ' AND p.invoice_date >= ?';
      params.push(new Date(start).toISOString().slice(0, 10));
    }
    if (end) {
      query += ' AND p.invoice_date <= ?';
      params.push(new Date(end).toISOString().slice(0, 10));
    }

    query += ' ORDER BY p.purchase_date DESC, p.id DESC';
    const rows = db.prepare(query).all(...params);
    res.json(rows.map(formatPurchase));
  } catch (error) {
    console.error('Error fetching purchases:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET single purchase with items
app.get('/:id', (req, res) => {
  try {
    const id = purchaseId(req.params.id);
    const row = db.prepare(`
      SELECT p.*, s.name AS supplier_name, s.phone AS supplier_phone, u.fullname AS created_by_name
      FROM purchases p
      JOIN suppliers s ON s.id = p.supplier_id
      LEFT JOIN users u ON u.id = p.created_by
      WHERE p.id = ?
    `).get(id);

    if (!row) return res.status(404).json({ error: 'Purchase invoice not found.' });

    const purchase = formatPurchase(row);
    const items = db.prepare(`
      SELECT pi.*, p.barcode
      FROM purchase_items pi
      JOIN products p ON p.id = pi.product_id
      WHERE pi.purchase_id = ?
      ORDER BY pi.id ASC
    `).all(id);

    purchase.items = items.map(item => ({
      id: item.id,
      product_id: item.product_id,
      barcode: item.barcode,
      product_name: item.product_name,
      manufacturer: item.manufacturer,
      strength: item.strength,
      dosage_form: item.dosage_form,
      batch_number: item.batch_number,
      expiry_date: item.expiry_date,
      quantity: item.quantity,
      purchase_unit: item.purchase_unit,
      units_per_pack: item.units_per_pack,
      bonus_quantity: item.bonus_quantity,
      unit_cost: pkr(item.unit_cost_cents),
      unit_cost_cents: item.unit_cost_cents,
      discount: pkr(item.discount_cents),
      discount_cents: item.discount_cents,
      tax: pkr(item.tax_cents),
      tax_cents: item.tax_cents,
      line_total: pkr(item.line_total_cents),
      line_total_cents: item.line_total_cents,
      retail_price: item.retail_price_cents != null ? pkr(item.retail_price_cents) : null
    }));

    res.json(purchase);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Helper to validate and calculate purchase items
function processItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error('Purchase must include at least one medicine item.');
  }

  let totalCents = 0;
  const processed = [];

  for (const item of rawItems) {
    const productId = Number(item.product_id);
    if (!Number.isSafeInteger(productId) || productId <= 0) {
      throw new Error(`Invalid product ID in purchase item.`);
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) throw new Error(`Product ID ${productId} does not exist in inventory.`);

    const batchNumber = String(item.batch_number || '').trim();
    if (!batchNumber) throw new Error(`Batch number is required for medicine ${product.name}.`);

    const expiryDate = batchExpiry(item.expiry_date, product.name);

    const quantity = Number(item.quantity);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new Error(`Quantity must be a positive integer for ${product.name}.`);
    }

    const bonusQuantity = Number(item.bonus_quantity || 0);
    if (!Number.isSafeInteger(bonusQuantity) || bonusQuantity < 0) {
      throw new Error(`Bonus quantity must be a non-negative integer for ${product.name}.`);
    }

    const unitsPerPack = Number(item.units_per_pack || 1);
    if (!Number.isSafeInteger(unitsPerPack) || unitsPerPack < 1) {
      throw new Error(`Units per pack must be at least 1.`);
    }

    const unitCostCents = cents(item.unit_cost);
    const discountCents = item.discount ? cents(item.discount) : 0;
    const taxCents = item.tax ? cents(item.tax) : 0;

    const baseCostCents = unitCostCents * quantity;
    const lineTotalCents = Math.max(0, baseCostCents - discountCents + taxCents);

    const retailPriceCents = item.retail_price ? cents(item.retail_price) : null;

    totalCents += lineTotalCents;

    processed.push({
      product_id: productId,
      product_name: product.name,
      manufacturer: validator.escape(String(item.manufacturer || '')).trim(),
      strength: validator.escape(String(item.strength || '')).trim(),
      dosage_form: validator.escape(String(item.dosage_form || '')).trim(),
      batch_number: validator.escape(batchNumber),
      expiry_date: validator.escape(expiryDate),
      quantity,
      purchase_unit: validator.escape(String(item.purchase_unit || 'Box')).trim(),
      units_per_pack: unitsPerPack,
      bonus_quantity: bonusQuantity,
      unit_cost_cents: unitCostCents,
      discount_cents: discountCents,
      tax_cents: taxCents,
      line_total_cents: lineTotalCents,
      retail_price_cents: retailPriceCents
    });
  }

  return { items: processed, totalCents };
}

// POST create purchase (Draft or Immediate Post)
app.post('/', (req, res) => {
  try {
    const body = req.body;
    const supplierIdVal = supplierId(body.supplier_id);
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierIdVal);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found.' });

    const invoiceNo = validator.escape(String(body.invoice_no || '')).trim();
    if (!invoiceNo) return res.status(400).json({ error: 'Supplier invoice number is required.' });

    // Duplicate check for supplier invoice
    const duplicate = db.prepare('SELECT id FROM purchases WHERE supplier_id = ? AND LOWER(invoice_no) = LOWER(?)').get(supplierIdVal, invoiceNo);
    if (duplicate) {
      return res.status(409).json({ error: 'Duplicate invoice', message: `Invoice ${invoiceNo} already exists for this supplier.` });
    }

    const invoiceDate = isoDate(body.invoice_date || moment().utcOffset(300).format('YYYY-MM-DD'), 'Invoice date');
    const purchaseDate = new Date().toISOString();
    const dueDate = body.due_date ? isoDate(body.due_date, 'Due date') : null;
    const notes = validator.escape(String(body.notes || '')).trim();
    const isReceiveNow = body.status === 'received';
    const userId = req.authUser ? req.authUser._id : null;

    const { items, totalCents } = processItems(body.items);

    const initialPaidAmount = body.paid_amount ? cents(body.paid_amount) : 0;
    if (initialPaidAmount > totalCents) {
      return res.status(400).json({ error: 'Paid amount cannot exceed total purchase amount.' });
    }

    const selectedPaymentMethod = paymentMethod(body.payment_method);

    const resultPurchaseId = transaction(() => {
      // 1. Insert purchase header
      const insertPurchase = db.prepare(`
        INSERT INTO purchases(
          invoice_no, supplier_id, invoice_date, purchase_date, receiving_date, due_date,
          purchase_status, payment_status, total_cents, paid_cents, notes, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const purchaseStatus = isReceiveNow ? 'received' : 'draft';
      const paymentStatus = initialPaidAmount === 0 ? 'unpaid' : (initialPaidAmount === totalCents ? 'paid' : 'partially_paid');
      const receivingDate = isReceiveNow ? new Date().toISOString() : null;

      const pRes = insertPurchase.run(
        invoiceNo, supplierIdVal, invoiceDate, purchaseDate, receivingDate, dueDate,
        purchaseStatus, paymentStatus, totalCents, initialPaidAmount, notes, userId
      );
      const newPurchaseId = Number(pRes.lastInsertRowid);

      // 2. Insert items
      const insertItem = db.prepare(`
        INSERT INTO purchase_items(
          purchase_id, product_id, product_name, manufacturer, strength, dosage_form,
          batch_number, expiry_date, quantity, purchase_unit, units_per_pack, bonus_quantity,
          unit_cost_cents, discount_cents, tax_cents, line_total_cents, retail_price_cents
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const it of items) {
        insertItem.run(
          newPurchaseId, it.product_id, it.product_name, it.manufacturer, it.strength, it.dosage_form,
          it.batch_number, it.expiry_date, it.quantity, it.purchase_unit, it.units_per_pack, it.bonus_quantity,
          it.unit_cost_cents, it.discount_cents, it.tax_cents, it.line_total_cents, it.retail_price_cents
        );
      }

      // 3. If posting/receiving now, atomically update inventory and accounting
      if (isReceiveNow) {
        receivePurchaseStockAndPost({
          purchaseId: newPurchaseId,
          supplierId: supplierIdVal,
          supplierName: supplier.name,
          invoiceNo,
          invoiceDate,
          items,
          totalCents,
          initialPaidAmount,
          paymentMethod: selectedPaymentMethod,
          userId
        });
      }

      audit(userId, 'CREATE_PURCHASE', 'purchase', newPurchaseId, {
        supplier_id: supplierIdVal,
        invoice_no: invoiceNo,
        status: purchaseStatus,
        total: pkr(totalCents)
      });

      return newPurchaseId;
    });

    res.status(201).json({ id: resultPurchaseId, message: isReceiveNow ? 'Purchase received and posted successfully.' : 'Purchase draft saved successfully.' });
  } catch (error) {
    console.error('Error creating purchase:', error);
    res.status(error.message.includes('Duplicate') ? 409 : 400).json({ error: error.message });
  }
});

// POST receive and post a draft purchase
app.post('/:id/receive', (req, res) => {
  try {
    const id = purchaseId(req.params.id);
    const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(id);
    if (!purchase) return res.status(404).json({ error: 'Purchase not found.' });

    if (purchase.purchase_status === 'received') {
      return res.status(409).json({ error: 'Purchase has already been received into stock.' });
    }
    if (purchase.purchase_status === 'cancelled') {
      return res.status(400).json({ error: 'Cancelled purchase cannot be received.' });
    }

    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(purchase.supplier_id);
    const items = db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ?').all(id);
    if (items.length === 0) return res.status(400).json({ error: 'Purchase has no items to receive.' });

    const body = req.body || {};
    const paidAmount = body.paid_amount ? cents(body.paid_amount) : Number(purchase.paid_cents || 0);
    if (paidAmount < 0 || paidAmount > Number(purchase.total_cents)) {
      return res.status(400).json({ error: 'Paid amount must be between zero and the purchase total.' });
    }
    const selectedPaymentMethod = paymentMethod(body.payment_method);
    const userId = req.authUser ? req.authUser._id : null;

    transaction(() => {
      const receivingDate = new Date().toISOString();
      const paymentStatus = paidAmount === 0 ? 'unpaid' : (paidAmount >= purchase.total_cents ? 'paid' : 'partially_paid');

      db.prepare(`
        UPDATE purchases
        SET purchase_status = 'received', receiving_date = ?, paid_cents = ?, payment_status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(receivingDate, paidAmount, paymentStatus, id);

      receivePurchaseStockAndPost({
        purchaseId: id,
        supplierId: purchase.supplier_id,
        supplierName: supplier.name,
        invoiceNo: purchase.invoice_no,
        invoiceDate: purchase.invoice_date,
        items,
        totalCents: purchase.total_cents,
        initialPaidAmount: paidAmount,
        paymentMethod: selectedPaymentMethod,
        userId
      });

      audit(userId, 'RECEIVE_PURCHASE', 'purchase', id, {
        supplier_id: purchase.supplier_id,
        invoice_no: purchase.invoice_no,
        total: pkr(purchase.total_cents)
      });
    });

    res.json({ message: 'Purchase received into stock and posted to ledger successfully.' });
  } catch (error) {
    console.error('Error receiving purchase:', error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * Internal helper to atomically update inventory batches, overall stock, and accounting entries.
 * Must be called inside transaction().
 */
function receivePurchaseStockAndPost({ purchaseId, supplierId, supplierName, invoiceNo, invoiceDate, items, totalCents, initialPaidAmount, paymentMethod, userId }) {
  const receivingDate = new Date().toISOString();

  // 1. Process each item into inventory batches and overall inventory
  for (const item of items) {
    const totalQty = item.quantity + (item.bonus_quantity || 0);

    // Check if batch already exists for this product & batch number & expiry
    const existingBatch = db.prepare(`
      SELECT * FROM inventory_batches
      WHERE product_id = ? AND batch_number = ? AND expiry_date = ?
    `).get(item.product_id, item.batch_number, item.expiry_date);

    let batchId;
    if (existingBatch) {
      batchId = existingBatch.id;
      db.prepare(`
        UPDATE inventory_batches
        SET quantity_available = quantity_available + ?, unit_cost_cents = ?
        WHERE id = ?
      `).run(totalQty, item.unit_cost_cents, batchId);
    } else {
      const batchRes = db.prepare(`
        INSERT INTO inventory_batches(
          product_id, supplier_id, purchase_id, batch_number, expiry_date,
          initial_quantity, quantity_available, unit_cost_cents, received_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        item.product_id, supplierId, purchaseId, item.batch_number, item.expiry_date,
        totalQty, totalQty, item.unit_cost_cents, receivingDate
      );
      batchId = Number(batchRes.lastInsertRowid);
    }

    // Update overall inventory quantity
    db.prepare('UPDATE inventory SET quantity = quantity + ? WHERE product_id = ?').run(totalQty, item.product_id);

    // Get current total inventory for stock movement balance
    const currentStock = db.prepare('SELECT quantity FROM inventory WHERE product_id = ?').get(item.product_id).quantity;

    // Record stock movement
    db.prepare(`
      INSERT INTO stock_movements(product_id, batch_id, movement_type, quantity, balance_after, reference_id, user_id, notes)
      VALUES (?, ?, 'PURCHASE_RECEIPT', ?, ?, ?, ?, ?)
    `).run(
      item.product_id, batchId, totalQty, currentStock, `PUR-${purchaseId}`, userId,
      `Received batch ${item.batch_number} from invoice ${invoiceNo}`
    );

    // Product expiry is retained for the legacy POS validation. Batches remain the
    // authoritative FEFO records, while a blank quick-added product receives its
    // first valid batch expiry here.
    const productRecord = db.prepare('SELECT expiration_date FROM products WHERE id = ?').get(item.product_id);
    if (productRecord && !String(productRecord.expiration_date || '').trim()) {
      const legacyExpiry = moment(item.expiry_date, ['YYYY-MM-DD', 'DD-MMM-YYYY'], true).format('DD-MMM-YYYY');
      db.prepare('UPDATE products SET expiration_date = ? WHERE id = ?').run(legacyExpiry, item.product_id);
    }

    // If retail price was provided, update the product record.
    if (item.retail_price_cents != null && item.retail_price_cents > 0) {
      db.prepare('UPDATE products SET price_cents = ? WHERE id = ?').run(item.retail_price_cents, item.product_id);
    }
  }

  // 2. Post Accounting Double Entry:
  // Debit: Merchandise Inventory (1200) for total purchase cost
  // Credit: Accounts Payable (2010), party_type='supplier', party_id=supplierId
  postJournalEntry({
    entryDate: receivingDate,
    referenceType: 'PURCHASE',
    referenceId: `PUR-${purchaseId}`,
    description: `Purchase received: Inv ${invoiceNo} from ${supplierName}`,
    userId,
    lines: [
      {
        accountId: 1200, // Merchandise Inventory
        debitCents: totalCents,
        creditCents: 0,
        lineDescription: `Inventory receipt Inv #${invoiceNo}`
      },
      {
        accountId: 2010, // Accounts Payable
        debitCents: 0,
        creditCents: totalCents,
        partyType: 'supplier',
        partyId: supplierId,
        lineDescription: `Payable for Inv #${invoiceNo}`
      }
    ]
  });

  // 3. If immediate payment was made:
  if (initialPaidAmount > 0) {
    const paymentNumber = `PAY-PUR-${purchaseId}`;
    const insertPayment = db.prepare(`
      INSERT INTO payments(payment_number, party_type, party_id, payment_date, amount_cents, payment_method, reference_number, notes, user_id)
      VALUES (?, 'supplier', ?, ?, ?, ?, ?, ?, ?)
    `);
    const payRes = insertPayment.run(
      paymentNumber, String(supplierId), receivingDate, initialPaidAmount, paymentMethod,
      invoiceNo, `Immediate payment at purchase receipt for Inv #${invoiceNo}`, userId
    );
    const paymentId = Number(payRes.lastInsertRowid);

    // Allocation
    db.prepare(`
      INSERT INTO payment_allocations(payment_id, invoice_type, invoice_id, allocated_cents)
      VALUES (?, 'purchase', ?, ?)
    `).run(paymentId, String(purchaseId), initialPaidAmount);

    // Post double entry for payment:
    // Debit: Accounts Payable (2010)
    // Credit: Cash (1010) or Bank (1020)
    const assetAccount = paymentMethod === 'bank' ? 1020 : 1010;
    postJournalEntry({
      entryDate: receivingDate,
      referenceType: 'SUPPLIER_PAYMENT',
      referenceId: paymentNumber,
      description: `Payment to ${supplierName} for Inv #${invoiceNo} (${paymentMethod})`,
      userId,
      lines: [
        {
          accountId: 2010, // Accounts Payable
          debitCents: initialPaidAmount,
          creditCents: 0,
          partyType: 'supplier',
          partyId: supplierId,
          lineDescription: `Payment settlement Inv #${invoiceNo}`
        },
        {
          accountId: assetAccount, // Cash or Bank
          debitCents: 0,
          creditCents: initialPaidAmount,
          lineDescription: `Payment out via ${paymentMethod}`
        }
      ]
    });

    // Record in cashbook if paid in cash
    if (paymentMethod === 'cash') {
      recordCashbookEntry({
        entryDate: receivingDate,
        entryType: 'SUPPLIER_PAYMENT',
        inflowCents: 0,
        outflowCents: initialPaidAmount,
        referenceType: 'PAYMENT',
        referenceId: paymentNumber,
        description: `Supplier payment to ${supplierName} (Inv #${invoiceNo})`,
        userId
      });
    }
  }
}

// POST purchase return
app.post('/:id/return', (req, res) => {
  try {
    const id = purchaseId(req.params.id);
    const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(id);
    if (!purchase) return res.status(404).json({ error: 'Purchase not found.' });
    if (purchase.purchase_status !== 'received') {
      return res.status(400).json({ error: 'Can only return items from received purchases.' });
    }

    const body = req.body;
    const productId = Number(body.product_id);
    const batchNumber = String(body.batch_number || '').trim();
    const returnQty = Number(body.quantity);
    const reason = validator.escape(String(body.reason || '')).trim();
    const userId = req.authUser ? req.authUser._id : null;

    if (!Number.isSafeInteger(productId) || productId <= 0) return res.status(400).json({ error: 'Invalid product ID.' });
    if (!Number.isSafeInteger(returnQty) || returnQty <= 0) return res.status(400).json({ error: 'Return quantity must be positive.' });

    const batch = db.prepare(`
      SELECT * FROM inventory_batches
      WHERE product_id = ? AND batch_number = ? AND purchase_id = ?
    `).get(productId, batchNumber, id);

    if (!batch) {
      return res.status(404).json({ error: `Batch ${batchNumber} for product was not found under this purchase.` });
    }

    if (batch.quantity_available < returnQty) {
      return res.status(409).json({
        error: 'Insufficient stock in batch',
        message: `Available stock in batch ${batchNumber} is ${batch.quantity_available}, cannot return ${returnQty}.`
      });
    }

    const unitCostCents = batch.unit_cost_cents;
    const totalReturnCents = unitCostCents * returnQty;
    const returnNumber = `PRET-${id}-${Date.now().toString().slice(-6)}`;
    const returnDate = new Date().toISOString();

    transaction(() => {
      // 1. Deduct from batch
      db.prepare('UPDATE inventory_batches SET quantity_available = quantity_available - ? WHERE id = ?').run(returnQty, batch.id);

      // 2. Deduct from overall inventory
      db.prepare('UPDATE inventory SET quantity = quantity - ? WHERE product_id = ?').run(returnQty, productId);

      // 3. Movement log
      const currentStock = db.prepare('SELECT quantity FROM inventory WHERE product_id = ?').get(productId).quantity;
      db.prepare(`
        INSERT INTO stock_movements(product_id, batch_id, movement_type, quantity, balance_after, reference_id, user_id, notes)
        VALUES (?, ?, 'PURCHASE_RETURN', ?, ?, ?, ?, ?)
      `).run(productId, batch.id, -returnQty, currentStock, returnNumber, userId, `Return from Inv #${purchase.invoice_no}: ${reason}`);

      // 4. Insert purchase_returns
      db.prepare(`
        INSERT INTO purchase_returns(return_number, purchase_id, supplier_id, product_id, batch_id, quantity, unit_cost_cents, total_cents, reason, return_date, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(returnNumber, id, purchase.supplier_id, productId, batch.id, returnQty, unitCostCents, totalReturnCents, reason, returnDate, userId);

      // 5. Accounting adjustment:
      // Debit: Accounts Payable (2010) (reduces payable to supplier)
      // Credit: Merchandise Inventory (1200) (reduces inventory value)
      postJournalEntry({
        entryDate: returnDate,
        referenceType: 'PURCHASE_RETURN',
        referenceId: returnNumber,
        description: `Purchase return: Batch ${batchNumber} to Supplier ID ${purchase.supplier_id}`,
        userId,
        lines: [
          {
            accountId: 2010, // Accounts Payable
            debitCents: totalReturnCents,
            creditCents: 0,
            partyType: 'supplier',
            partyId: purchase.supplier_id,
            lineDescription: `Return adjustment for Inv #${purchase.invoice_no}`
          },
          {
            accountId: 1200, // Merchandise Inventory
            debitCents: 0,
            creditCents: totalReturnCents,
            lineDescription: `Inventory reduced by return`
          }
        ]
      });

      audit(userId, 'PURCHASE_RETURN', 'purchase_return', returnNumber, {
        purchase_id: id,
        product_id: productId,
        batch_number: batchNumber,
        quantity: returnQty,
        total: pkr(totalReturnCents)
      });
    });

    res.json({ message: 'Purchase return processed successfully.', return_number: returnNumber, total_refund: pkr(totalReturnCents) });
  } catch (error) {
    console.error('Error processing purchase return:', error);
    res.status(400).json({ error: error.message });
  }
});

module.exports = app;
