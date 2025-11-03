
from __future__ import unicode_literals
from frappe.model.document import Document
import frappe
from frappe import _
from frappe.utils import flt

class ZakaahCalculationRun(Document):
    def validate(self):
        if not self.status:
            self.status = "Draft"
        
        # Auto-populate dates from fiscal year if not set
        if self.fiscal_year and (not self.from_date or not self.to_date):
            fiscal_year_doc = frappe.get_doc("Fiscal Year", self.fiscal_year)
            if not self.from_date:
                self.from_date = fiscal_year_doc.year_start_date
            if not self.to_date:
                self.to_date = fiscal_year_doc.year_end_date
        
        # Auto-set gold price date to to_date (end of fiscal year)
        # User can change it if needed
        if not self.gold_price_date and self.to_date:
            self.gold_price_date = self.to_date
        
        # Validate dates if both are set
        if self.from_date and self.to_date:
            if self.from_date >= self.to_date:
                frappe.throw(_("From Date must be before To Date"))
        
        # Auto-load payment accounts from Zakaah Assets Configuration
        if self.company and self.fiscal_year and not self.payment_accounts:
            self._load_payment_accounts()
        
        # Auto-load journal entries if payment accounts exist
        if self.payment_accounts and len(self.payment_accounts) > 0:
            self._load_journal_entries()
    
    def _load_payment_accounts(self):
        """Load payment accounts from Zakaah Assets Configuration"""
        try:
            # Get configuration for this company and fiscal year
            config = frappe.db.get_value("Zakaah Assets Configuration", 
                                        {"company": self.company, "fiscal_year": self.fiscal_year}, 
                                        "name")
            if not config:
                return
            
            # Get the configuration document
            config_doc = frappe.get_doc("Zakaah Assets Configuration", config)
            
            # Load payment accounts (these are the liabilities accounts)
            if config_doc.payment_accounts:
                self.payment_accounts = []
                for acc in config_doc.payment_accounts:
                    self.append("payment_accounts", {
                        "account": acc.account,
                        "debit": acc.debit if hasattr(acc, 'debit') else 0
                    })
        except Exception as e:
            frappe.log_error(f"Error loading payment accounts: {str(e)}", "Load Payment Accounts Error")
    
    def _load_journal_entries(self):
        """Load journal entries based on payment accounts"""
        try:
            # Skip if already loaded (to avoid reloading)
            if self.journal_entries and len(self.journal_entries) > 0:
                return
            
            # Get payment account names
            payment_accounts = [row.account for row in self.payment_accounts if row.account]
            
            if not payment_accounts:
                return
            
            # Query Journal Entries - include child accounts too
            journal_entries = frappe.db.sql("""
                SELECT DISTINCT
                    je.name as journal_entry,
                    je.posting_date,
                    jea.account,
                    SUM(jea.debit) as total_debit
                FROM `tabJournal Entry` je
                INNER JOIN `tabJournal Entry Account` jea ON jea.parent = je.name
                INNER JOIN `tabAccount` acc ON acc.name = jea.account
                WHERE je.docstatus = 1
                    AND je.posting_date BETWEEN %(from_date)s AND %(to_date)s
                    AND (
                        jea.account IN %(accounts)s
                        OR acc.parent_account LIKE %(parent_like)s
                        OR REPLACE(acc.parent_account, ' - ', '-') LIKE %(parent_like2)s
                    )
                GROUP BY je.name, je.posting_date, jea.account
                HAVING SUM(jea.debit) > 0
                ORDER BY je.posting_date DESC
            """, {
                'accounts': payment_accounts,
                'from_date': self.from_date,
                'to_date': self.to_date,
                'parent_like': f"%/{payment_accounts[0]}",
                'parent_like2': f"%%{payment_accounts[0]}%%"
            }, as_dict=True)
            
            # Add journal entries to child table
            for entry in journal_entries:
                self.append("journal_entries", {
                    "journal_entry": entry.journal_entry,
                    "posting_date": entry.posting_date,
                    "account": entry.account,
                    "total_debit": entry.total_debit or 0
                })
                
        except Exception as e:
            frappe.log_error(f"Error loading journal entries: {str(e)}", "Load Journal Entries Error")
    
    def before_save(self):
        """Calculate Zakaah before saving if status is Draft"""
        if self.status == "Draft" and self.company and self.to_date:
            try:
                self.calculate_zakaah()
            except Exception as e:
                # Don't throw error, just log it
                frappe.log_error(f"Error calculating zakaah: {str(e)}")
    
    def on_submit(self):
        """Calculate Zakaah when submitted"""
        if self.status == "Draft":
            self.calculate_zakaah()
    
    def calculate_zakaah(self):
        """Main calculation method"""
        frappe.msgprint(_("Calculating Zakaah... This may take a few moments."))
        
        try:
            # Check if dates are set
            if not self.to_date:
                frappe.throw(_("To Date is required. Please select a fiscal year or set the dates manually."))
            
            # Get assets configuration for company and fiscal year
            config = get_zakaah_assets_config(self.company, self.fiscal_year)
            
            # Clear existing items
            self.items = []
            
            # Calculate all assets AND populate items table
            assets = self.calculate_assets(config, self.company)
            
            # Show warning if assets are 0
            if assets['total_in_egp'] == 0:
                frappe.msgprint(_("⚠️ Warning: Total assets calculated as 0. This might mean:\n- No GL Entries for the selected date range\n- Accounts have no balance\n- Wrong account names in configuration"), indicator='orange')
            
            # Get gold price
            gold_info = self.get_gold_price_info()
            
            # Calculate Nisab and Zakaah
            zakaah_info = self.calculate_nisab_and_zakaah(assets['total_in_egp'], gold_info['price'])
            
            # Update fields
            self.update_asset_fields(assets)
            self.update_gold_fields(gold_info, zakaah_info)
            self.update_zakaah_fields(zakaah_info)
            
            # Update outstanding
            self.outstanding_zakaah = self.total_zakaah - self.paid_zakaah
            
            frappe.msgprint(_("Zakaah calculation completed successfully!"))
            
        except Exception as e:
            frappe.msgprint(f"Calculation error: {str(e)}", indicator='red')
            raise
    
    def calculate_assets(self, config, company=None):
        """Calculate all assets based on configuration"""
        assets = {
            'cash': 0,
            'inventory': 0,
            'receivables': 0,
            'liabilities': 0,
            'reserves': 0
        }
        
        # frappe.log_error(f"Dates: {self.to_date}, Company: {company}", "Zakaah Calc")  # Debug logging removed

        # Cash accounts
        for idx, row in enumerate(config.get('cash_accounts', [])):
            # Now row should be a dict, access with .get()
            account_name = row.get('account') if isinstance(row, dict) else None
            # frappe.log_error(f"Cash row {idx}: account={account_name}", "Zakaah Config")  # Debug logging removed
            if account_name:
                balance = get_account_balance(account_name, self.to_date, company)
                # frappe.log_error(f"Cash: {account_name} = {balance:.0f}", "Zakaah Calc")  # Debug logging removed
                assets['cash'] += balance
                
                # Add to items table
                if balance > 0:
                    self.append("items", {
                        "asset_category": "Cash",
                        "account": account_name,
                        "balance": balance,
                        "currency": "EGP",
                        "exchange_rate": 1,
                        "sub_total": balance
                    })
            # else:
                # frappe.log_error(f"Err: No account in row {idx}", "Zakaah Calc")  # Debug logging removed

        # Inventory accounts
        for idx, row in enumerate(config.get('inventory_accounts', [])):
            account_name = row.get('account') if isinstance(row, dict) else None
            if account_name:
                balance = get_account_balance(account_name, self.to_date, company)
                # frappe.log_error(f"Inv: {account_name} = {balance:.0f}", "Zakaah Calc")  # Debug logging removed
                assets['inventory'] += balance
                
                if balance > 0:
                    self.append("items", {
                        "asset_category": "Inventory",
                        "account": account_name,
                        "balance": balance,
                        "currency": "EGP",
                        "exchange_rate": 1,
                        "sub_total": balance
                    })
        
        # Receivables
        for idx, row in enumerate(config.get('receivable_accounts', [])):
            account_name = row.get('account') if isinstance(row, dict) else None
            if account_name:
                balance = get_account_balance(account_name, self.to_date, company)
                # frappe.log_error(f"Recv: {account_name} = {balance:.0f}", "Zakaah Calc")  # Debug logging removed
                assets['receivables'] += balance
                
                if balance > 0:
                    self.append("items", {
                        "asset_category": "Receivables",
                        "account": account_name,
                        "balance": balance,
                        "currency": "EGP",
                        "exchange_rate": 1,
                        "sub_total": balance
                    })
        
        # Payables (subtract from assets)
        for idx, row in enumerate(config.get('liabilities_accounts', [])):
            account_name = row.get('account') if isinstance(row, dict) else None
            if account_name:
                balance = get_account_balance(account_name, self.to_date, company)
                # frappe.log_error(f"Pay: {account_name} = {balance:.0f}", "Zakaah Calc")  # Debug logging removed
                # Liabilities, add to deduct from assets
                assets['liabilities'] += balance
                
                if balance > 0:
                    self.append("items", {
                        "asset_category": "Liabilities",
                        "account": account_name,
                        "balance": balance,
                        "currency": "EGP",
                        "exchange_rate": 1,
                        "sub_total": balance
                    })
        
        # Reserves
        for idx, row in enumerate(config.get('reserve_accounts', [])):
            account_name = row.get('account') if isinstance(row, dict) else None
            if account_name:
                balance = get_account_balance(account_name, self.to_date, company)
                # frappe.log_error(f"Resv: {account_name} = {balance:.0f}", "Zakaah Calc")  # Debug logging removed
                assets['reserves'] += balance
                
                if balance > 0:
                    self.append("items", {
                        "asset_category": "Reserves",
                        "account": account_name,
                        "balance": balance,
                        "currency": "EGP",
                        "exchange_rate": 1,
                        "sub_total": balance
                    })
        
        # Calculate total
        assets['total_in_egp'] = (
            assets['cash'] +
            assets['inventory'] +
            assets['receivables'] -
            assets['liabilities'] +
            assets['reserves']
        )

        # Log summary (Debug logging removed)
        # frappe.log_error(f"Total: c={assets['cash']:.0f} i={assets['inventory']:.0f} tot={assets['total_in_egp']:.0f}", "Zakaah Calc")

        return assets
    
    def get_gold_price_info(self):
        """Get gold price for calculation date"""
        # Use the selected gold price date, or fall back to to_date
        price_date = self.gold_price_date or self.to_date
        
        price = frappe.db.get_value("Gold Price", 
                                   {"price_date": price_date}, 
                                   "price_per_gram_24k")
        
        # If not found, try to fetch it from the website
        if not price:
            try:
                # Import the whitelist function to fetch price
                from techstation_zakaah.zakaah_management.doctype.gold_price.gold_price import get_gold_price_for_date
                price = get_gold_price_for_date(price_date)
                
                # If still not found, use default
                if not price:
                    price = 6171
            except Exception as e:
                frappe.log_error(f"Error fetching gold price: {str(e)}")
                price = 6171
        
        return {
            'date': price_date,
            'price': price
        }
    
    def calculate_nisab_and_zakaah(self, total_assets, gold_price):
        """Calculate Nisab and Zakaah amount"""
        # Get number of owners (default to 1 if not set)
        owners_count = self.owners_count or 1
        
        # Calculate nisab: owners_count * 85 * gold_price
        nisab_grams = owners_count * 85
        nisab_value = nisab_grams * gold_price
        
        assets_in_gold = total_assets / gold_price
        meets_nisab = assets_in_gold >= nisab_grams
        
        if meets_nisab:
            zakaah_amount = total_assets * 0.025
            status = "Calculated"
        else:
            zakaah_amount = 0
            status = "Not Due"
        
        return {
            'nisab_value': nisab_value,
            'assets_in_gold_grams': assets_in_gold,
            'meets_nisab': meets_nisab,
            'zakaah_amount': zakaah_amount,
            'status': status
        }
    
    def update_asset_fields(self, assets):
        self.cash_balance = assets['cash']
        self.inventory_balance = assets['inventory']
        self.receivables = assets['receivables']
        self.liabilities = assets['liabilities']
        self.reserves = assets.get('reserves', 0)
        self.total_assets = assets['total_in_egp']
    
    def update_gold_fields(self, gold_info, zakaah_info):
        self.gold_price_date = gold_info['date']
        self.gold_price_per_gram_24k = gold_info['price']
        self.nisab_value = zakaah_info['nisab_value']
        self.assets_in_gold_grams = zakaah_info['assets_in_gold_grams']
        self.nisab_met = zakaah_info['meets_nisab']
    
    def update_zakaah_fields(self, zakaah_info):
        self.total_zakaah = zakaah_info['zakaah_amount']
        self.outstanding_zakaah = zakaah_info['zakaah_amount']
        self.status = zakaah_info['status']

