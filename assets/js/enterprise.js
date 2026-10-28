// Multi Medicos Enterprise Management Module
// Integrated Suppliers, Purchasing, Batch Inventory, Khata, Expenses & Reports

$(document).ready(function () {
  const Store = require("electron-store");
  const notiflix = require("notiflix");
  const storage = new Store();
  const getPort = () => process.env.PORT || "3210";
  const getApiUrl = (endpoint) => `http://localhost:${getPort()}/api/${endpoint}`;

  function getAuthToken() {
    try {
      const session = storage.get("auth");
      if (session && session.token) return session.token;
      const user = storage.get("user");
      return user && user.token ? user.token : "";
    } catch {
      return "";
    }
  }

  function apiAjax(endpoint, options = {}) {
    const token = getAuthToken();
    const defaults = {
      url: getApiUrl(endpoint),
      headers: token ? { "X-Access-Token": token } : {},
      contentType: "application/json; charset=utf-8"
    };
    return $.ajax(Object.assign({}, defaults, options));
  }

  function formatMoney(amount) {
    const num = Number(amount) || 0;
    return "PKR " + num.toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>'"]/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character];
    });
  }

  function karachiDate() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(new Date());
    const value = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day}`;
  }

  // ==========================================
  // NAVIGATION & TAB SWITCHING
  // ==========================================

  $(document).on("click", ".nav-tab", function () {
    const viewName = $(this).data("view");
    $(".nav-tab").removeClass("active");
    $(this).addClass("active");

    $(".enterprise-view").hide();
    $("#transactions_view").hide();

    if (viewName === "pos") {
      $("#pos_view").show();
      $("#pointofsale").hide();
      $("#transactions").show();
    } else {
      $("#pos_view").hide();
      $("#transactions").show();
      $("#pointofsale").show();

      $(`#${viewName}_view`).show();

      switch (viewName) {
        case "dashboard":
          loadDashboard();
          break;
        case "purchases":
          loadPurchases();
          break;
        case "suppliers":
          loadSuppliers();
          break;
        case "customers_khata":
          loadCustomersKhata();
          break;
        case "expenses":
          loadExpenses();
          break;
        case "reports":
          loadReports();
          break;
      }
    }
  });

  // ==========================================
  // 1. DASHBOARD
  // ==========================================

  function loadDashboard() {
    apiAjax("ledger/dashboard-summary", { type: "GET" })
      .done(function (data) {
        $("#dash_receivables").text(formatMoney(data.total_receivables));
        $("#dash_payables").text(formatMoney(data.total_payables));
        $("#dash_cash").text(formatMoney(data.cash_balance));
        $("#dash_collections").text(formatMoney(data.today_collections));
        $("#dash_supplier_payments").text(formatMoney(data.today_supplier_payments));
        $("#dash_expenses").text(formatMoney(data.today_expenses));
        $("#dash_overdue").text(data.overdue_invoices_count);
      })
      .fail(function (xhr) {
        console.error("Dashboard load failed:", xhr);
      });
  }

  // ==========================================
  // 2. SUPPLIER MANAGEMENT
  // ==========================================

  let cachedSuppliers = [];
  let supplierReturnToPurchase = false;

  function loadSuppliers() {
    apiAjax("suppliers/all", { type: "GET" })
      .done(function (suppliers) {
        cachedSuppliers = suppliers;
        renderSuppliersTable(suppliers);
      })
      .fail(function (xhr) {
        notiflix.Report.failure("Error", xhr.responseJSON?.error || "Failed to load suppliers.", "Ok");
      });
  }

  function renderSuppliersTable(suppliers) {
    const $tbody = $("#suppliers_table_body");
    $tbody.empty();

    if (!suppliers || suppliers.length === 0) {
      $tbody.html('<tr><td colspan="7" class="text-center text-muted p-4">No suppliers found. Click "Add Supplier" to register one.</td></tr>');
      return;
    }

    suppliers.forEach(function (s) {
      const payableCents = Number(s.outstanding_payable_cents || 0);
      const payableClass = payableCents > 0 ? "money-positive" : "money-neutral";
      const statusBadge = s.status === "active" ? '<span class="badge-status badge-paid">Active</span>' : '<span class="badge-status badge-cancelled">Inactive</span>';

      const tr = `
        <tr>
          <td><strong>${s.id}</strong></td>
          <td><strong>${s.name}</strong><br><small class="text-muted">${s.contact_person || ""}</small></td>
          <td>${s.phone || "-"}<br><small class="text-muted">${s.email || ""}</small></td>
          <td>${s.payment_terms} (${s.due_period_days} days)</td>
          <td class="${payableClass}"><strong>${formatMoney(s.outstanding_payable)}</strong></td>
          <td>${statusBadge}</td>
          <td>
            <div class="btn-group btn-group-xs">
              <button class="btn btn-default btn-xs btn-view-statement" data-id="${s.id}" title="Statement"><i class="fa fa-file-text-o"></i> Statement</button>
              <button class="btn btn-success btn-xs btn-pay-supplier" data-id="${s.id}" title="Pay"><i class="fa fa-money"></i> Pay</button>
              <button class="btn btn-info btn-xs btn-edit-supplier" data-id="${s.id}" title="Edit"><i class="fa fa-pencil"></i></button>
            </div>
          </td>
        </tr>
      `;
      $tbody.append(tr);
    });
  }

  // Filter suppliers on search input
  $(document).on("input", "#supplier_search", function () {
    const q = $(this).val().toLowerCase();
    const filtered = cachedSuppliers.filter(s =>
      s.name.toLowerCase().includes(q) ||
      (s.phone && s.phone.includes(q)) ||
      (s.contact_person && s.contact_person.toLowerCase().includes(q))
    );
    renderSuppliersTable(filtered);
  });

  // Open Add Supplier Modal
  $(document).on("click", "#btn_add_supplier", function () {
    if (!supplierReturnToPurchase) $("#modal_supplier").removeData("return-to-purchase");
    $("#form_supplier")[0].reset();
    $("#supplier_id_input").val("");
    $("#supplier_status_input").val("active");
    $("#supplier_terms_input").val("Net 30");
    $("#supplier_due_days_input").val("30");
    $("#supplier_additional_details").collapse("hide");
    $("#supplier_opening_balance_confirm").prop("checked", false);
    $("#supplier_opening_balance_input").val("").prop("disabled", true);
    $("#supplier_opening_balance_fields").hide();
    $("#supplier_opening_balance_group").show();
    $("#modal_supplier_title").text("Add New Supplier");
    $("#modal_supplier").modal("show");
  });

  $(document).on("change", "#supplier_opening_balance_confirm", function () {
    const enabled = $(this).is(":checked");
    $("#supplier_opening_balance_fields").toggle(enabled);
    $("#supplier_opening_balance_input").prop("disabled", !enabled);
    if (!enabled) $("#supplier_opening_balance_input").val("");
  });

  // Edit Supplier
  $(document).on("click", ".btn-edit-supplier", function () {
    const id = $(this).data("id");
    const supplier = cachedSuppliers.find(s => s.id === id);
    if (!supplier) return;

    $("#supplier_id_input").val(supplier.id);
    $("#supplier_name_input").val(supplier.name);
    $("#supplier_contact_input").val(supplier.contact_person);
    $("#supplier_phone_input").val(supplier.phone);
    $("#supplier_email_input").val(supplier.email);
    $("#supplier_address_input").val(supplier.address);
    $("#supplier_terms_input").val(supplier.payment_terms);
    $("#supplier_due_days_input").val(supplier.due_period_days);
    $("#supplier_status_input").val(supplier.status);
    $("#supplier_notes_input").val(supplier.notes);
    $("#supplier_additional_details").collapse("hide");

    // Opening balance cannot be changed on edit (must use opening balance adjustment)
    $("#supplier_opening_balance_group").hide();
    $("#modal_supplier_title").text("Edit Supplier: " + supplier.name);
    $("#modal_supplier").modal("show");
  });

  // Save Supplier Form
  $("#form_supplier").on("submit", function (e) {
    e.preventDefault();
    const id = $("#supplier_id_input").val();
    const isEdit = Boolean(id);

    const payload = {
      name: $("#supplier_name_input").val().trim(),
      contact_person: $("#supplier_contact_input").val().trim(),
      phone: $("#supplier_phone_input").val().trim(),
      email: $("#supplier_email_input").val().trim(),
      address: $("#supplier_address_input").val().trim(),
      payment_terms: $("#supplier_terms_input").val().trim(),
      due_period_days: $("#supplier_due_days_input").val() || 30,
      status: $("#supplier_status_input").val(),
      notes: $("#supplier_notes_input").val().trim(),
      opening_balance: !isEdit && $("#supplier_opening_balance_confirm").is(":checked")
        ? ($("#supplier_opening_balance_input").val() || 0)
        : 0
    };

    if (!payload.name) {
      notiflix.Report.warning("Supplier Name Required", "Enter the supplier name before saving.", "Ok");
      return;
    }
    if (Number(payload.opening_balance) < 0) {
      notiflix.Report.warning("Invalid Opening Balance", "Previous opening balance cannot be negative.", "Ok");
      return;
    }

    const endpoint = isEdit ? `suppliers/${id}` : "suppliers";
    const method = isEdit ? "PUT" : "POST";

    apiAjax(endpoint, { type: method, data: JSON.stringify(payload) })
      .done(function (result) {
        const returnToPurchase = (supplierReturnToPurchase || $("#modal_supplier").data("return-to-purchase") === true) && !isEdit;
        supplierReturnToPurchase = false;
        if (returnToPurchase && result && result.id) {
          const created = { id: Number(result.id), name: payload.name, phone: payload.phone, status: "active" };
          cachedSuppliers.push(created);
          selectPurchaseSupplier(created);
          setTimeout(function () { $("body").addClass("modal-open"); }, 350);
        }
        $("#modal_supplier").modal("hide");
        notiflix.Notify.success(isEdit ? "Supplier updated successfully." : "Supplier created successfully.");
        loadSuppliers();
      })
      .fail(function (xhr) {
        notiflix.Report.failure("Save Failed", xhr.responseJSON?.message || xhr.responseJSON?.error || "Please try again.", "Ok");
      });
  });

  // Supplier Statement Modal
  $(document).on("click", ".btn-view-statement", function () {
    const id = $(this).data("id");
    loadSupplierStatement(id);
  });

  function loadSupplierStatement(id, start = "", end = "") {
    let url = `suppliers/${id}/statement`;
    if (start && end) url += `?start=${start}&end=${end}`;

    apiAjax(url, { type: "GET" })
      .done(function (data) {
        $("#stmt_supplier_name").text(data.supplier.name);
        $("#stmt_supplier_phone").text(data.supplier.phone || "-");
        $("#stmt_supplier_balance").text(formatMoney(data.current_payable));
        $("#stmt_filter_id").val(id);

        const $tbody = $("#stmt_table_body");
        $tbody.empty();

        if (!data.transactions || data.transactions.length === 0) {
          $tbody.html('<tr><td colspan="6" class="text-center text-muted p-3">No financial transactions recorded for this supplier.</td></tr>');
        } else {
          data.transactions.forEach(function (tx) {
            const dateStr = new Date(tx.date).toLocaleDateString("en-PK");
            const tr = `
              <tr>
                <td>${dateStr}</td>
                <td><strong>${tx.reference_number}</strong></td>
                <td>${tx.description}</td>
                <td class="text-right text-success">${tx.debit ? formatMoney(tx.debit) : "-"}</td>
                <td class="text-right text-danger">${tx.credit ? formatMoney(tx.credit) : "-"}</td>
                <td class="text-right"><strong>${formatMoney(tx.balance)}</strong></td>
              </tr>
            `;
            $tbody.append(tr);
          });
        }

        $("#modal_supplier_statement").modal("show");
      })
      .fail(function (xhr) {
        notiflix.Report.failure("Error", xhr.responseJSON?.error || "Failed to load statement.", "Ok");
      });
  }

  // Filter Statement
  $(document).on("click", "#btn_filter_statement", function () {
    const id = $("#stmt_filter_id").val();
    const start = $("#stmt_start_date").val();
    const end = $("#stmt_end_date").val();
    loadSupplierStatement(id, start, end);
  });

  // Supplier Payment Modal
  $(document).on("click", ".btn-pay-supplier", function () {
    const id = $(this).data("id");
    const supplier = cachedSuppliers.find(s => s.id === id);
    if (!supplier) return;

    $("#pay_supplier_id").val(supplier.id);
    $("#pay_supplier_name").text(supplier.name);
    $("#pay_supplier_balance").text(formatMoney(supplier.outstanding_payable));
    $("#pay_amount_input").val("");
    $("#pay_ref_input").val("");
    $("#pay_notes_input").val("");

    // Load unpaid purchase invoices for this supplier
    apiAjax(`suppliers/${id}/invoices/unpaid`, { type: "GET" })
      .done(function (invoices) {
        const $tbody = $("#pay_invoices_tbody");
        $tbody.empty();

        if (!invoices || invoices.length === 0) {
          $tbody.html('<tr><td colspan="5" class="text-center text-muted">No unpaid invoices pending. Payment will be recorded as advance.</td></tr>');
        } else {
          invoices.forEach(function (inv) {
            const tr = `
              <tr>
                <td><strong>${inv.invoice_no}</strong></td>
                <td>${inv.invoice_date}</td>
                <td>${formatMoney(inv.total)}</td>
                <td class="text-danger font-weight-bold">${formatMoney(inv.outstanding)}</td>
                <td>
                  <input type="number" step="0.01" min="0" max="${inv.outstanding}" class="form-control input-sm pay-alloc-input" data-invoice-id="${inv.id}" placeholder="0.00" />
                </td>
              </tr>
            `;
            $tbody.append(tr);
          });
        }

        $("#modal_supplier_payment").modal("show");
      });
  });

  // Submit Supplier Payment
  $("#form_supplier_payment").on("submit", function (e) {
    e.preventDefault();
    const supplierId = $("#pay_supplier_id").val();
    const amount = Number($("#pay_amount_input").val());
    if (!amount || amount <= 0) {
      notiflix.Report.warning("Invalid Amount", "Please enter a valid payment amount.", "Ok");
      return;
    }

    const allocations = [];
    $(".pay-alloc-input").each(function () {
      const allocAmt = Number($(this).val());
      if (allocAmt > 0) {
        allocations.push({
          invoice_id: $(this).data("invoice-id"),
          amount: allocAmt
        });
      }
    });

    const payload = {
      party_type: "supplier",
      party_id: supplierId,
      amount: amount,
      payment_method: $("#pay_method_select").val(),
      reference_number: $("#pay_ref_input").val().trim(),
      notes: $("#pay_notes_input").val().trim(),
      allocations
    };

    apiAjax("ledger/payments", { type: "POST", data: JSON.stringify(payload) })
      .done(function () {
        $("#modal_supplier_payment").modal("hide");
        notiflix.Notify.success("Payment recorded successfully.");
        loadSuppliers();
        loadDashboard();
      })
      .fail(function (xhr) {
        notiflix.Report.failure("Payment Failed", xhr.responseJSON?.message || xhr.responseJSON?.error || "Error recording payment.", "Ok");
      });
  });

  // ==========================================
  // 3. PURCHASES MANAGEMENT
  // ==========================================

  let cachedPurchases = [];

  function loadPurchases() {
    apiAjax("purchases/all", { type: "GET" })
      .done(function (purchases) {
        cachedPurchases = purchases;
        renderPurchasesTable(purchases);
      })
      .fail(function (xhr) {
        notiflix.Report.failure("Error", xhr.responseJSON?.error || "Failed to load purchases.", "Ok");
      });
  }

  function renderPurchasesTable(purchases) {
    const $tbody = $("#purchases_table_body");
    $tbody.empty();

    if (!purchases || purchases.length === 0) {
      $tbody.html('<tr><td colspan="8" class="text-center text-muted p-4">No purchases found. Click "New Purchase" to record one.</td></tr>');
      return;
    }

    purchases.forEach(function (p) {
      const statusClass = `badge-${p.purchase_status}`;
      const payStatusClass = `badge-${p.payment_status}`;

      const tr = `
        <tr>
          <td><strong>${p.invoice_no}</strong></td>
          <td><strong>${p.supplier_name}</strong></td>
          <td>${p.invoice_date}</td>
          <td><span class="badge-status ${statusClass}">${p.purchase_status}</span></td>
          <td><span class="badge-status ${payStatusClass}">${p.payment_status}</span></td>
          <td><strong>${formatMoney(p.total)}</strong></td>
          <td class="text-danger">${formatMoney(p.outstanding)}</td>
          <td>
            <div class="btn-group btn-group-xs">
              <button class="btn btn-default btn-xs btn-view-purchase" data-id="${p.id}" title="View"><i class="fa fa-eye"></i></button>
              ${p.purchase_status === 'draft' ? `<button class="btn btn-success btn-xs btn-receive-purchase" data-id="${p.id}" title="Receive Stock"><i class="fa fa-check"></i> Receive</button>` : ''}
              ${p.purchase_status === 'received' ? `<button class="btn btn-warning btn-xs btn-return-purchase" data-id="${p.id}" title="Return Items"><i class="fa fa-reply"></i> Return</button>` : ''}
            </div>
          </td>
        </tr>
      `;
      $tbody.append(tr);
    });
  }

  // Open New Purchase Modal
  $(document).on("click", "#btn_new_purchase", async function () {
    $("#form_new_purchase")[0].reset();
    $("#purchase_items_cards").empty();
    $("#purchase_items_empty").show();
    $("#pur_supplier_select").val("");
    $("#pur_supplier_search, #pur_medicine_search, #pur_invoice_no").val("");
    $("#pur_payment_mode").val("fully_paid");
    $("#pur_receiving_mode").val("received");
    $("#pur_paid_now_group").hide();
    $("#pur_paid_now").val("");
    $("#purchase_additional_details").collapse("hide");
    $("#pur_date_input").val(karachiDate());
    $("#modal_new_purchase").modal("show");
    $("#pur_supplier_search, #pur_medicine_search").prop("disabled", true);

    try {
      const results = await Promise.all([
        apiAjax("suppliers/all", { type: "GET" }),
        loadProductsForPurchase(true)
      ]);
      cachedSuppliers = results[0] || [];
      $("#pur_supplier_search, #pur_medicine_search").prop("disabled", false);
      renderPurchaseSupplierResults("");
      renderPurchaseMedicineResults("");
      updatePurchaseSummary();
      setTimeout(function () { $("#pur_supplier_search").focus(); }, 250);
    } catch (xhr) {
      $("#pur_supplier_search, #pur_medicine_search").prop("disabled", false);
      notiflix.Report.failure("Purchase Form", xhr.responseJSON?.error || "Suppliers or medicines could not be loaded.", "Ok");
    }
  });

  let cachedProductsList = [];
  let purchaseSubmitting = false;

  function loadProductsForPurchase(force = false) {
    if (!force && cachedProductsList.length > 0) return Promise.resolve(cachedProductsList);
    return apiAjax("inventory/products", { type: "GET" }).then(function (products) {
      cachedProductsList = products || [];
      return cachedProductsList;
    });
  }

  function moneyCents(value) {
    const text = String(value == null ? "" : value).trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
    const [whole, decimal = ""] = text.split(".");
    const result = Number(whole) * 100 + Number((decimal + "00").slice(0, 2));
    return Number.isSafeInteger(result) ? result : null;
  }

  function centsText(value) {
    return (Number(value || 0) / 100).toFixed(2);
  }

  function renderPurchaseSupplierResults(query) {
    const q = String(query || "").trim().toLowerCase();
    const matches = cachedSuppliers.filter(function (supplier) {
      return supplier.status !== "inactive" && (!q || supplier.name.toLowerCase().includes(q) || String(supplier.phone || "").includes(q));
    }).slice(0, 10);
    const $results = $("#pur_supplier_results").empty();
    if (matches.length === 0) {
      $results.html('<div class="purchase-search-no-results">No matching supplier. Use “Add Supplier”.</div>').show();
      return;
    }
    matches.forEach(function (supplier) {
      $("<button>", { type: "button", class: "purchase-search-option", "data-id": supplier.id })
        .append($("<strong>").text(supplier.name), $("<small>").text(supplier.phone || "No phone number"))
        .appendTo($results);
    });
    $results.show();
  }

  function selectPurchaseSupplier(supplier) {
    if (!supplier) return;
    $("#pur_supplier_select").val(String(supplier.id));
    $("#pur_supplier_search").val(supplier.name).removeClass("has-error");
    $("#pur_supplier_results").hide();
  }

  $(document).on("focus input", "#pur_supplier_search", function () {
    $("#pur_supplier_select").val("");
    renderPurchaseSupplierResults($(this).val());
  });

  $(document).on("click", "#pur_supplier_results .purchase-search-option", function () {
    selectPurchaseSupplier(cachedSuppliers.find(s => String(s.id) === String($(this).data("id"))));
  });

  $(document).on("click", "#btn_purchase_add_supplier", function () {
    supplierReturnToPurchase = true;
    $("#modal_supplier").data("return-to-purchase", true);
    $("#btn_add_supplier").trigger("click");
  });

  $("#modal_supplier").on("hidden.bs.modal", function () {
    supplierReturnToPurchase = false;
    $(this).removeData("return-to-purchase");
    if ($("#modal_new_purchase").hasClass("in")) $("body").addClass("modal-open");
  });

  function productSearchText(product) {
    return [product.name, product.barcode, product.category, product.supplier].filter(Boolean).join(" ").toLowerCase();
  }

  function renderPurchaseMedicineResults(query) {
    const q = String(query || "").trim().toLowerCase();
    const matches = cachedProductsList.filter(p => !q || productSearchText(p).includes(q)).slice(0, 12);
    const $results = $("#pur_medicine_results").empty();
    if (matches.length === 0) {
      $results.html('<div class="purchase-search-no-results">No matching medicine.<br><button type="button" class="btn btn-link btn-xs" id="btn_medicine_no_result_add"><i class="fa fa-plus"></i> Add New Medicine</button></div>').show();
      return;
    }
    matches.forEach(function (product) {
      const detail = [`SKU ${product.barcode}`];
      if (product.category) detail.push(product.category);
      $("<button>", { type: "button", class: "purchase-search-option", "data-id": product._id })
        .append($("<strong>").text(product.name), $("<small>").text(detail.join(" · ")))
        .appendTo($results);
    });
    $results.show();
  }

  $(document).on("focus input", "#pur_medicine_search", function () {
    renderPurchaseMedicineResults($(this).val());
  });

  $(document).on("keydown", "#pur_supplier_search, #pur_medicine_search", function (event) {
    const $results = $(this).is("#pur_supplier_search") ? $("#pur_supplier_results") : $("#pur_medicine_results");
    if (event.key === "Escape") $results.hide();
    if (event.key === "Enter" && $results.is(":visible")) {
      const $first = $results.find(".purchase-search-option").first();
      if ($first.length) {
        event.preventDefault();
        $first.trigger("click");
      }
    }
  });

  $(document).on("click", "#pur_medicine_results .purchase-search-option", function () {
    const product = cachedProductsList.find(p => String(p._id) === String($(this).data("id")));
    if (product) addPurchaseItemCard(product);
  });

  $(document).on("click", function (event) {
    if (!$(event.target).closest(".purchase-search-control").length) $(".purchase-search-results").hide();
  });

  function addPurchaseItemCard(product, initialCostCents = null) {
    const cardId = `purchase_item_${Date.now()}_${Math.random().toString().slice(2, 6)}`;
    const costValue = initialCostCents == null ? "" : centsText(initialCostCents);
    const card = `
      <div class="purchase-item-card" id="${cardId}" data-product-id="${product._id}">
        <div class="purchase-item-card-header">
          <div><strong>${escapeHtml(product.name)}</strong> <small class="text-muted">SKU ${escapeHtml(product.barcode)}</small></div>
          <button type="button" class="btn btn-link text-danger btn-remove-pur-row" title="Remove medicine"><i class="fa fa-trash"></i></button>
        </div>
        <div class="purchase-item-fields">
          <div><label>Purchase Quantity</label><input type="number" min="1" step="1" class="form-control pur-item-qty" value="1" required /></div>
          <div><label>Purchase Price / Unit</label><input type="number" min="0" step="0.01" class="form-control pur-item-cost" value="${costValue}" placeholder="0.00" required /></div>
          <div><label>Batch Number</label><input type="text" class="form-control pur-item-batch" placeholder="Batch #" required /></div>
          <div><label>Expiry Date</label><input type="date" class="form-control pur-item-expiry" required /></div>
          <div><label>Bonus Qty</label><input type="number" min="0" step="1" class="form-control pur-item-bonus" value="0" /></div>
        </div>
        <div class="text-right m-t-10">Line Total: <span class="purchase-line-total">PKR <span class="pur-item-linetotal">${costValue || "0.00"}</span></span></div>
      </div>`;
    $("#purchase_items_cards").append(card);
    $("#purchase_items_empty").hide();
    $("#pur_medicine_search").val("");
    $("#pur_medicine_results").hide();
    recalculatePurchaseTotal();
    $(`#${cardId} .pur-item-qty`).focus();
  }

  $(document).on("click", "#btn_add_purchase_row", function () {
    $("#pur_medicine_search").focus();
    renderPurchaseMedicineResults("");
  });

  $(document).on("click", ".btn-remove-pur-row", function () {
    $(this).closest(".purchase-item-card").remove();
    $("#purchase_items_empty").toggle($("#purchase_items_cards .purchase-item-card").length === 0);
    recalculatePurchaseTotal();
  });

  $(document).on("input change", ".pur-item-qty, .pur-item-cost", function () {
    const $card = $(this).closest(".purchase-item-card");
    const qty = Number($card.find(".pur-item-qty").val()) || 0;
    const costCents = moneyCents($card.find(".pur-item-cost").val()) || 0;
    $card.find(".pur-item-linetotal").text(centsText(qty * costCents));
    recalculatePurchaseTotal();
  });

  function recalculatePurchaseTotal() {
    let totalCents = 0;
    $("#purchase_items_cards .purchase-item-card").each(function () {
      const qty = Number($(this).find(".pur-item-qty").val()) || 0;
      const costCents = moneyCents($(this).find(".pur-item-cost").val()) || 0;
      totalCents += qty * costCents;
    });
    $("#pur_grand_total").text(centsText(totalCents));
    updatePurchaseSummary(totalCents);
    return totalCents;
  }

  function updatePurchaseSummary(totalCents = null) {
    if (totalCents == null) totalCents = moneyCents($("#pur_grand_total").text()) || 0;
    const mode = $("#pur_payment_mode").val();
    let paidCents = 0;
    if (mode === "fully_paid") paidCents = totalCents;
    if (mode === "partial") paidCents = moneyCents($("#pur_paid_now").val()) || 0;
    paidCents = Math.min(paidCents, totalCents);
    $("#pur_summary_paid").text(centsText(paidCents));
    $("#pur_summary_remaining").text(centsText(totalCents - paidCents));
    $("#pur_paid_now_group").toggle(mode === "partial");
    $("#pur_pay_method").prop("disabled", mode === "unpaid");
  }

  $(document).on("change input", "#pur_payment_mode, #pur_paid_now", function () { updatePurchaseSummary(); });

  $(document).on("click", "#btn_generate_purchase_ref", function () {
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
    $("#pur_invoice_no").val(`MM-PUR-${stamp}`);
  });

  $(document).on("click", "#btn_quick_add_medicine, #btn_medicine_no_result_add", function () {
    const suggestedName = $("#pur_medicine_search").val().trim();
    $("#form_quick_medicine")[0].reset();
    $("#quick_med_name").val(suggestedName);
    $("#modal_quick_medicine").modal("show");
    setTimeout(function () { $(suggestedName ? "#quick_med_selling_price" : "#quick_med_name").focus(); }, 250);
  });

  $("#modal_quick_medicine").on("hidden.bs.modal", function () {
    if ($("#modal_new_purchase").hasClass("in")) $("body").addClass("modal-open");
  });

  $("#form_quick_medicine").on("submit", function (event) {
    event.preventDefault();
    const name = $("#quick_med_name").val().trim();
    const sellingCents = moneyCents($("#quick_med_selling_price").val());
    const costCents = moneyCents($("#quick_med_cost_price").val());
    const sku = $("#quick_med_sku").val().trim();
    if (!name || sellingCents == null || costCents == null) {
      notiflix.Report.warning("Medicine Details", "Enter the medicine name, selling price and purchase price using no more than two decimal places.", "Ok");
      return;
    }
    if (sku && !/^\d+$/.test(sku)) {
      notiflix.Report.warning("Invalid SKU", "SKU must contain numbers only, or leave it blank for an internal SKU.", "Ok");
      return;
    }

    const form = new FormData();
    Object.entries({
      id: "", img: "", remove: "", quick_add: "1", name,
      barcode: sku, expirationDate: "", price: centsText(sellingCents),
      category: $("#quick_med_category").val().trim(), supplier: "", quantity: "0", minStock: "0"
    }).forEach(([key, value]) => form.append(key, value));
    const $button = $("#btn_save_quick_medicine").prop("disabled", true).text("Saving...");
    $.ajax({
      url: getApiUrl("inventory/product"), type: "POST", data: form,
      headers: getAuthToken() ? { "X-Access-Token": getAuthToken() } : {},
      contentType: false, processData: false
    }).done(function (result) {
      const product = result && result.product;
      if (!product) throw new Error("Medicine was saved but no product was returned.");
      cachedProductsList.push(product);
      addPurchaseItemCard(product, costCents);
      $("#modal_quick_medicine").modal("hide");
      notiflix.Notify.success("Medicine saved. Add its batch and expiry below.");
    }).fail(function (xhr) {
      notiflix.Report.failure("Medicine Not Saved", xhr.responseJSON?.message || xhr.responseJSON?.error || "Please try again.", "Ok");
    }).always(function () {
      $button.prop("disabled", false).html('<i class="fa fa-save"></i> Save Medicine');
    });
  });

  // Submit New Purchase
  $("#form_new_purchase").on("submit", function (e) {
    e.preventDefault();
    if (purchaseSubmitting) return;
    const supplierId = $("#pur_supplier_select").val();
    if (!supplierId) {
      notiflix.Report.warning("Supplier Missing", "Please select a supplier.", "Ok");
      return;
    }

    const items = [];
    let hasInvalid = false;

    $("#purchase_items_cards .purchase-item-card").each(function () {
      const prodId = $(this).data("product-id");
      const batch = $(this).find(".pur-item-batch").val().trim();
      const expiry = $(this).find(".pur-item-expiry").val().trim();
      const qty = Number($(this).find(".pur-item-qty").val());
      const bonus = Number($(this).find(".pur-item-bonus").val()) || 0;
      const costCents = moneyCents($(this).find(".pur-item-cost").val());

      if (!prodId || !batch || !expiry || !Number.isSafeInteger(qty) || qty <= 0 || !Number.isSafeInteger(bonus) || bonus < 0 || costCents == null) {
        hasInvalid = true;
        return false;
      }

      items.push({
        product_id: prodId,
        batch_number: batch,
        expiry_date: expiry,
        quantity: qty,
        bonus_quantity: bonus,
        unit_cost: centsText(costCents)
      });
    });

    if (hasInvalid || items.length === 0) {
      notiflix.Report.warning("Incomplete Items", "Please fill in all product fields, batch numbers, and expiry dates.", "Ok");
      return;
    }

    const invoiceNumber = $("#pur_invoice_no").val().trim();
    if (!invoiceNumber) {
      notiflix.Report.warning("Invoice Number", "Enter the supplier invoice number or click Generate for an internal reference.", "Ok");
      return;
    }
    const totalCents = recalculatePurchaseTotal();
    const paymentMode = $("#pur_payment_mode").val();
    let paidCents = paymentMode === "fully_paid" ? totalCents : 0;
    if (paymentMode === "partial") paidCents = moneyCents($("#pur_paid_now").val());
    if (paidCents == null || paidCents < 0 || paidCents > totalCents || (paymentMode === "partial" && (paidCents === 0 || paidCents === totalCents))) {
      notiflix.Report.warning("Payment Amount", "For a partial payment, enter an amount greater than zero and less than the purchase total.", "Ok");
      return;
    }

    const payload = {
      supplier_id: supplierId,
      invoice_no: invoiceNumber,
      invoice_date: $("#pur_date_input").val(),
      due_date: $("#pur_due_date_input").val(),
      status: $("#pur_receiving_mode").val(),
      paid_amount: centsText(paidCents),
      payment_method: paymentMode === "unpaid" ? "cash" : $("#pur_pay_method").val(),
      notes: $("#pur_notes").val().trim(),
      items
    };

    purchaseSubmitting = true;
    const $save = $("#btn_save_purchase").prop("disabled", true).html('<i class="fa fa-spinner fa-spin"></i> Saving...');
    apiAjax("purchases", { type: "POST", data: JSON.stringify(payload) })
      .done(function () {
        loadPurchases();
        loadSuppliers();
        loadDashboard();
        $("#modal_new_purchase").modal("hide");
        notiflix.Notify.success(payload.status === "received" ? "Purchase saved and stock received." : "Purchase draft saved. Stock was not changed.");
      })
      .fail(function (xhr) {
        notiflix.Report.failure("Error", xhr.responseJSON?.message || xhr.responseJSON?.error || "Failed to save purchase.", "Ok");
      })
      .always(function () {
        purchaseSubmitting = false;
        $save.prop("disabled", false).html('<i class="fa fa-save"></i> Save Purchase');
      });
  });

  // View Purchase Details
  $(document).on("click", ".btn-view-purchase", function () {
    const id = $(this).data("id");
    apiAjax(`purchases/${id}`, { type: "GET" })
      .done(function (p) {
        $("#vpur_invoice_no").text(p.invoice_no);
        $("#vpur_supplier").text(p.supplier_name);
        $("#vpur_date").text(p.invoice_date);
        $("#vpur_status").text(p.purchase_status);
        $("#vpur_payment_status").text(p.payment_status);
        $("#vpur_total").text(formatMoney(p.total));
        $("#vpur_paid").text(formatMoney(p.paid));
        $("#vpur_outstanding").text(formatMoney(p.outstanding));

        const $tbody = $("#vpur_items_tbody");
        $tbody.empty();
        (p.items || []).forEach(function (it) {
          $tbody.append(`
            <tr>
              <td><strong>${it.product_name}</strong></td>
              <td>${it.batch_number}</td>
              <td>${it.expiry_date}</td>
              <td>${it.quantity} ${it.bonus_quantity > 0 ? `(+${it.bonus_quantity} bonus)` : ''}</td>
              <td>${formatMoney(it.unit_cost)}</td>
              <td><strong>${formatMoney(it.line_total)}</strong></td>
            </tr>
          `);
        });

        $("#modal_view_purchase").modal("show");
      });
  });

  // Receive Draft Purchase
  $(document).on("click", ".btn-receive-purchase", function () {
    const id = $(this).data("id");
    notiflix.Confirm.show(
      "Receive Purchase",
      "Are you sure you want to receive this purchase into stock and post it to accounts?",
      "Yes, Receive",
      "Cancel",
      function () {
        apiAjax(`purchases/${id}/receive`, { type: "POST", data: JSON.stringify({}) })
          .done(function () {
            notiflix.Notify.success("Purchase received into stock successfully.");
            loadPurchases();
            loadSuppliers();
            loadDashboard();
          })
          .fail(function (xhr) {
            notiflix.Report.failure("Receive Failed", xhr.responseJSON?.message || xhr.responseJSON?.error || "Error receiving purchase.", "Ok");
          });
      }
    );
  });

  // Purchase Return Modal
  $(document).on("click", ".btn-return-purchase", function () {
    const id = $(this).data("id");
    apiAjax(`purchases/${id}`, { type: "GET" })
      .done(function (p) {
        $("#pret_purchase_id").val(p.id);
        $("#pret_invoice_no").text(p.invoice_no);
        $("#pret_supplier").text(p.supplier_name);

        const $select = $("#pret_item_select");
        $select.empty().append('<option value="">Select Item to Return...</option>');
        (p.items || []).forEach(function (it) {
          $select.append(`<option value="${it.product_id}" data-batch="${it.batch_number}" data-qty="${it.quantity}">
            ${it.product_name} (Batch: ${it.batch_number}, Qty: ${it.quantity})
          </option>`);
        });

        $("#modal_purchase_return").modal("show");
      });
  });

  $("#form_purchase_return").on("submit", function (e) {
    e.preventDefault();
    const purchaseId = $("#pret_purchase_id").val();
    const $selected = $("#pret_item_select option:selected");
    const productId = $selected.val();
    const batchNumber = $selected.data("batch");
    const qty = Number($("#pret_qty_input").val());
    const reason = $("#pret_reason_input").val().trim();

    if (!productId || qty <= 0) {
      notiflix.Report.warning("Invalid Return", "Please select an item and enter a valid quantity.", "Ok");
      return;
    }

    apiAjax(`purchases/${purchaseId}/return`, {
      type: "POST",
      data: JSON.stringify({ product_id: productId, batch_number: batchNumber, quantity: qty, reason })
    })
      .done(function () {
        $("#modal_purchase_return").modal("hide");
        notiflix.Notify.success("Purchase return recorded and stock deducted.");
        loadPurchases();
        loadSuppliers();
        loadDashboard();
      })
      .fail(function (xhr) {
        notiflix.Report.failure("Return Failed", xhr.responseJSON?.message || xhr.responseJSON?.error || "Error processing return.", "Ok");
      });
  });

  // ==========================================
  // 4. CUSTOMER KHATA (UDHAAR)
  // ==========================================

  let cachedCustomers = [];

  function loadCustomersKhata() {
    apiAjax("customers/all", { type: "GET" })
      .done(function (customers) {
        cachedCustomers = customers;
        renderCustomersKhataTable(customers);
      });
  }

  function renderCustomersKhataTable(customers) {
    const $tbody = $("#khata_table_body");
    $tbody.empty();

    if (!customers || customers.length === 0) {
      $tbody.html('<tr><td colspan="6" class="text-center text-muted p-4">No customers found.</td></tr>');
      return;
    }

    customers.forEach(function (c) {
      // Fetch customer balance
      apiAjax(`ledger/customers/${c._id}/statement`, { type: "GET" })
        .done(function (stmt) {
          const recCents = Number(stmt.current_receivable_cents || 0);
          const recClass = recCents > 0 ? "money-positive" : "money-neutral";

          const tr = `
            <tr id="khata_row_${c._id}">
              <td><strong>${c._id}</strong></td>
              <td><strong>${c.name}</strong></td>
              <td>${c.phone || "-"}</td>
              <td>${formatMoney(stmt.customer.credit_limit)}</td>
              <td class="${recClass}"><strong>${formatMoney(stmt.current_receivable)}</strong></td>
              <td>
                <div class="btn-group btn-group-xs">
                  <button class="btn btn-default btn-xs btn-cust-statement" data-id="${c._id}"><i class="fa fa-file-text-o"></i> Statement</button>
                  <button class="btn btn-success btn-xs btn-cust-pay" data-id="${c._id}"><i class="fa fa-money"></i> Collect</button>
                </div>
              </td>
            </tr>
          `;
          $tbody.append(tr);
        });
    });
  }

  // Customer Statement Modal
  $(document).on("click", ".btn-cust-statement", function () {
    const id = $(this).data("id");
    loadCustomerStatement(id);
  });

  function loadCustomerStatement(id, start = "", end = "") {
    let url = `ledger/customers/${id}/statement`;
    if (start && end) url += `?start=${start}&end=${end}`;

    apiAjax(url, { type: "GET" })
      .done(function (data) {
        $("#cstmt_name").text(data.customer.name);
        $("#cstmt_phone").text(data.customer.phone || "-");
        $("#cstmt_balance").text(formatMoney(data.current_receivable));
        $("#cstmt_filter_id").val(id);

        const $tbody = $("#cstmt_table_body");
        $tbody.empty();

        if (!data.transactions || data.transactions.length === 0) {
          $tbody.html('<tr><td colspan="6" class="text-center text-muted p-3">No khata transactions for this customer.</td></tr>');
        } else {
          data.transactions.forEach(function (tx) {
            const dateStr = new Date(tx.date).toLocaleDateString("en-PK");
            const tr = `
              <tr>
                <td>${dateStr}</td>
                <td><strong>${tx.reference_number}</strong></td>
                <td>${tx.description}</td>
                <td class="text-right text-danger">${tx.debit ? formatMoney(tx.debit) : "-"}</td>
                <td class="text-right text-success">${tx.credit ? formatMoney(tx.credit) : "-"}</td>
                <td class="text-right"><strong>${formatMoney(tx.balance)}</strong></td>
              </tr>
            `;
            $tbody.append(tr);
          });
        }

        $("#modal_customer_statement").modal("show");
      });
  }

  // Customer Payment (Khata Collection) Modal
  $(document).on("click", ".btn-cust-pay", function () {
    const id = $(this).data("id");
    apiAjax(`ledger/customers/${id}/statement`, { type: "GET" })
      .done(function (data) {
        $("#cpay_cust_id").val(id);
        $("#cpay_cust_name").text(data.customer.name);
        $("#cpay_cust_balance").text(formatMoney(data.current_receivable));
        $("#cpay_amount_input").val("");
        $("#cpay_ref_input").val("");
        $("#cpay_notes_input").val("");

        $("#modal_customer_payment").modal("show");
      });
  });

  $("#form_customer_payment").on("submit", function (e) {
    e.preventDefault();
    const custId = $("#cpay_cust_id").val();
    const amount = Number($("#cpay_amount_input").val());
    if (!amount || amount <= 0) {
      notiflix.Report.warning("Invalid Amount", "Please enter valid payment amount.", "Ok");
      return;
    }

    const payload = {
      party_type: "customer",
      party_id: custId,
      amount: amount,
      payment_method: $("#cpay_method_select").val(),
      reference_number: $("#cpay_ref_input").val().trim(),
      notes: $("#cpay_notes_input").val().trim()
    };

    apiAjax("ledger/payments", { type: "POST", data: JSON.stringify(payload) })
      .done(function () {
        $("#modal_customer_payment").modal("hide");
        notiflix.Notify.success("Khata payment received and added to cashbook.");
        loadCustomersKhata();
        loadDashboard();
      })
      .fail(function (xhr) {
        notiflix.Report.failure("Error", xhr.responseJSON?.message || xhr.responseJSON?.error || "Error recording payment.", "Ok");
      });
  });

  // ==========================================
  // 5. EXPENSE MANAGEMENT
  // ==========================================

  let cachedExpenseCategories = [];

  function loadExpenses() {
    apiAjax("expenses/categories", { type: "GET" }).done(function (cats) {
      cachedExpenseCategories = cats;
      const $select = $("#exp_category_select");
      $select.empty().append('<option value="">Select Category...</option>');
      cats.forEach(function (c) {
        $select.append(`<option value="${c.id}">${c.name}</option>`);
      });
    });

    apiAjax("expenses/all", { type: "GET" })
      .done(function (expenses) {
        const $tbody = $("#expenses_table_body");
        $tbody.empty();

        if (!expenses || expenses.length === 0) {
          $tbody.html('<tr><td colspan="7" class="text-center text-muted p-4">No expenses recorded yet.</td></tr>');
          return;
        }

        expenses.forEach(function (e) {
          const dateStr = new Date(e.expense_date).toLocaleDateString("en-PK");
          const tr = `
            <tr>
              <td><strong>${e.expense_number}</strong></td>
              <td>${dateStr}</td>
              <td><span class="badge-status badge-partially_paid">${e.category_name}</span></td>
              <td>${e.description}</td>
              <td>${e.payment_method}</td>
              <td><strong class="text-danger">${formatMoney(e.amount)}</strong></td>
              <td><small class="text-muted">${e.recorded_by}</small></td>
            </tr>
          `;
          $tbody.append(tr);
        });
      });
  }

  // Open Add Expense Modal
  $(document).on("click", "#btn_add_expense", function () {
    $("#form_add_expense")[0].reset();
    $("#exp_date_input").val(new Date().toISOString().slice(0, 10));
    $("#modal_add_expense").modal("show");
  });

  $("#form_add_expense").on("submit", function (e) {
    e.preventDefault();
    const payload = {
      category_id: $("#exp_category_select").val(),
      amount: $("#exp_amount_input").val(),
      payment_method: $("#exp_method_select").val(),
      expense_date: $("#exp_date_input").val(),
      description: $("#exp_desc_input").val().trim(),
      reference_number: $("#exp_ref_input").val().trim()
    };

    apiAjax("expenses", { type: "POST", data: JSON.stringify(payload) })
      .done(function () {
        $("#modal_add_expense").modal("hide");
        notiflix.Notify.success("Expense recorded successfully.");
        loadExpenses();
        loadDashboard();
      })
      .fail(function (xhr) {
        notiflix.Report.failure("Error", xhr.responseJSON?.message || xhr.responseJSON?.error || "Error recording expense.", "Ok");
      });
  });

  // ==========================================
  // 6. REPORTS
  // ==========================================

  function loadReports() {
    // Inventory Batches report
    apiAjax("inventory/products", { type: "GET" })
      .done(function (products) {
        const $tbody = $("#rep_inventory_tbody");
        $tbody.empty();
        products.forEach(function (p) {
          const isLow = Number(p.quantity) <= Number(p.minStock);
          const tr = `
            <tr>
              <td>${p.barcode}</td>
              <td><strong>${p.name}</strong></td>
              <td>${p.supplier || "-"}</td>
              <td>${p.expirationDate}</td>
              <td class="${isLow ? 'text-danger font-weight-bold' : ''}">${p.quantity}</td>
              <td>${formatMoney(p.price)}</td>
              <td>${isLow ? '<span class="badge-status badge-unpaid">Low Stock</span>' : '<span class="badge-status badge-paid">Normal</span>'}</td>
            </tr>
          `;
          $tbody.append(tr);
        });
      });
  }

});
