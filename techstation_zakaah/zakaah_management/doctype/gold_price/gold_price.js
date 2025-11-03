frappe.ui.form.on('Gold Price', {
    price_date: function(frm) {
        // Manual entry only - no automatic fetching
        // User must enter price manually
    },
    
    refresh: function(frm) {
        // Show message that manual entry is required
        if (frm.is_new()) {
            frappe.show_alert({
                message: __('Please enter the gold price manually'),
                indicator: 'orange'
            }, 5);
        }
        
        // Show message that price is editable
        if (frm.doc.price_per_gram_24k) {
            frm.dashboard.add_indicator(__('Price is editable - you can modify it'), 'blue');
        }
    }
});

// Removed automatic fetching - manual entry only
