
from __future__ import unicode_literals
from frappe.model.document import Document
import frappe
from frappe import _
from frappe.utils import now

class ZakaahPayments(Document):
	def validate(self):
		# Debug: Log what we have before cleanup
		frappe.log_error(
			f"Before cleanup:\n"
			f"Calculation runs: {len(self.calculation_runs) if self.calculation_runs else 0}\n"
			f"Payment entries: {len(self.payment_entries) if self.payment_entries else 0}\n"
			f"Allocation history: {len(self.allocation_history) if self.allocation_history else 0}",
			"Zakaah Payments Validate Debug"
		)

		# Remove placeholder rows before validation
		self.remove_placeholder_rows()

		# Debug: Log what we have after cleanup
		frappe.log_error(
			f"After cleanup:\n"
			f"Calculation runs: {len(self.calculation_runs) if self.calculation_runs else 0}\n"
			f"Payment entries: {len(self.payment_entries) if self.payment_entries else 0}\n"
			f"Allocation history: {len(self.allocation_history) if self.allocation_history else 0}",
			"Zakaah Payments Validate Debug"
		)

		# Auto-calculate reconciliation status
		self.update_reconciliation_status()

	def remove_placeholder_rows(self):
		"""Remove placeholder rows that have empty journal_entry or zakaah_calculation_run"""
		# Remove empty payment entries (placeholder rows)
		if self.payment_entries:
			valid_entries = []
			for row in self.payment_entries:
				if row.journal_entry and str(row.journal_entry).strip():
					valid_entries.append(row)
			self.payment_entries = valid_entries

		# Remove empty calculation runs (placeholder rows)
		if self.calculation_runs:
			valid_runs = []
			for row in self.calculation_runs:
				if row.zakaah_calculation_run and str(row.zakaah_calculation_run).strip():
					valid_runs.append(row)
			self.calculation_runs = valid_runs

		# Remove empty allocation history (placeholder rows)
		if self.allocation_history:
			valid_history = []
			for row in self.allocation_history:
				if row.journal_entry and str(row.journal_entry).strip():
					valid_history.append(row)
			self.allocation_history = valid_history
	
	def update_reconciliation_status(self):
		"""Update reconciliation status based on allocation"""
		if not self.calculation_runs or len(self.calculation_runs) == 0:
			self.reconciliation_status = "Open"
			self.total_unreconciled = 0
			self.total_reconciled = 0
			return
		
		total_unreconciled = sum([
			(row.outstanding_zakaah or 0) for row in self.calculation_runs
		])
		
		total_all_journal_amount = sum([
			(row.debit or 0) for row in self.payment_entries
		])
		
		total_reconciled = max(0, total_all_journal_amount - total_unreconciled)
		
		self.total_unreconciled = total_unreconciled
		self.total_reconciled = total_reconciled
		
		if total_unreconciled == 0:
			self.reconciliation_status = "Reconciled"
		elif total_unreconciled < total_all_journal_amount:
			self.reconciliation_status = "Partial"
		else:
			self.reconciliation_status = "Open"


@frappe.whitelist()
def get_calculation_runs(company=None, show_unreconciled_only=True):
	"""Get Zakaah Calculation Runs
	By default: only years with outstanding > 0 (like Payment Reconciliation)
	"""
	try:
		if not frappe.db.exists("DocType", "Zakaah Calculation Run"):
			return []
		
		# Base filters
		filters = {}
		if company:
			filters["company"] = company
		if show_unreconciled_only:
			# Use >= 1 to exclude rounding errors (e.g., 0.001750)
			filters["outstanding_zakaah"] = [">=", 1]
		
		# Get calculation runs
		runs = frappe.db.get_all(
			"Zakaah Calculation Run",
			filters=filters,
			fields=[
				"name", 
				"fiscal_year",
				"total_zakaah", 
				"paid_zakaah", 
				"outstanding_zakaah", 
				"status"
			],
			order_by="fiscal_year asc"
		)
		
		# Update outstanding amounts (recalculate from allocation history)
		for run in runs:
			paid_amount = get_total_allocated_for_run(run.name)
			outstanding = (run.total_zakaah or 0) - paid_amount

			# Update if different
			if outstanding != (run.outstanding_zakaah or 0):
				frappe.db.set_value(
					"Zakaah Calculation Run",
					run.name,
					{
						"paid_zakaah": paid_amount,
						"outstanding_zakaah": outstanding
					},
					update_modified=False
				)

				run.paid_zakaah = paid_amount
				run.outstanding_zakaah = outstanding

		# Filter out runs with 0 outstanding after recalculation (if show_unreconciled_only)
		# Use >= 1 to exclude rounding errors (e.g., 0.001750)
		if show_unreconciled_only:
			runs = [run for run in runs if (run.outstanding_zakaah or 0) >= 1]

		return runs
		
	except Exception as e:
		frappe.log_error(f"Error getting calculation runs: {str(e)}", "Get Calculation Runs")
		return []


