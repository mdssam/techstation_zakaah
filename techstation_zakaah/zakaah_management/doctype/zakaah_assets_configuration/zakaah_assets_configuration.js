// -*- coding: utf-8 -*-
// Copyright (c) 2025, Zakaah Team and contributors
// For license information, please see license.txt

frappe.ui.form.on("Zakaah Assets Configuration", {
	refresh(frm) {
		// Add custom buttons
		if (!frm.is_new()) {
			frm.add_custom_button(__("Calculate All Balances"), function() {
				calculate_all_balances(frm);
			});

			frm.add_custom_button(__("Validate Configuration"), function() {
				validate_configuration(frm);
			});
		}

		// Set helpful messages
		frm.set_intro(__("Configure which accounts to include in Zakaah calculation. Add accounts for each category."), "blue");

		// Make balance fields read-only and hide unwanted columns
		set_balance_fields_readonly(frm);
		hide_irrelevant_columns(frm);
	},

	company(frm) {
		if (frm.doc.company) {
			frappe.show_alert({
				message: __("Company changed. Please review and update account configurations."),
				indicator: "orange"
			}, 5);
		}
	}
});

// Cash Accounts Child Table
frappe.ui.form.on("Zakaah Account Configuration", {
	account: function(frm, cdt, cdn) {
		let row = locals[cdt][cdn];

		// Auto-calculate balance when account is selected
		if (row.account && row.parentfield === 'cash_accounts') {
			calculate_account_balance(frm, row);
		}
	},

	cash_accounts_add: function(frm, cdt, cdn) {
		frappe.show_alert({
			message: __("Select an account to see its current balance"),
			indicator: "blue"
		}, 3);
	}
});

// Inventory Accounts Child Table
frappe.ui.form.on("Zakaah Account Configuration", {
	account: function(frm, cdt, cdn) {
		let row = locals[cdt][cdn];

		if (row.account && row.parentfield === 'inventory_accounts') {
			calculate_account_balance(frm, row);
		}
	}
});

// Receivable Accounts Child Table
frappe.ui.form.on("Zakaah Account Configuration", {
	account: function(frm, cdt, cdn) {
		let row = locals[cdt][cdn];

		if (row.account && row.parentfield === 'receivable_accounts') {
			calculate_account_balance(frm, row);
		}
	}
});

// Liability Accounts Child Table
frappe.ui.form.on("Zakaah Account Configuration", {
	account: function(frm, cdt, cdn) {
		let row = locals[cdt][cdn];

		if (row.account && row.parentfield === 'liability_accounts') {
			calculate_account_balance(frm, row);
		}
	}
});

// Reserve Accounts Child Table
frappe.ui.form.on("Zakaah Account Configuration", {
	account: function(frm, cdt, cdn) {
		let row = locals[cdt][cdn];

		if (row.account && row.parentfield === 'reserve_accounts') {
			calculate_account_balance(frm, row);
		}
	}
});

// Payment Accounts Child Table
frappe.ui.form.on("Zakaah Account Configuration", {
	account: function(frm, cdt, cdn) {
		let row = locals[cdt][cdn];

		if (row.account && row.parentfield === 'payment_accounts') {
			// If fiscal year is selected, use its date range
			if (frm.doc.fiscal_year) {
				frappe.call({
					method: 'frappe.client.get_value',
					args: {
						doctype: 'Fiscal Year',
						filters: { name: frm.doc.fiscal_year },
						fieldname: ['year_start_date', 'year_end_date']
					},
					callback: function(r) {
						if (r.message && r.message.year_end_date) {
							// Use fiscal year range (BETWEEN start and end)
							calculate_payment_account_debit_for_fy_range(frm, row, r.message.year_start_date, r.message.year_end_date);
						} else {
							calculate_payment_account_debit(frm, row);
						}
					}
				});
			} else {
				calculate_payment_account_debit(frm, row);
			}
		}
	}
});

// Helper Functions

function calculate_account_balance(frm, row) {
	if (!row.account) return;

	frappe.call({
		method: 'erpnext.accounts.utils.get_balance_on',
		args: {
			account: row.account,
			date: frappe.datetime.get_today()
		},
		callback: function(r) {
			if (r.message) {
				frappe.model.set_value(row.doctype, row.name, 'balance', r.message);
				frappe.show_alert({
					message: __("Balance updated: {0}", [format_currency(r.message)]),
					indicator: "green"
				}, 3);
			}
		}
	});
}

function calculate_account_balance_for_date(frm, row, date) {
	if (!row.account) return;

	frappe.call({
		method: 'erpnext.accounts.utils.get_balance_on',
		args: {
			account: row.account,
			date: date
		},
		callback: function(r) {
			if (r.message) {
				frappe.model.set_value(row.doctype, row.name, 'balance', r.message);
			}
		}
	});
}

