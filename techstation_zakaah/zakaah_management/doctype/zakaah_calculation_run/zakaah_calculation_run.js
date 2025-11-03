frappe.ui.form.on('Zakaah Calculation Run', {
    
    fiscal_year: function(frm) {
        if (frm.doc.fiscal_year) {
            // Fetch fiscal year dates
            frappe.call({
                method: 'frappe.client.get',
                args: {
                    doctype: 'Fiscal Year',
                    name: frm.doc.fiscal_year
                },
                callback: function(r) {
                    if (r.message && r.message.year_start_date && r.message.year_end_date) {
                        // Only update if dates are not manually set
                        if (!frm.doc.from_date) {
                            frm.set_value('from_date', r.message.year_start_date);
                        }
                        if (!frm.doc.to_date) {
                            frm.set_value('to_date', r.message.year_end_date);
                        }
                        
                        // Auto-set gold price date to end of fiscal year
                        // User can change it if needed for historical dates
                        if (!frm.doc.gold_price_date && r.message.year_end_date) {
                            frm.set_value('gold_price_date', r.message.year_end_date);
                            // Manual entry required - don't fetch automatically
                        }
                    }
                }
            });
        }
    },
    
    gold_price_date: function(frm) {
        if (frm.doc.gold_price_date) {
            // Manual entry required - check if exists in DB only
            fetch_gold_price_for_date(frm, frm.doc.gold_price_date);
        }
        // Auto-calculate nisab when dates change
        calculate_nisab(frm);
    },
    
    owners_count: function(frm) {
        // Auto-calculate nisab when owners count changes
        calculate_nisab(frm);
    },
    
    gold_price_per_gram_24k: function(frm) {
        // Auto-calculate nisab when gold price changes
        calculate_nisab(frm);
    },
    
    refresh: function(frm) {
        // Add Calculate button
        if (frm.doc.status === 'Draft' && frm.doc.company && frm.doc.to_date) {
            frm.add_custom_button(__('Calculate Zakaah'), function() {
                frm.call({
                    method: 'techstation_zakaah.zakaah_management.doctype.zakaah_calculation_run.zakaah_calculation_run.calculate_zakaah_for_run',
                    args: {
                        name: frm.doc.name
                    },
                    callback: function(r) {
                        if (r.message) {
                            frappe.model.set_value(frm.doctype, frm.doc.name, r.message);
                            frm.reload_doc();
                            frappe.show_alert({
                                message: __('Zakaah calculation completed!'),
                                indicator: 'green'
                            }, 5);
                        }
                    },
                    error: function() {
                        frappe.msgprint(__('Error calculating zakaah.'));
                    }
                });
            }, __('Actions'));
        }
        
        // Add Load Journal Entries button (show always)
        frm.add_custom_button(__('Load Journal Entries'), function() {
            // Check if document is saved
            if (!frm.doc.name || frm.doc.name.startsWith('New')) {
                frappe.msgprint(__('Please save the document first before loading journal entries.'));
                return;
            }
            
            if (!frm.doc.payment_accounts || frm.doc.payment_accounts.length === 0) {
                frappe.msgprint(__('Please add accounts in "Zakaah Payment Accounts" section first.'));
                return;
            }
            
            frm.call({
                method: 'techstation_zakaah.zakaah_management.doctype.zakaah_calculation_run.zakaah_calculation_run.get_journal_entries_for_calculation_run',
                args: {
                    calculation_run_name: frm.doc.name
                },
                callback: function(r) {
                    if (r.message && r.message.length > 0) {
                        frm.clear_table('journal_entries');
                        r.message.forEach(function(entry) {
                            let row = frm.add_child('journal_entries');
                            row.journal_entry = entry.journal_entry;
                            row.posting_date = entry.posting_date;
                            row.account = entry.account;
                            row.total_debit = entry.debit || 0;  // Map 'debit' to 'total_debit'
                        });
                        frm.refresh_field('journal_entries');
                        frappe.show_alert({
                            message: __('Loaded {0} journal entries', [r.message.length]),
                            indicator: 'green'
                        }, 5);
                    } else {
                        frappe.show_alert({
                            message: __('No journal entries found'),
                            indicator: 'orange'
                        }, 3);
                    }
                },
                error: function() {
                    frappe.msgprint(__('Error loading journal entries.'));
                }
            });
        }, __('Actions'));
        
        // Add Debug button
        if (frm.doc.status === 'Draft' && frm.doc.company && frm.doc.to_date) {
            frm.add_custom_button(__('Debug Accounts'), function() {
                frm.call({
                    method: 'techstation_zakaah.zakaah_management.doctype.zakaah_calculation_run.zakaah_calculation_run.debug_all_config_accounts',
                    args: {
                        company: frm.doc.company,
                        fiscal_year: frm.doc.fiscal_year,
                        to_date: frm.doc.to_date
                    },
                    callback: function(r) {
                        if (r.message) {
                            let msg = 'DEBUG RESULTS:\n';
                            msg += '\n=== CASH ACCOUNTS ===';
                            r.message.cash_accounts.forEach(function(acc) {
                                msg += '\n' + acc.account + ': ' + acc.balance.toFixed(2);
                            });
                            msg += '\nTotal Cash: ' + r.message.total_cash.toFixed(2);
                            msg += '\n\n=== INVENTORY ACCOUNTS ===';
                            r.message.inventory_accounts.forEach(function(acc) {
                                msg += '\n' + acc.account + ': ' + acc.balance.toFixed(2);
                            });
                            msg += '\nTotal Inventory: ' + r.message.total_inventory.toFixed(2);
                            frappe.msgprint(msg);
                        }
                    },
                    error: function(r) {
                        frappe.msgprint('Error: ' + JSON.stringify(r));
                    }
                });
            }, __('Actions'));
        }
        
        // Auto-fill dates if fiscal year is set and dates are empty
        if (frm.doc.fiscal_year && (!frm.doc.from_date || !frm.doc.to_date)) {
            frappe.call({
                method: 'frappe.client.get',
                args: {
                    doctype: 'Fiscal Year',
                    name: frm.doc.fiscal_year
                },
                callback: function(r) {
                    if (r.message && r.message.year_start_date && r.message.year_end_date) {
                        if (!frm.doc.from_date) {
                            frm.set_value('from_date', r.message.year_start_date);
                        }
                        if (!frm.doc.to_date) {
                            frm.set_value('to_date', r.message.year_end_date);
                        }
                    }
                }
            });
        }
        
        // Auto-set gold price date to to_date if not set
        if (!frm.doc.gold_price_date && frm.doc.to_date) {
            frm.set_value('gold_price_date', frm.doc.to_date);
            // Manual entry required - don't fetch automatically
        }
    }
});

