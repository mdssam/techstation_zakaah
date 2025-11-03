// -*- coding: utf-8 -*-
// Copyright (c) 2025, Zakaah Team and contributors
// For license information, please see license.txt

frappe.ui.form.on("Zakaah Allocation History", {
	refresh(frm) {
		// Set helpful intro message
		if (frm.is_new()) {
			frm.set_intro(__("This record tracks the allocation of a Zakaah payment to a specific calculation run."), "blue");
		} else {
			if (frm.doc.docstatus === 0) {
				frm.set_intro(__("Submit this allocation to update the Zakaah Calculation Run status."), "orange");
			} else if (frm.doc.docstatus === 1) {
				frm.set_intro(__("This allocation has been submitted and the Calculation Run has been updated."), "green");
			} else if (frm.doc.docstatus === 2) {
				frm.set_intro(__("This allocation has been cancelled and the Calculation Run has been reverted."), "red");
			}
		}

		// Add custom buttons to view linked documents
		if (frm.doc.journal_entry && !frm.is_new()) {
			frm.add_custom_button(__("View Journal Entry"), function() {
				frappe.set_route("Form", "Journal Entry", frm.doc.journal_entry);
			}, __("View"));
		}

		if (frm.doc.zakaah_calculation_run && !frm.is_new()) {
			frm.add_custom_button(__("View Calculation Run"), function() {
				frappe.set_route("Form", "Zakaah Calculation Run", frm.doc.zakaah_calculation_run);
			}, __("View"));
		}

		// Add button to view all allocations for this journal entry
		if (frm.doc.journal_entry && !frm.is_new()) {
			frm.add_custom_button(__("All Allocations for this JE"), function() {
				frappe.set_route("List", "Zakaah Allocation History", {
					"journal_entry": frm.doc.journal_entry
				});
			}, __("View"));
		}

		// Add "Cancel and Delete" button for submitted records
		if (frm.doc.docstatus === 1 && !frm.is_new()) {
			frm.add_custom_button(__("Cancel and Delete"), function() {
				frappe.confirm(
					__("Are you sure you want to cancel and delete this allocation? This will reverse the Calculation Run updates."),
					function() {
						// First cancel the record
						frappe.call({
							method: "frappe.client.cancel",
							args: {
								doctype: frm.doctype,
								name: frm.docname
							},
							callback: function(r) {
								if (!r.exc) {
									frappe.show_alert({
										message: __("Record cancelled successfully"),
										indicator: "orange"
									}, 3);

									// Then delete the record
									setTimeout(function() {
										frappe.call({
											method: "frappe.client.delete",
											args: {
												doctype: frm.doctype,
												name: frm.docname
											},
											callback: function(r) {
												if (!r.exc) {
													frappe.show_alert({
														message: __("Record deleted successfully"),
														indicator: "green"
													}, 3);
													frappe.set_route("List", "Zakaah Allocation History");
												}
											}
										});
									}, 1000);
								}
							}
						});
					}
				);
			}).addClass('btn-danger');
		}

		// Add "Delete" button for cancelled records
		if (frm.doc.docstatus === 2 && !frm.is_new()) {
			frm.add_custom_button(__("Delete Record"), function() {
				frappe.confirm(
					__("Are you sure you want to delete this cancelled allocation record?"),
					function() {
						frappe.call({
							method: "frappe.client.delete",
							args: {
								doctype: frm.doctype,
								name: frm.docname
							},
							callback: function(r) {
								if (!r.exc) {
									frappe.show_alert({
										message: __("Record deleted successfully"),
										indicator: "green"
									}, 3);
									frappe.set_route("List", "Zakaah Allocation History");
								}
							}
						});
					}
				);
			}).addClass('btn-danger');
		}

		// Show allocation summary
		show_allocation_summary(frm);

		// Auto-calculate unallocated amount
		if (frm.doc.journal_entry && frm.doc.allocated_amount) {
			calculate_unallocated_amount(frm);
		}
	},

	journal_entry(frm) {
		if (frm.doc.journal_entry) {
			// Fetch journal entry details
			get_journal_entry_details(frm);

			// Calculate unallocated amount
			if (frm.doc.allocated_amount) {
				calculate_unallocated_amount(frm);
			}
		}
	},

	zakaah_calculation_run(frm) {
		if (frm.doc.zakaah_calculation_run) {
			// Fetch calculation run details
			get_calculation_run_details(frm);
		}
	},

	allocated_amount(frm) {
		if (frm.doc.journal_entry && frm.doc.allocated_amount) {
			calculate_unallocated_amount(frm);
		}

		// Validate allocated amount is positive
		if (frm.doc.allocated_amount <= 0) {
			frappe.msgprint(__("Allocated amount must be greater than zero"));
			frm.set_value('allocated_amount', 0);
		}
	}
});

// Helper Functions