@frappe.whitelist()
def import_journal_entries(company, from_date, to_date, selected_accounts):
	"""
	Import ONLY UNRECONCILED journal entries
	Exactly like Payment Reconciliation module
	"""
	try:
		# Parse selected_accounts if it's a JSON string
		if isinstance(selected_accounts, str):
			import json
			selected_accounts = json.loads(selected_accounts)

		if not selected_accounts or len(selected_accounts) == 0:
			return {
				"journal_entry_records": [],
				"skipped_count": 0
			}
		
		# 1. Get ALL journal entries from selected accounts
		# IMPORTANT: Get debit from GL Entry (not Journal Entry Account)
		# This aligns with Payment Accounts rule (Debit from GL Entry)

		# Debug: Log parameters before query
		frappe.log_error(
			f"SQL Query Parameters:\n"
			f"Company: {company}\n"
			f"From Date: {from_date}\n"
			f"To Date: {to_date}\n"
			f"Selected Accounts (raw): {selected_accounts}\n"
			f"Accounts type: {type(selected_accounts)}\n"
			f"Accounts tuple: {tuple(selected_accounts) if isinstance(selected_accounts, list) else (selected_accounts,)}",
			"Import Journal Entries SQL Debug"
		)

		# Query 1: Get journal entries within date range
		entries_in_range = frappe.db.sql("""
			SELECT
				je.name as journal_entry,
				je.posting_date,
				je.user_remark as remarks,
				SUM(gle.debit) as debit,
				SUM(gle.credit) as credit
			FROM `tabJournal Entry` je
			INNER JOIN `tabGL Entry` gle ON gle.voucher_no = je.name
			WHERE je.company = %(company)s
			AND je.posting_date BETWEEN %(from_date)s AND %(to_date)s
			AND gle.account IN %(accounts)s
			AND je.docstatus = 1
			AND gle.is_cancelled = 0
			GROUP BY je.name, je.posting_date, je.user_remark
			ORDER BY je.posting_date, je.name
		""", {
			'company': company,
			'from_date': from_date,
			'to_date': to_date,
			'accounts': tuple(selected_accounts) if isinstance(selected_accounts, list) else (selected_accounts,)
		}, as_dict=True)

		# Query 2: Get ALL journal entries with CURRENT unallocated amounts (regardless of date)
		# This ensures we show journal entries that still have unallocated amounts from previous periods
		# FIXED: Calculate current unallocated by comparing total debit vs sum of allocations
		entries_with_unallocated = frappe.db.sql("""
			SELECT
				je.name as journal_entry,
				je.posting_date,
				je.user_remark as remarks,
				SUM(gle.debit) as debit,
				SUM(gle.credit) as credit,
				COALESCE(alloc.total_allocated, 0) as already_allocated,
				SUM(gle.debit) - COALESCE(alloc.total_allocated, 0) as current_unallocated
			FROM `tabJournal Entry` je
			INNER JOIN `tabGL Entry` gle ON gle.voucher_no = je.name
			LEFT JOIN (
				SELECT journal_entry, SUM(allocated_amount) as total_allocated
				FROM `tabZakaah Allocation History`
				WHERE docstatus = 1
				GROUP BY journal_entry
			) alloc ON alloc.journal_entry = je.name
			WHERE je.company = %(company)s
			AND gle.account IN %(accounts)s
			AND je.docstatus = 1
			AND gle.is_cancelled = 0
			GROUP BY je.name, je.posting_date, je.user_remark
			HAVING current_unallocated > 0
			ORDER BY je.posting_date, je.name
		""", {
			'company': company,
			'accounts': tuple(selected_accounts) if isinstance(selected_accounts, list) else (selected_accounts,)
		}, as_dict=True)

		# Combine both result sets and remove duplicates
		all_entries_dict = {}
		for entry in entries_in_range:
			all_entries_dict[entry.journal_entry] = entry
		for entry in entries_with_unallocated:
			if entry.journal_entry not in all_entries_dict:
				all_entries_dict[entry.journal_entry] = entry

		# Convert back to list and sort by posting date
		all_entries = sorted(all_entries_dict.values(), key=lambda x: (x.posting_date, x.journal_entry))
		
		# 2. Get already allocated amounts from Allocation History
		already_allocated = frappe.db.sql("""
			SELECT 
				journal_entry,
				SUM(allocated_amount) as total_allocated
			FROM `tabZakaah Allocation History`
			WHERE docstatus != 2
			GROUP BY journal_entry
		""", as_dict=True)
		
		# Create dictionary for quick lookup
		allocated_dict = {
			row.journal_entry: row.total_allocated 
			for row in already_allocated
		}
		
		# 3. Filter: Only unreconciled (unallocated > 0)
		journal_entry_records = []
		skipped_count = 0
		
		for entry in all_entries:
			entry_name = entry.journal_entry
			debit_amount = entry.debit or 0
			
			# Get total allocated for this JE
			total_allocated = allocated_dict.get(entry_name, 0)
			
			# Calculate unallocated amount
			unallocated = debit_amount - total_allocated
			
			# Only add if there's unallocated amount
			if unallocated > 0:
				journal_entry_records.append({
					"journal_entry": entry_name,
					"posting_date": str(entry.posting_date),
					"debit": debit_amount,
					"credit": entry.credit or 0,
					"balance": debit_amount,
					"remarks": entry.remarks or "",
					"allocated_amount": total_allocated,
					"unallocated_amount": unallocated
				})
			else:
				skipped_count += 1
		
		# Debug: Log what we're returning
		debug_msg = f"Journal Entries Found: {len(journal_entry_records)}\n"
		debug_msg += f"All Entries: {len(all_entries)}\n"
		debug_msg += f"Skipped: {skipped_count}\n"
		debug_msg += f"Accounts: {selected_accounts}\n"
		debug_msg += f"Date Range: {from_date} to {to_date}\n\n"

		if len(all_entries) > 0:
			debug_msg += "Sample entries from SQL query:\n"
			for entry in all_entries[:3]:
				total_allocated = allocated_dict.get(entry.journal_entry, 0)
				unallocated = (entry.debit or 0) - total_allocated
				debug_msg += f"  - {entry.journal_entry}: debit={entry.debit}, allocated={total_allocated}, unallocated={unallocated}\n"

		frappe.log_error(debug_msg, "Import Journal Entries Debug")

		# Return result without showing message (let JS handle it)
		return {
			"journal_entry_records": journal_entry_records,
			"skipped_count": skipped_count
		}
		
	except Exception as e:
		frappe.log_error(f"Error importing journal entries: {str(e)}", "Import Journal Entries")
		return {"journal_entry_records": []}