function load_payment_accounts(frm) {
    // Load payment accounts from Zakaah Assets Configuration
    // IMPORTANT: Payment accounts are the Payable Accounts from configuration
    if (!frm.doc.company) return;
    
    frappe.call({
        method: 'frappe.client.get_list',
        args: {
            doctype: 'Zakaah Assets Configuration',
            filters: {
                company: frm.doc.company
            },
            fields: ['name'],
            limit_page_length: 1
        },
        callback: function(r) {
            if (r.message && r.message.length > 0) {
                // Get the configuration document
                frappe.call({
                    method: 'frappe.client.get',
                    args: {
                        doctype: 'Zakaah Assets Configuration',
                        name: r.message[0].name
                    },
                    callback: function(config) {
                        if (config.message) {
                            // Clear existing payment accounts
                            frm.clear_table('payment_accounts');
                            
                            // Add payable accounts from configuration (these are the payment accounts for Zakaah)
                            if (config.message.liabilities_accounts && config.message.liabilities_accounts.length > 0) {
                                config.message.liabilities_accounts.forEach(function(acc) {
                                    let row = frm.add_child('payment_accounts');
                                    row.account = acc.account;
                                });
                            }
                            
                            if (frm.doc.payment_accounts.length > 0) {
                                frm.refresh_field('payment_accounts');
                                frappe.show_alert({
                                    message: __('Loaded {0} payment accounts (Payable Accounts) from configuration', [frm.doc.payment_accounts.length]),
                                    indicator: 'green'
                                }, 3);
                            }
                        }
                    }
                });
            }
        }
    });
}

function calculate_nisab(frm) {
    if (frm.doc.gold_price_per_gram_24k && frm.doc.owners_count) {
        const nisab_grams = frm.doc.owners_count * 85;
        const nisab_value = nisab_grams * frm.doc.gold_price_per_gram_24k;
        frm.set_value('nisab_value', nisab_value);
    }
}

function fetch_gold_price_for_date(frm, date) {
    frappe.show_alert({
        message: __('Checking for gold price for ' + date + '...'),
        indicator: 'blue'
    }, 3);
    
    frappe.call({
        method: 'frappe.client.get_list',
        args: {
            doctype: 'Gold Price',
            filters: {'price_date': date},
            fields: ['name', 'price_date', 'price_per_gram_24k'],
            limit_page_length: 1
        },
        callback: function(r) {
            // Debug: show what we got
            frappe.log_error('Gold price query result for date ' + date + ': ' + JSON.stringify(r.message), 'Gold Price Debug');
            
            if (r.message && r.message.length > 0) {
                // Gold price exists for this date
                const gold_price = r.message[0];
                frm.set_value('gold_price_per_gram_24k', gold_price.price_per_gram_24k);
                frappe.show_alert({
                    message: __('Gold price loaded: ' + gold_price.price_per_gram_24k + ' EGP'),
                    indicator: 'green'
                }, 3);
                // Auto-calculate nisab
                calculate_nisab(frm);
            } else {
                // Check if there are any gold prices at all
                frappe.call({
                    method: 'frappe.client.get_list',
                    args: {
                        doctype: 'Gold Price',
                        fields: ['name', 'price_date'],
                        limit_page_length: 10,
                        order_by: 'price_date DESC'
                    },
                    callback: function(all_prices) {
                        let message = 'Gold price not found for date: ' + date + '.\n\n';
                        if (all_prices.message && all_prices.message.length > 0) {
                            message += 'Available dates: ';
                            all_prices.message.forEach(p => {
                                message += p.price_date + ', ';
                            });
                        } else {
                            message += 'No gold prices exist in the system.';
                        }
                        message += '\n\nPlease enter it manually in Gold Price doctype.';
                        frappe.msgprint(message);
                    }
                });
            }
        }
    });
}