function get_journal_entry_details(frm) {
	if (!frm.doc.journal_entry) return;

	frappe.call({
		method: 'frappe.client.get',
		args: {
			doctype: 'Journal Entry',
			name: frm.doc.journal_entry
		},
		callback: function(r) {
			if (r.message) {
				let je = r.message;

				// Show journal entry details in a message
				frappe.show_alert({
					message: __("Journal Entry: {0}, Posting Date: {1}", [
						je.name,
						frappe.datetime.str_to_user(je.posting_date)
					]),
					indicator: "blue"
				}, 5);

				// Calculate total debit from journal entry accounts
				let total_debit = 0;
				if (je.accounts) {
					je.accounts.forEach(account => {
						total_debit += account.debit || 0;
					});
				}

				// Store for later use
				frm.je_total_amount = total_debit;
			}
		}
	});
}

function get_calculation_run_details(frm) {
	if (!frm.doc.zakaah_calculation_run) return;

	frappe.call({
		method: 'frappe.client.get',
		args: {
			doctype: 'Zakaah Calculation Run',
			name: frm.doc.zakaah_calculation_run
		},
		callback: function(r) {
			if (r.message) {
				let calc = r.message;

				// Show calculation run details
				frappe.show_alert({
					message: __("Year: {0}, Total Zakaah: {1}, Outstanding: {2}", [
						calc.fiscal_year || calc.hijri_year,
						format_currency(calc.total_zakaah),
						format_currency(calc.outstanding_zakaah)
					]),
					indicator: "blue"
				}, 5);

				// Check if allocated amount exceeds outstanding
				if (frm.doc.allocated_amount > calc.outstanding_zakaah) {
					frappe.msgprint({
						title: __("Warning"),
						indicator: "orange",
						message: __("Allocated amount ({0}) exceeds outstanding amount ({1}) for this year.",
							[format_currency(frm.doc.allocated_amount), format_currency(calc.outstanding_zakaah)])
					});
				}
			}
		}
	});
}

function calculate_unallocated_amount(frm) {
	if (!frm.doc.journal_entry || !frm.doc.allocated_amount) return;

	frappe.call({
		method: 'techstation_zakaah.zakaah_management.doctype.zakaah_allocation_history.zakaah_allocation_history.get_journal_entry_unallocated',
		args: {
			journal_entry: frm.doc.journal_entry,
			exclude_allocation: frm.doc.name || null
		},
		callback: function(r) {
			if (r.message) {
				let total_je_amount = r.message.total_amount;
				let already_allocated = r.message.already_allocated;
				let unallocated = total_je_amount - already_allocated - frm.doc.allocated_amount;

				frm.set_value('unallocated_amount', unallocated);

				if (unallocated < 0) {
					frappe.msgprint({
						title: __("Over-allocation Warning"),
						indicator: "red",
						message: __("Total allocation ({0}) exceeds Journal Entry amount ({1})",
							[format_currency(already_allocated + frm.doc.allocated_amount), format_currency(total_je_amount)])
					});
				}
			}
		}
	});
}

function show_allocation_summary(frm) {
	if (frm.is_new() || !frm.doc.journal_entry) return;

	// Get all allocations for this journal entry
	frappe.call({
		method: 'frappe.client.get_list',
		args: {
			doctype: 'Zakaah Allocation History',
			filters: {
				journal_entry: frm.doc.journal_entry,
				docstatus: ['!=', 2]
			},
			fields: ['name', 'zakaah_calculation_run', 'allocated_amount', 'docstatus'],
			order_by: 'creation desc'
		},
		callback: function(r) {
			if (r.message && r.message.length > 0) {
				let allocations = r.message;
				let total_allocated = 0;

				allocations.forEach(alloc => {
					if (alloc.docstatus === 1) {
						total_allocated += alloc.allocated_amount;
					}
				});

				// Show summary in the form
				let summary_html = `
					<div class="alert alert-info">
						<strong>Journal Entry Allocations Summary</strong><br>
						Total Allocations: ${allocations.length}<br>
						Total Allocated Amount: ${format_currency(total_allocated)}
					</div>
				`;

				frm.set_df_property('allocation_summary_html', 'options', summary_html);
			}
		}
	});
}

// Server-side method to get unallocated amount for a journal entry
// This is called from the client script above
// Add this to zakaah_allocation_history.py:
/*
@frappe.whitelist()
def get_journal_entry_unallocated(journal_entry, exclude_allocation=None):
	"""Get unallocated amount for a journal entry"""

	# Get total journal entry amount
	je_amount = frappe.db.sql("""
		SELECT SUM(debit) as total_debit
		FROM `tabJournal Entry Account`
		WHERE parent = %s
	""", journal_entry, as_dict=True)

	total_amount = je_amount[0].total_debit if je_amount and je_amount[0].total_debit else 0

	# Get already allocated amount
	allocated_query = """
		SELECT SUM(allocated_amount) as total_allocated
		FROM `tabZakaah Allocation History`
		WHERE journal_entry = %s
		AND docstatus != 2
	"""

	params = [journal_entry]
	if exclude_allocation:
		allocated_query += " AND name != %s"
		params.append(exclude_allocation)

	allocated = frappe.db.sql(allocated_query, params, as_dict=True)
	already_allocated = allocated[0].total_allocated if allocated and allocated[0].total_allocated else 0

	return {
		'total_amount': total_amount,
		'already_allocated': already_allocated,
		'unallocated': total_amount - already_allocated
	}
*/