@frappe.whitelist()
def allocate_payments(calculation_run_items, journal_entries):
	"""
	Allocate journal entries to Zakaah Calculation Runs
	Updates outstanding amounts after allocation
	"""
	try:
		# Parse parameters if they're JSON strings
		import json
		if isinstance(calculation_run_items, str):
			calculation_run_items = json.loads(calculation_run_items)
		if isinstance(journal_entries, str):
			journal_entries = json.loads(journal_entries)

		if not frappe.db.exists("DocType", "Zakaah Allocation History"):
			return {"success": False, "message": "Zakaah Allocation History doctype not found"}

		allocated_records = []
		allocation_summary = []

		# Get already allocated amounts from database
		already_allocated = frappe.db.sql("""
			SELECT
				journal_entry,
				SUM(allocated_amount) as total_allocated
			FROM `tabZakaah Allocation History`
			WHERE docstatus != 2
			GROUP BY journal_entry
		""", as_dict=True)

		# Create dictionary for quick lookup
		allocated_dict = {
			row.journal_entry: row.total_allocated
			for row in already_allocated
		}

		# Process each journal entry
		for journal_entry in journal_entries:
			journal_entry_name = journal_entry.get("journal_entry")
			unallocated_amount = journal_entry.get("unallocated_amount") or 0
			original_debit = journal_entry.get("debit") or 0
			
			# Track how much is being allocated in this session
			remaining_to_allocate = unallocated_amount
			
			for run_item in calculation_run_items:
				run_name = run_item.get("zakaah_calculation_run")
				if not run_name:
					continue

				# CRITICAL: Get CURRENT outstanding from database (not from stale run_item)
				# This prevents over-allocation if user clicks Allocate multiple times
				current_data = frappe.db.get_value(
					"Zakaah Calculation Run",
					run_name,
					["total_zakaah", "paid_zakaah", "outstanding_zakaah"],
					as_dict=True
				)

				if not current_data:
					continue

				current_outstanding = current_data.outstanding_zakaah or 0
				total_zakaah = current_data.total_zakaah or 0
				current_paid = current_data.paid_zakaah or 0

				# Skip if already fully paid
				if current_outstanding <= 0:
					continue

				if remaining_to_allocate <= 0:
					break

				# Calculate allocation amount (minimum of remaining to allocate and current outstanding)
				allocation_amount = min(remaining_to_allocate, current_outstanding)

				# VALIDATION: Ensure allocation won't exceed total zakaah
				new_paid = current_paid + allocation_amount
				if new_paid > total_zakaah:
					# Adjust allocation to not exceed total
					allocation_amount = max(0, total_zakaah - current_paid)
					frappe.log_error(
						f"Prevented over-allocation for {run_name}\n"
						f"Total Zakaah: {total_zakaah}\n"
						f"Current Paid: {current_paid}\n"
						f"Attempted: {allocation_amount + (new_paid - total_zakaah)}\n"
						f"Adjusted to: {allocation_amount}",
						"Allocation Over-limit Prevention"
					)

				if allocation_amount > 0:
					# Calculate remaining unallocated after this allocation
					# Include BOTH: allocations from this session AND previous allocations from database
					current_session_allocated = sum([
						r.get("allocated_amount", 0)
						for r in allocated_records
						if r.get("journal_entry") == journal_entry_name
					])

					# Get total allocated from database (including previous sessions)
					previous_allocated = allocated_dict.get(journal_entry_name, 0)

					# Total allocated = previous + current session + this allocation
					total_allocated = previous_allocated + current_session_allocated + allocation_amount
					new_unallocated = original_debit - total_allocated
					
					# Create allocation history record
					allocation_doc = frappe.get_doc({
						"doctype": "Zakaah Allocation History",
						"journal_entry": journal_entry_name,
						"zakaah_calculation_run": run_name,
						"allocated_amount": allocation_amount,
						"unallocated_amount": new_unallocated,
						"allocation_date": now(),
						"allocated_by": frappe.session.user
					})
					allocation_doc.insert()
					allocation_doc.submit()

					allocated_records.append({
						"journal_entry": journal_entry_name,
						"zakaah_calculation_run": run_name,
						"allocated_amount": allocation_amount
					})
					
					remaining_to_allocate -= allocation_amount
			
			if remaining_to_allocate > 0:
				allocation_summary.append({
					"journal_entry": journal_entry_name,
					"still_unallocated": remaining_to_allocate
				})
		
		# Update outstanding amounts in Calculation Runs
		for run_item in calculation_run_items:
			run_name = run_item.get("zakaah_calculation_run")
			if run_name:
				total_zakaah = frappe.db.get_value("Zakaah Calculation Run", run_name, "total_zakaah")
				
				# Recalculate paid amount
				paid_amount = get_total_allocated_for_run(run_name)
				outstanding = max(0, (total_zakaah or 0) - paid_amount)
				
				# Determine status
				if outstanding == 0:
					status = "Paid"
				elif paid_amount > 0:
					status = "Partially Paid"
				else:
					status = "Calculated"
				
				# Update Calculation Run
				frappe.db.set_value("Zakaah Calculation Run", run_name, {
					"paid_zakaah": paid_amount,
					"outstanding_zakaah": outstanding,
					"status": status
				}, update_modified=False)
		
		frappe.db.commit()
		
		return {
			"success": True,
			"allocated_records": allocated_records,
			"summary": allocation_summary
		}
		
	except Exception as e:
		frappe.log_error(f"Error allocating payments: {str(e)}", "Allocate Payments")
		frappe.db.rollback()
		return {"success": False, "message": str(e)}


