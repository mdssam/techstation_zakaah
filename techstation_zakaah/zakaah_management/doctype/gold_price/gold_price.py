
from __future__ import unicode_literals
from frappe.model.document import Document
import frappe

class GoldPrice(Document):
    def validate(self):
        # Set default source if not set
        if not self.source:
            self.source = "Manual Entry"
        
        # Ensure price is manually entered
        if not self.price_per_gram_24k:
            frappe.throw("Please enter the gold price manually")

@frappe.whitelist()
def get_gold_price_for_date(date):
    """Get gold price for a specific date from database only (manual entry)
    
    Returns None if price not found in database
    """
    # Check if exists in DB
    existing = frappe.db.exists("Gold Price", {"price_date": date})
    if existing:
        return frappe.db.get_value("Gold Price", existing, "price_per_gram_24k")
    
    # Return None if not found (no automatic fetching)
    return None