# Helper functions
def get_zakaah_assets_config(company, fiscal_year=None):
    """Get assets configuration for company and fiscal year"""
    try:
        filters = {"company": company}
        if fiscal_year:
            filters["fiscal_year"] = fiscal_year
        
        # Try to find config by company and fiscal year
        config_list = frappe.get_all("Zakaah Assets Configuration", 
                                     filters=filters, 
                                     limit=1)
        
        if not config_list and fiscal_year:
            # If not found with fiscal year, try without fiscal year
            config_list = frappe.get_all("Zakaah Assets Configuration", 
                                        filters={"company": company}, 
                                        limit=1)
            if config_list:
                frappe.msgprint(_("Warning: No Zakaah Assets Configuration found for company {0} and fiscal year {1}. Using configuration without fiscal year.").format(company, fiscal_year), indicator='orange')
        
        if not config_list:
            # Try to get any default config
            config_list = frappe.get_all("Zakaah Assets Configuration", limit=1)
            if config_list:
                frappe.msgprint(_("Warning: No Zakaah Assets Configuration found for company {0}. Using default configuration.").format(company), indicator='orange')
        
        if not config_list:
            frappe.throw(_("No Zakaah Assets Configuration found. Please create one in Zakaah Assets Configuration DocType."))
        
        config_doc = frappe.get_doc("Zakaah Assets Configuration", config_list[0].name)
        
        # Get child tables as dicts for easier access
        cash_accounts = []
        for row in (config_doc.cash_accounts or []):
            if isinstance(row, dict):
                cash_accounts.append(row)
            else:
                # Convert child doc to dict
                cash_accounts.append(row.as_dict())
        
        inventory_accounts = []
        for row in (config_doc.inventory_accounts or []):
            if isinstance(row, dict):
                inventory_accounts.append(row)
            else:
                inventory_accounts.append(row.as_dict())
        
        receivable_accounts = []
        for row in (config_doc.receivable_accounts or []):
            if isinstance(row, dict):
                receivable_accounts.append(row)
            else:
                receivable_accounts.append(row.as_dict())
        
        payable_accounts = []
        for row in (config_doc.liabilities_accounts or []):
            if isinstance(row, dict):
                payable_accounts.append(row)
            else:
                payable_accounts.append(row.as_dict())
        
        reserve_accounts = []
        for row in (config_doc.reserve_accounts or []):
            if isinstance(row, dict):
                reserve_accounts.append(row)
            else:
                reserve_accounts.append(row.as_dict())
        
        # Log actual account names (Debug logging removed)
        # cash_names = [row.get('account') for row in cash_accounts if row.get('account')]
        # inventory_names = [row.get('account') for row in inventory_accounts if row.get('account')]
        # frappe.log_error(f"Cash accounts configured: {cash_names}", "Zakaah Config")
        # frappe.log_error(f"Inventory accounts configured: {inventory_names}", "Zakaah Config")

        # Check if any accounts are configured
        total_accounts = (len(cash_accounts) + len(inventory_accounts) + 
                         len(receivable_accounts) + len(payable_accounts) + 
                         len(reserve_accounts))
        
        if total_accounts == 0:
            frappe.throw(_("No accounts configured in Zakaah Assets Configuration. Please add accounts in the configuration document."))
        
        return {
            'cash_accounts': cash_accounts,
            'inventory_accounts': inventory_accounts,
            'receivable_accounts': receivable_accounts,
            'liabilities_accounts': payable_accounts,
            'reserve_accounts': reserve_accounts
        }
    except Exception as e:
        frappe.log_error(f"Error getting config", "Zakaah Config")
        frappe.throw(_("Error getting Zakaah Assets Configuration: {0}").format(str(e)))