@frappe.whitelist()
def get_allocation_history(calculation_run=None, journal_entry=None):
	"""Get allocation history records with CURRENT unallocated amounts (not historical snapshots)"""
	try:
		filters = {"docstatus": ["!=", 2]}

		if calculation_run:
			filters["zakaah_calculation_run"] = calculation_run

		if journal_entry:
			filters["journal_entry"] = journal_entry

		history = frappe.db.get_all(
			"Zakaah Allocation History",
			filters=filters,
			fields=[
				"name",
				"journal_entry",
				"zakaah_calculation_run",
				"allocated_amount",
				"unallocated_amount",  # Historical value - will be replaced with current
				"allocation_date",
				"allocated_by"
			],
			order_by="allocation_date desc, name desc"
		)

		# FIXED: Recalculate CURRENT unallocated amount for each journal entry
		# Get current unallocated amounts for all journal entries
		# IMPORTANT: Only count debits from Zakaa Liability account (payment account)
		je_unallocated = {}
		if history:
			unique_jes = list(set([h["journal_entry"] for h in history]))

			# Get the Zakaa Liability payment account (the account used for zakaah payments)
			# This is typically "2205001 - Zakaa Liability - AP" or similar
			# We'll query GL Entry filtered by the payment account to get accurate amounts
			current_unallocated = frappe.db.sql("""
				SELECT
					gle.voucher_no as journal_entry,
					SUM(gle.debit) as total_debit,
					COALESCE(alloc.total_allocated, 0) as total_allocated,
					SUM(gle.debit) - COALESCE(alloc.total_allocated, 0) as current_unallocated
				FROM `tabGL Entry` gle
				LEFT JOIN (
					SELECT journal_entry, SUM(allocated_amount) as total_allocated
					FROM `tabZakaah Allocation History`
					WHERE docstatus = 1
					GROUP BY journal_entry
				) alloc ON alloc.journal_entry = gle.voucher_no
				WHERE gle.voucher_no IN %(je_list)s
				AND gle.account LIKE '%%Zakaa Liability%%'
				AND gle.is_cancelled = 0
				GROUP BY gle.voucher_no
			""", {"je_list": unique_jes}, as_dict=True)

			# Build lookup dict
			for row in current_unallocated:
				je_unallocated[row.journal_entry] = row.current_unallocated

		# Replace historical unallocated_amount with current value
		for record in history:
			je_name = record["journal_entry"]
			record["unallocated_amount"] = je_unallocated.get(je_name, 0)

		return history

	except Exception as e:
		frappe.log_error(f"Error getting allocation history: {str(e)}", "Get Allocation History")
		return []


