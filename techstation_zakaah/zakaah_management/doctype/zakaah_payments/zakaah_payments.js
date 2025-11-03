frappe.ui.form.on("Zakaah Payments", {
	refresh(frm) {
		// Hide Save button
		frm.disable_save();

		// Make tables read-only by preventing add/delete, but keep rows editable for checkboxes
		// Use grid properties instead of df_property
		if (frm.fields_dict.calculation_runs && frm.fields_dict.calculation_runs.grid) {
			frm.fields_dict.calculation_runs.grid.cannot_add_rows = true;
			frm.fields_dict.calculation_runs.grid.cannot_delete_rows = true;
		}

		if (frm.fields_dict.payment_entries && frm.fields_dict.payment_entries.grid) {
			frm.fields_dict.payment_entries.grid.cannot_add_rows = true;
			frm.fields_dict.payment_entries.grid.cannot_delete_rows = true;
		}

		if (frm.fields_dict.allocation_history && frm.fields_dict.allocation_history.grid) {
			frm.fields_dict.allocation_history.grid.cannot_add_rows = true;
			frm.fields_dict.allocation_history.grid.cannot_delete_rows = true;
		}

		// Ensure tables are visible
		frm.trigger('ensure_tables_visible');

		// After a delay, hide the add buttons but keep table visible
		setTimeout(() => {
			// Hide add buttons manually using CSS/JS since we can't change cannot_add_rows without hiding table
			if (frm.fields_dict.payment_entries && frm.fields_dict.payment_entries.grid) {
				$(frm.fields_dict.payment_entries.grid.wrapper).find('.grid-add-row, .grid-add-row-btn').hide();
			}
			if (frm.fields_dict.allocation_history && frm.fields_dict.allocation_history.grid) {
				$(frm.fields_dict.allocation_history.grid.wrapper).find('.grid-add-row, .grid-add-row-btn').hide();
			}
		}, 500);

		// Show checkboxes for calculation_runs and payment_entries (for reconciliation)
		// But hide for allocation_history (read-only history)
		frm.trigger('setup_checkboxes');

		// Left side buttons (added first)
		// Show Allocate button first on the left if there's data
		if (frm.doc.calculation_runs && frm.doc.calculation_runs.length > 0 &&
			frm.doc.payment_entries && frm.doc.payment_entries.length > 0) {
			frm.add_custom_button(__("Allocate Payments"), function() {
				frm.trigger("allocate_payments");
			}).addClass('btn-success');
		}

		// Add "Get Unreconciled Entries" button on the left
		if (frm.doc.docstatus === 0) {
			frm.add_custom_button(__("Get Unreconciled Entries"), function() {
				frm.trigger("load_data");
			}).addClass('btn-primary');
		}

		// Right side - Actions dropdown
		// View Allocation History under Actions
		frm.add_custom_button(__("View Allocation History"), function() {
			frm.trigger("load_allocation_history");
		}, __("Actions"));

		// Add Clear button under Actions
		if (frm.doc.docstatus === 0) {
			frm.add_custom_button(__("Clear All Entries"), function() {
				frappe.confirm(
					__('Are you sure you want to clear all Calculation Runs and Journal Entries?'),
					function() {
						// Clear all tables
						frm.clear_table('calculation_runs');
						frm.clear_table('payment_entries');
						frm.clear_table('allocation_history');
						frm.refresh_fields();
						frappe.show_alert({
							message: __('All entries cleared'),
							indicator: 'green'
						}, 3);
					}
				);
			}, __("Actions"));
		}
	},
	
	onload(frm) {
		// Don't set default dates - let user select based on fiscal year they want to reconcile
		// They should match the fiscal year dates of the Zakaah Calculation Runs they want to pay

		// Force tables to be visible by adding placeholder rows
		frm.trigger('ensure_tables_visible');

		// Don't auto-load - user must click "Get Unreconciled Entries" after selecting date range

		// Load allocation history
		frm.trigger("load_allocation_history");
	},
	
	ensure_tables_visible(frm) {
		// Force grid to render even when empty
		setTimeout(() => {
			// Try to access grid directly and force render
			if (frm.fields_dict.payment_entries && frm.fields_dict.payment_entries.grid) {
				if (!frm.doc.payment_entries || frm.doc.payment_entries.length === 0) {
					// Force grid to show by temporarily enabling add button
					frm.fields_dict.payment_entries.grid.cannot_add_rows = false;
					frm.fields_dict.payment_entries.grid.cannot_delete_rows = true;
					// Add empty row then remove immediately to trigger render
					let grid = frm.fields_dict.payment_entries.grid;
					if (grid && grid.add_new_row) {
						let row = grid.add_new_row();
						if (row) {
							setTimeout(() => {
								row.remove && row.remove();
								grid.cannot_add_rows = true;
							}, 100);
						}
					}
				}
			}
			
			if (frm.fields_dict.allocation_history && frm.fields_dict.allocation_history.grid) {
				if (!frm.doc.allocation_history || frm.doc.allocation_history.length === 0) {
					// Force grid to show
					frm.fields_dict.allocation_history.grid.cannot_add_rows = false;
					let grid = frm.fields_dict.allocation_history.grid;
					if (grid && grid.add_new_row) {
						let row = grid.add_new_row();
						if (row) {
							setTimeout(() => {
								row.remove && row.remove();
								grid.cannot_add_rows = true;
							}, 100);
						}
					}
				}
			}
			
			// Also try jQuery manipulation to force visibility
			if (frm.fields_dict.section_payment_entries && frm.fields_dict.section_payment_entries.$wrapper) {
				frm.fields_dict.section_payment_entries.$wrapper.css({
					'display': 'block !important',
					'visibility': 'visible !important'
				}).show();
			}
			if (frm.fields_dict.payment_entries && frm.fields_dict.payment_entries.$wrapper) {
				frm.fields_dict.payment_entries.$wrapper.css({
					'display': 'block !important',
					'visibility': 'visible !important'
				}).show();
			}
			if (frm.fields_dict.section_allocation_history && frm.fields_dict.section_allocation_history.$wrapper) {
				frm.fields_dict.section_allocation_history.$wrapper.css({
					'display': 'block !important',
					'visibility': 'visible !important'
				}).show();
			}
			if (frm.fields_dict.allocation_history && frm.fields_dict.allocation_history.$wrapper) {
				frm.fields_dict.allocation_history.$wrapper.css({
					'display': 'block !important',
					'visibility': 'visible !important'
				}).show();
			}
		}, 500);
	},
	
	show_tables(frm) {
		// Force show tables even when empty
		setTimeout(() => {
			// Show payment_entries section and table using jQuery
			const paymentSection = $(frm.fields_dict.section_payment_entries.$wrapper);
			const paymentTable = $(frm.fields_dict.payment_entries.$wrapper);
			const allocationSection = $(frm.fields_dict.section_allocation_history.$wrapper);
			const allocationTable = $(frm.fields_dict.allocation_history.$wrapper);
			
			if (paymentSection.length) {
				paymentSection.css('display', 'block').show();
			}
			if (paymentTable.length) {
				paymentTable.css('display', 'block').show();
			}
			if (allocationSection.length) {
				allocationSection.css('display', 'block').show();
			}
			if (allocationTable.length) {
				allocationTable.css('display', 'block').show();
			}
			
			// Also try using field wrapper directly
			if (frm.fields_dict.payment_entries && frm.fields_dict.payment_entries.$wrapper) {
				frm.fields_dict.payment_entries.$wrapper.css('display', 'block').show();
			}
			if (frm.fields_dict.section_payment_entries && frm.fields_dict.section_payment_entries.$wrapper) {
				frm.fields_dict.section_payment_entries.$wrapper.css('display', 'block').show();
			}
			if (frm.fields_dict.allocation_history && frm.fields_dict.allocation_history.$wrapper) {
				frm.fields_dict.allocation_history.$wrapper.css('display', 'block').show();
			}
			if (frm.fields_dict.section_allocation_history && frm.fields_dict.section_allocation_history.$wrapper) {
				frm.fields_dict.section_allocation_history.$wrapper.css('display', 'block').show();
			}
		}, 500);
		
		// Also try after form renders
		setTimeout(() => {
			frm.trigger('show_tables');
		}, 1000);
	},
	
	load_data(frm) {
		if (!frm.doc.company) {
			frappe.msgprint(__('Please select a Company first'));
			return;
		}

		if (!frm.doc.from_date || !frm.doc.to_date) {
			frappe.msgprint(__('Please select From Date and To Date.<br><br><strong>Tip:</strong> Set the date range to match the fiscal year you want to reconcile. For example, for FY 2022, use 2022-01-01 to 2022-12-31.'));
			return;
		}
		
		frappe.show_alert({
			message: __('Loading data, please wait...'),
			indicator: 'blue'
		});
		
		// Get payment accounts from Zakaah Assets Configuration
		frappe.call({
			method: 'techstation_zakaah.zakaah_management.doctype.zakaah_payments.zakaah_payments.get_payment_accounts_from_settings',
			args: { company: frm.doc.company },
			callback: function(r) {
				if (!r.message || r.message.length === 0) {
					frappe.msgprint(__('No payment accounts found in Zakaah Assets Configuration. Please configure payment accounts first.'));
					return;
				}
				
				let selected_accounts = r.message.map(account => account.account);
				
				// Load calculation runs (unreconciled only)
				frm.trigger('load_calculation_runs');
				
				// Load journal entries (unreconciled only)
				frappe.call({
					method: 'techstation_zakaah.zakaah_management.doctype.zakaah_payments.zakaah_payments.import_journal_entries',
					args: {
						company: frm.doc.company,
						from_date: frm.doc.from_date,
						to_date: frm.doc.to_date,
						selected_accounts: selected_accounts
					},
					callback: function(r) {
						if (r.message) {
							let journal_entry_records = r.message.journal_entry_records || [];
							let skipped_count = r.message.skipped_count || 0;
							
							// Remove placeholder rows before clearing
							if (frm.doc.payment_entries) {
								frm.doc.payment_entries.forEach((row, idx) => {
									if (row._placeholder) {
										frm.get_field('payment_entries').grid.grid_rows[idx].remove();
									}
								});
							}
							
							frm.clear_table('payment_entries');

							let total_unreconciled = 0;
							if (journal_entry_records && journal_entry_records.length > 0) {
								journal_entry_records.forEach(function(record) {
									let row = frm.add_child('payment_entries');
									row.posting_date = record.posting_date;
									row.journal_entry = record.journal_entry;
									row.debit = record.debit;
									row.credit = record.credit;
									row.balance = record.balance;
									row.remarks = record.remarks || '';
									row.allocated_amount = record.allocated_amount || 0;
									row.unallocated_amount = record.unallocated_amount || record.debit || 0;

									// Add to total unreconciled
									total_unreconciled += (row.unallocated_amount || 0);
								});
							} else {
								// If no records, add placeholder to keep table visible
								let placeholder = frm.add_child('payment_entries');
								placeholder.journal_entry = '';
								placeholder._placeholder = true;
							}

							frm.refresh_field('payment_entries');

							// Set total journal entries unreconciled
							frm.set_value('total_journal_entries', total_unreconciled);

							frm.trigger('refresh');
							
							let message = __('Loaded {0} unreconciled entries', [journal_entry_records.length]);
							if (skipped_count > 0) {
								message += '. ' + __('Skipped {0} already fully allocated', [skipped_count]);
							}
							frappe.show_alert({
								message: message,
								indicator: 'green'
							}, 5);
						}
					}
				});
			}
		});
	},
	
	load_calculation_runs(frm) {
		if (!frm.doc.company) {
			return;
		}
		
		frappe.call({
			method: 'techstation_zakaah.zakaah_management.doctype.zakaah_payments.zakaah_payments.get_calculation_runs',
			args: { 
				company: frm.doc.company,
				show_unreconciled_only: true 
			},
			callback: function(r) {
				if (r.message && r.message.length > 0) {
					frm.clear_table('calculation_runs');
					
					let total_outstanding = 0;
					r.message.forEach(run => {
						let row = frm.add_child('calculation_runs');
						row.zakaah_calculation_run = run.name;
						row.fiscal_year = run.fiscal_year || '';
						row.total_zakaah = run.total_zakaah;
						row.paid_zakaah = run.paid_zakaah || 0;
						row.outstanding_zakaah = run.outstanding_zakaah || run.total_zakaah;
						row.status = run.status;
						
						total_outstanding += (run.outstanding_zakaah || 0);
					});
					
					frm.refresh_field('calculation_runs');

					// Set total calculation runs outstanding
					frm.set_value('total_calculation_runs', total_outstanding);

					frm.trigger('refresh');

					if (total_outstanding > 0) {
						frappe.show_alert({
							message: __('Found {0} unreconciled year(s) with outstanding: {1}',
									[r.message.length, format_currency(total_outstanding)]),
							indicator: 'blue'
						}, 5);
					}
				} else {
					frappe.show_alert({
						message: __('All zakaah years are fully paid'),
						indicator: 'green'
					}, 5);
				}
			}
		});
	},
	
	allocate_payments(frm) {
		console.log('Allocate Payments clicked');

		// Use Frappe's built-in grid selection methods
		let selected_run_indices = [];
		let selected_entry_indices = [];

		// Get selected calculation runs using Frappe grid API
		if (frm.fields_dict.calculation_runs && frm.fields_dict.calculation_runs.grid) {
			let grid = frm.fields_dict.calculation_runs.grid;

			// Try to get selected using Frappe's method
			if (grid.get_selected) {
				let selected = grid.get_selected();
				console.log('Selected calculation runs (grid.get_selected):', selected);
				selected_run_indices = selected.map(name => {
					return frm.doc.calculation_runs.findIndex(row => row.name === name);
				});
			} else {
				// Fallback: check all rows
				frm.doc.calculation_runs.forEach((row, idx) => {
					selected_run_indices.push(idx);
				});
				console.log('No get_selected method - using all calculation runs');
			}
		}

		console.log('Selected run indices:', selected_run_indices);

		// Get selected payment entries using Frappe grid API
		if (frm.fields_dict.payment_entries && frm.fields_dict.payment_entries.grid) {
			let grid = frm.fields_dict.payment_entries.grid;

			// Try to get selected using Frappe's method
			if (grid.get_selected) {
				let selected = grid.get_selected();
				console.log('Selected payment entries (grid.get_selected):', selected);
				selected_entry_indices = selected.map(name => {
					return frm.doc.payment_entries.findIndex(row => row.name === name);
				});
			} else {
				// Fallback: check all rows
				frm.doc.payment_entries.forEach((row, idx) => {
					selected_entry_indices.push(idx);
				});
				console.log('No get_selected method - using all payment entries');
			}
		}

		console.log('Selected entry indices:', selected_entry_indices);
		
		// If no rows selected, use all rows with outstanding balance (backward compatibility)
		let selected_runs = [];
		if (selected_run_indices.length > 0) {
			selected_run_indices.forEach(idx => {
				if (frm.doc.calculation_runs && frm.doc.calculation_runs[idx]) {
					let run = frm.doc.calculation_runs[idx];
					if ((run.outstanding_zakaah || 0) > 0) {
						selected_runs.push(run);
					}
				}
			});
		} else {
			// No selection - use all with outstanding balance
			selected_runs = frm.doc.calculation_runs.filter(run =>
				(run.outstanding_zakaah || 0) > 0
			);
		}
		
		// If no rows selected, use all rows with unallocated amount
		let selected_entries = [];
		if (selected_entry_indices.length > 0) {
			selected_entry_indices.forEach(idx => {
				if (frm.doc.payment_entries && frm.doc.payment_entries[idx]) {
					let entry = frm.doc.payment_entries[idx];
					if ((entry.unallocated_amount || entry.debit || 0) > 0) {
						selected_entries.push(entry);
					}
				}
			});
		} else {
			// No selection - use all with unallocated amount
			selected_entries = frm.doc.payment_entries.filter(entry =>
				(entry.unallocated_amount || entry.debit || 0) > 0
			);
		}
		
		console.log('Selected runs:', selected_runs.length);
		console.log('Selected entries:', selected_entries.length);

		if (selected_runs.length === 0) {
			console.log('ERROR: No runs with outstanding balance');
			frappe.msgprint(__('No Zakaah Calculation Runs with outstanding balance available'));
			return;
		}

		if (selected_entries.length === 0) {
			console.log('ERROR: No unallocated entries');
			frappe.msgprint(__('No unallocated Journal Entries available'));
			return;
		}

		console.log('Proceeding to confirmation dialog');

		// Calculate totals for confirmation
		let total_journal_amount = selected_entries.reduce((sum, entry) => 
			sum + (entry.unallocated_amount || entry.debit || 0), 0);
		let total_outstanding = selected_runs.reduce((sum, run) => 
			sum + (run.outstanding_zakaah || 0), 0);
		
		// Build confirmation message
		let message = `<div style="margin-bottom: 15px;">
			<strong>Allocation Summary:</strong><br>
			• Journal Entries: ${selected_entries.length} (Total: ${format_currency(total_journal_amount)})<br>
			• ZCR Records: ${selected_runs.length} (Total Outstanding: ${format_currency(total_outstanding)})<br>
		</div>`;
		
		if (total_journal_amount > total_outstanding) {
			message += `<div style="background-color: #fff3cd; padding: 10px; border-radius: 4px; margin-bottom: 10px;">
				<strong>⚠️ Note:</strong> Journal entry amount (${format_currency(total_journal_amount)}) exceeds
				total outstanding (${format_currency(total_outstanding)}). Excess amount of
				${format_currency(total_journal_amount - total_outstanding)} will remain unallocated
				for the next fiscal year.
			</div>`;
		}
		
		message += `<div style="margin-top: 15px;">
			<strong>Do you want to proceed with the allocation?</strong>
		</div>`;
		
		// Confirm allocation
		frappe.confirm(
			message,
			function() {
				frappe.show_alert({
					message: __('Processing allocation...'),
					indicator: 'blue'
				});
				
				frappe.call({
					method: 'techstation_zakaah.zakaah_management.doctype.zakaah_payments.zakaah_payments.allocate_payments',
					args: {
						calculation_run_items: selected_runs,
						journal_entries: selected_entries
					},
					callback: function(r) {
						if (r.message && r.message.success) {
							frappe.show_alert({
								message: __('Allocation completed successfully'),
								indicator: 'green'
							}, 5);
							
							setTimeout(() => {
								frm.trigger('load_data');
							}, 2000);
						} else {
							frappe.msgprint(__('Allocation failed: {0}', [r.message.message || 'Unknown error']));
						}
					}
				});
			}
		);
	},
	
	load_allocation_history(frm) {
		frappe.call({
			method: 'techstation_zakaah.zakaah_management.doctype.zakaah_payments.zakaah_payments.get_allocation_history',
			callback: function(r) {
				// Remove placeholder rows before clearing
				if (frm.doc.allocation_history) {
					frm.doc.allocation_history.forEach((row, idx) => {
						if (row._placeholder && frm.get_field('allocation_history').grid.grid_rows[idx]) {
							frm.get_field('allocation_history').grid.grid_rows[idx].remove();
						}
					});
				}
				
				frm.clear_table('allocation_history');
				
				if (r.message && r.message.length > 0) {
					r.message.forEach(function(record) {
						let row = frm.add_child('allocation_history');
						row.journal_entry = record.journal_entry;
						row.zakaah_calculation_run = record.zakaah_calculation_run;
						row.allocated_amount = record.allocated_amount;
						row.unallocated_amount = record.unallocated_amount;
						row.allocation_date = record.allocation_date;
					});
				} else {
					// If no records, add placeholder to keep table visible
					let placeholder = frm.add_child('allocation_history');
					placeholder.journal_entry = '';
					placeholder._placeholder = true;
				}
				
				frm.refresh_field('allocation_history');
				frm.trigger('hide_select_columns');
			}
		});
	},
	
	setup_checkboxes(frm) {
		// Only hide checkboxes for allocation_history (read-only history)
		// Show checkboxes for calculation_runs and payment_entries (by default, no action needed)
		setTimeout(() => {
			// Hide checkboxes ONLY for allocation_history in THIS form
			if (frm.fields_dict.allocation_history && frm.fields_dict.allocation_history.grid) {
				frm.fields_dict.allocation_history.grid.wrapper.find('th:first-child, td:first-child').hide();
				frm.fields_dict.allocation_history.grid.wrapper.find('input[type="checkbox"]').hide().closest('th, td').hide();
			}
		}, 300);
	},
	
	hide_select_columns(frm) {
		// Only hide checkboxes for allocation_history (called after refresh)
		setTimeout(() => {
			if (frm.fields_dict.allocation_history && frm.fields_dict.allocation_history.grid) {
				frm.fields_dict.allocation_history.grid.wrapper.find('th:first-child, td:first-child').hide();
				frm.fields_dict.allocation_history.grid.wrapper.find('input[type="checkbox"]').hide().closest('th, td').hide();
			}
		}, 100);
	}
});

function format_currency(amount) {
	return frappe.format(amount, {
		fieldtype: "Currency",
		precision: 2
	});
}