@frappe.whitelist()
def calculate_zakaah_for_run(name):
    """Calculate zakaah for a specific run"""
    doc = frappe.get_doc("Zakaah Calculation Run", name)
    doc.calculate_zakaah()
    doc.save()
    return doc

@frappe.whitelist()
def get_journal_entries_for_calculation_run(calculation_run_name):
    """Get Journal Entries that involve Zakaah payment accounts"""
    try:
        # Get the calculation run document
        calc_run = frappe.get_doc("Zakaah Calculation Run", calculation_run_name)
        
        if not calc_run.payment_accounts or len(calc_run.payment_accounts) == 0:
            return []
        
        # Get payment account names
        payment_accounts = [row.account for row in calc_run.payment_accounts if row.account]
        
        if not payment_accounts:
            return []
        
        # Query Journal Entries that have these accounts
        journal_entries = frappe.db.sql("""
            SELECT
                jea.parent as journal_entry,
                je.posting_date,
                jea.account,
                SUM(jea.debit) as debit,
                SUM(jea.credit) as credit,
                je.user_remark as remarks
            FROM `tabJournal Entry Account` jea
            INNER JOIN `tabJournal Entry` je ON jea.parent = je.name
            WHERE je.docstatus = 1
                AND jea.account IN %(accounts)s
                AND je.posting_date BETWEEN %(from_date)s AND %(to_date)s
            GROUP BY jea.parent, je.posting_date, jea.account, je.user_remark
            ORDER BY je.posting_date DESC
        """, {
            'accounts': payment_accounts,
            'from_date': calc_run.from_date,
            'to_date': calc_run.to_date
        }, as_dict=True)
        
        return journal_entries
        
    except Exception as e:
        frappe.log_error(f"Error getting journal entries: {str(e)}", "Journal Entries Error")
        return []