def get_total_allocated_for_run(calculation_run_name):
	"""Get total allocated amount for a calculation run"""
	try:
		result = frappe.db.sql("""
			SELECT SUM(allocated_amount) as total
			FROM `tabZakaah Allocation History`
			WHERE zakaah_calculation_run = %s
			AND docstatus != 2
		""", calculation_run_name, as_dict=True)
		
		return (result[0].total or 0) if result and result[0] else 0
	except Exception as e:
		frappe.log_error(f"Error getting total allocated: {str(e)}", "Get Total Allocated")
		return 0


@frappe.whitelist()
def get_payment_accounts_from_settings(company):
	"""Get payment accounts from ALL Zakaah Assets Configurations for the company"""
	try:
		# Get payment accounts from Zakaah Assets Configuration
		if not frappe.db.exists("DocType", "Zakaah Assets Configuration"):
			return []

		if not company:
			return []

		# Find ALL assets configurations for this company (all fiscal years)
		config_names = frappe.db.get_all(
			"Zakaah Assets Configuration",
			filters={"company": company},
			pluck="name"
		)

		if not config_names:
			return []

		# Collect all unique payment accounts from all fiscal years
		accounts_dict = {}  # Use dict to avoid duplicates

		for config_name in config_names:
			config_doc = frappe.get_doc("Zakaah Assets Configuration", config_name)

			if config_doc and hasattr(config_doc, 'payment_accounts') and config_doc.payment_accounts:
				for row in config_doc.payment_accounts:
					if row.account and row.account not in accounts_dict:
						accounts_dict[row.account] = {
							"account": row.account,
							"account_name": row.account_name or frappe.db.get_value("Account", row.account, "account_name")
						}

		# Return list of accounts
		return list(accounts_dict.values())
		
	except Exception as e:
		frappe.log_error(f"Error getting payment accounts: {str(e)}", "Get Payment Accounts")
		return []