function calculate_payment_account_debit(frm, row) {
	if (!row.account) return;

	// For payment accounts, we need GL Entry debit, not balance
	frappe.call({
		method: 'frappe.client.get_list',
		args: {
			doctype: 'GL Entry',
			filters: {
				account: row.account,
				company: frm.doc.company
			},
			fields: ['sum(debit) as total_debit'],
		},
		callback: function(r) {
			if (r.message && r.message.length > 0) {
				let debit = r.message[0].total_debit || 0;
				frappe.model.set_value(row.doctype, row.name, 'debit', debit);
				frappe.show_alert({
					message: __("Debit amount updated: {0}", [format_currency(debit)]),
					indicator: "green"
				}, 3);
			}
		}
	});
}

function calculate_payment_account_debit_for_date(frm, row, date) {
	if (!row.account) return;

	// For payment accounts, we need GL Entry debit up to the date, not balance
	frappe.call({
		method: 'frappe.client.get_list',
		args: {
			doctype: 'GL Entry',
			filters: {
				account: row.account,
				company: frm.doc.company,
				posting_date: ['<=', date]
			},
			fields: ['sum(debit) as total_debit'],
		},
		callback: function(r) {
			if (r.message && r.message.length > 0) {
				let debit = r.message[0].total_debit || 0;
				frappe.model.set_value(row.doctype, row.name, 'debit', debit);
			}
		}
	});
}

function calculate_payment_account_debit_for_fy_range(frm, row, from_date, to_date) {
	if (!row.account) return;

	// For payment accounts, sum debits WITHIN the fiscal year range (BETWEEN)
	// This matches the Python logic: BETWEEN from_date AND to_date
	frappe.call({
		method: 'frappe.client.get_list',
		args: {
			doctype: 'GL Entry',
			filters: {
				account: row.account,
				company: frm.doc.company,
				posting_date: ['between', [from_date, to_date]],
				is_cancelled: 0
			},
			fields: ['sum(debit) as total_debit'],
		},
		callback: function(r) {
			if (r.message && r.message.length > 0) {
				let debit = r.message[0].total_debit || 0;
				frappe.model.set_value(row.doctype, row.name, 'debit', debit);
			}
		}
	});
}

function calculate_all_balances(frm) {
	if (!frm.doc.company) {
		frappe.msgprint(__("Please select a company first"));
		return;
	}

	// Check if fiscal year is selected
	if (!frm.doc.fiscal_year) {
		frappe.msgprint(__("Please select a Fiscal Year first"));
		return;
	}

	// Get the fiscal year's start and end dates
	frappe.call({
		method: 'frappe.client.get_value',
		args: {
			doctype: 'Fiscal Year',
			filters: { name: frm.doc.fiscal_year },
			fieldname: ['year_start_date', 'year_end_date']
		},
		callback: function(r) {
			if (r.message && r.message.year_end_date) {
				let fiscal_year_start = r.message.year_start_date;
				let fiscal_year_end = r.message.year_end_date;
				frappe.show_alert({
					message: __("Calculating balances for {0} to {1}...", [
						frappe.datetime.str_to_user(fiscal_year_start),
						frappe.datetime.str_to_user(fiscal_year_end)
					]),
					indicator: "blue"
				});
				calculate_balances_for_date(frm, fiscal_year_start, fiscal_year_end);
			} else {
				frappe.msgprint(__("Could not get fiscal year dates"));
			}
		}
	});
}

function calculate_balances_for_date(frm, fiscal_year_start, fiscal_year_end) {
	let calculated = 0;
	let total = 0;

	// Count total accounts
	['cash_accounts', 'inventory_accounts', 'receivable_accounts',
	 'liability_accounts', 'reserve_accounts', 'payment_accounts'].forEach(table => {
		if (frm.doc[table]) {
			total += frm.doc[table].length;
		}
	});

	// Calculate cash accounts
	if (frm.doc.cash_accounts) {
		frm.doc.cash_accounts.forEach(row => {
			if (row.account) {
				calculate_account_balance_for_date(frm, row, fiscal_year_end);
				calculated++;
			}
		});
	}

	// Calculate inventory accounts
	if (frm.doc.inventory_accounts) {
		frm.doc.inventory_accounts.forEach(row => {
			if (row.account) {
				calculate_account_balance_for_date(frm, row, fiscal_year_end);
				calculated++;
			}
		});
	}

	// Calculate receivable accounts
	if (frm.doc.receivable_accounts) {
		frm.doc.receivable_accounts.forEach(row => {
			if (row.account) {
				calculate_account_balance_for_date(frm, row, fiscal_year_end);
				calculated++;
			}
		});
	}

	// Calculate liability accounts
	if (frm.doc.liability_accounts) {
		frm.doc.liability_accounts.forEach(row => {
			if (row.account) {
				calculate_account_balance_for_date(frm, row, fiscal_year_end);
				calculated++;
			}
		});
	}

	// Calculate reserve accounts
	if (frm.doc.reserve_accounts) {
		frm.doc.reserve_accounts.forEach(row => {
			if (row.account) {
				calculate_account_balance_for_date(frm, row, fiscal_year_end);
				calculated++;
			}
		});
	}

	// Calculate payment accounts (debit) - use fiscal year RANGE
	if (frm.doc.payment_accounts) {
		frm.doc.payment_accounts.forEach(row => {
			if (row.account) {
				calculate_payment_account_debit_for_fy_range(frm, row, fiscal_year_start, fiscal_year_end);
				calculated++;
			}
		});
	}

	setTimeout(() => {
		frappe.show_alert({
			message: __("Calculated balances for {0} of {1} accounts", [calculated, total]),
			indicator: "green"
		}, 5);

		frm.refresh_fields();
	}, 1000);
}