@frappe.whitelist()
def debug_all_config_accounts(company, fiscal_year, to_date):
    """Debug function to check all configured accounts"""
    try:
        config = get_zakaah_assets_config(company, fiscal_year)
        
        results = {
            'cash_accounts': [],
            'inventory_accounts': [],
            'total_cash': 0,
            'total_inventory': 0,
            'dates': {}
        }
        
        # Try to get dates from fiscal year
        if fiscal_year:
            fy_doc = frappe.get_doc("Fiscal Year", fiscal_year)
            results['dates'] = {
                'from': str(fy_doc.year_start_date),
                'to': str(fy_doc.year_end_date)
            }
        
        # Check ALL cash accounts
        for row in config.get('cash_accounts', []):
            account_name = row.get('account') if isinstance(row, dict) else None
            if account_name:
                balance = get_account_balance(account_name, to_date, company)
                results['cash_accounts'].append({
                    'account': account_name,
                    'balance': balance
                })
                results['total_cash'] += balance
        
        # Check ALL inventory accounts
        for row in config.get('inventory_accounts', []):
            account_name = row.get('account') if isinstance(row, dict) else None
            if account_name:
                balance = get_account_balance(account_name, to_date, company)
                results['inventory_accounts'].append({
                    'account': account_name,
                    'balance': balance
                })
                results['total_inventory'] += balance
        
        return results
    except Exception as e:
        return {"error": str(e)}

def get_account_balance(account, date, company=None):
    """Get account balance as of date using ERPNext's get_balance_on.

    This function works for both group accounts and single accounts.
    ERPNext's get_balance_on automatically handles group accounts correctly.
    """
    try:
        from frappe.utils import flt
        from erpnext.accounts.utils import get_balance_on

        # Use ERPNext's built-in function (same as Trial Balance)
        # This automatically handles group accounts by summing all children
        # It respects fiscal year, company, and all ERPNext rules
        balance = get_balance_on(
            account=account,
            date=date,
            company=company
        )

        # For Zakaah calculation, we need positive values representing the asset amount
        # Return absolute value for summation
        balance_value = abs(balance or 0)

        return flt(balance_value)

    except Exception as e:
        frappe.log_error(f"Error getting balance for {account}: {str(e)[:100]}", "Account Balance")
        return 0