function validate_configuration(frm) {
	let warnings = [];
	let errors = [];

	// Check if company is set
	if (!frm.doc.company) {
		errors.push(__("Company is not set"));
	}

	// Check if at least one account is configured
	let has_accounts = false;
	['cash_accounts', 'inventory_accounts', 'receivable_accounts',
	 'liability_accounts', 'reserve_accounts', 'payment_accounts'].forEach(table => {
		if (frm.doc[table] && frm.doc[table].length > 0) {
			has_accounts = true;
		}
	});

	if (!has_accounts) {
		errors.push(__("No accounts configured. Please add at least one account."));
	}

	// Check for duplicate accounts across tables
	let all_accounts = [];
	['cash_accounts', 'inventory_accounts', 'receivable_accounts',
	 'liability_accounts', 'reserve_accounts', 'payment_accounts'].forEach(table => {
		if (frm.doc[table]) {
			frm.doc[table].forEach(row => {
				if (row.account) {
					if (all_accounts.includes(row.account)) {
						warnings.push(__("Account {0} appears in multiple tables", [row.account]));
					}
					all_accounts.push(row.account);
				}
			});
		}
	});

	// Check if payment accounts are configured
	if (!frm.doc.payment_accounts || frm.doc.payment_accounts.length === 0) {
		warnings.push(__("No payment accounts configured. You won't be able to track Zakaah payments."));
	}

	// Display results
	if (errors.length > 0) {
		frappe.msgprint({
			title: __("Configuration Errors"),
			indicator: "red",
			message: errors.join("<br>")
		});
	} else if (warnings.length > 0) {
		frappe.msgprint({
			title: __("Configuration Warnings"),
			indicator: "orange",
			message: warnings.join("<br>")
		});
	} else {
		frappe.msgprint({
			title: __("Configuration Valid"),
			indicator: "green",
			message: __("Your Zakaah assets configuration looks good!")
		});
	}
}

function set_balance_fields_readonly(frm) {
	// Make balance and debit fields read-only as they are auto-calculated
	frm.fields_dict.cash_accounts.grid.update_docfield_property('balance', 'read_only', 1);
	frm.fields_dict.inventory_accounts.grid.update_docfield_property('balance', 'read_only', 1);
	frm.fields_dict.receivable_accounts.grid.update_docfield_property('balance', 'read_only', 1);
	frm.fields_dict.liabilities_accounts.grid.update_docfield_property('balance', 'read_only', 1);
	frm.fields_dict.reserve_accounts.grid.update_docfield_property('balance', 'read_only', 1);
	frm.fields_dict.payment_accounts.grid.update_docfield_property('debit', 'read_only', 1);
}

function hide_irrelevant_columns(frm) {
	// Hide 'debit' column from Cash, Inventory, Receivables, Liabilities, and Reserve accounts
	// Hide 'balance' column from Payment accounts

	// For regular accounts (Cash, Inventory, Receivables, Liabilities, Reserves): hide 'debit' column
	const regular_account_tables = ['cash_accounts', 'inventory_accounts', 'receivable_accounts', 'liabilities_accounts', 'reserve_accounts'];

	regular_account_tables.forEach(table => {
		if (frm.fields_dict[table] && frm.fields_dict[table].grid) {
			// Get the docfield and set it to hidden
			let grid = frm.fields_dict[table].grid;
			let debit_field = grid.docfields.find(f => f.fieldname === 'debit');
			if (debit_field) {
				debit_field.hidden = 1;
				debit_field.in_list_view = 0;
			}

			// Remove debit from visible columns
			if (grid.visible_columns) {
				grid.visible_columns = grid.visible_columns.filter(col => col.fieldname !== 'debit');
			}
		}
	});

	// For payment accounts: hide 'balance' column
	if (frm.fields_dict.payment_accounts && frm.fields_dict.payment_accounts.grid) {
		let grid = frm.fields_dict.payment_accounts.grid;
		let balance_field = grid.docfields.find(f => f.fieldname === 'balance');
		if (balance_field) {
			balance_field.hidden = 1;
			balance_field.in_list_view = 0;
		}

		// Remove balance from visible columns
		if (grid.visible_columns) {
			grid.visible_columns = grid.visible_columns.filter(col => col.fieldname !== 'balance');
		}
	}

	// Force refresh all grids
	setTimeout(() => {
		regular_account_tables.forEach(table => {
			if (frm.fields_dict[table] && frm.fields_dict[table].grid) {
				frm.fields_dict[table].grid.refresh();
			}
		});
		if (frm.fields_dict.payment_accounts && frm.fields_dict.payment_accounts.grid) {
			frm.fields_dict.payment_accounts.grid.refresh();
		}
	}, 100);
}
