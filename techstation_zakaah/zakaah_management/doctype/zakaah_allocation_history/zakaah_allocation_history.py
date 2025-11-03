
from __future__ import unicode_literals
from frappe.model.document import Document
import frappe
from frappe import _
from frappe.utils import flt

class ZakaahAllocationHistory(Document):
	def before_insert(self):
		# Set allocated_by to current user
		if not self.allocated_by:
			self.allocated_by = frappe.session.user

	def validate(self):
		"""Validate allocation before saving"""
		self.validate_amounts()
		self.validate_references()
		self.check_over_allocation()

	def validate_amounts(self):
		"""Validate that amounts are positive"""
		if flt(self.allocated_amount) <= 0:
			frappe.throw(_("Allocated Amount must be greater than zero"))

		if flt(self.unallocated_amount) < 0:
			frappe.throw(_("Unallocated Amount cannot be negative"))

	def validate_references(self):
		"""Validate that referenced documents exist"""
		if self.journal_entry:
			if not frappe.db.exists("Journal Entry", self.journal_entry):
				frappe.throw(_("Journal Entry {0} does not exist").format(self.journal_entry))

		if self.zakaah_calculation_run:
			if not frappe.db.exists("Zakaah Calculation Run", self.zakaah_calculation_run):
				frappe.throw(_("Zakaah Calculation Run {0} does not exist").format(self.zakaah_calculation_run))

	def check_over_allocation(self):
		"""Prevent allocating more than the journal entry amount"""
		if not self.journal_entry:
			return

		# Get total journal entry amount from GL Entry
		je_amount = frappe.db.sql("""
			SELECT SUM(debit) as total_debit
			FROM `tabJournal Entry Account` jea
			WHERE jea.parent = %s
		""", self.journal_entry, as_dict=True)

		total_je_amount = je_amount[0].total_debit if je_amount and je_amount[0].total_debit else 0

		# Get total already allocated (excluding this record if updating)
		allocated_query = """
			SELECT SUM(allocated_amount) as total_allocated
			FROM `tabZakaah Allocation History`
			WHERE journal_entry = %s
			AND docstatus != 2
		"""

		params = [self.journal_entry]
		if not self.is_new():
			allocated_query += " AND name != %s"
			params.append(self.name)

		already_allocated = frappe.db.sql(allocated_query, params, as_dict=True)
		total_allocated = already_allocated[0].total_allocated if already_allocated and already_allocated[0].total_allocated else 0

		# Check if new allocation would exceed journal entry amount
		if flt(total_allocated) + flt(self.allocated_amount) > flt(total_je_amount):
			frappe.throw(_(
				"Total allocated amount ({0}) would exceed Journal Entry amount ({1}). "
				"Already allocated: {2}, Trying to allocate: {3}"
			).format(
				flt(total_allocated) + flt(self.allocated_amount),
				total_je_amount,
				total_allocated,
				self.allocated_amount
			))

	def on_submit(self):
		"""Update calculation run outstanding amount when submitted"""
		self.update_calculation_run_status()

	def on_cancel(self):
		"""Reverse calculation run updates when cancelled"""
		self.update_calculation_run_status(reverse=True)

	def update_calculation_run_status(self, reverse=False):
		"""Update the Zakaah Calculation Run's paid and outstanding amounts"""
		if not self.zakaah_calculation_run:
			return

		try:
			calc_run = frappe.get_doc("Zakaah Calculation Run", self.zakaah_calculation_run)

			# Get total allocated for this calculation run
			total_allocated = frappe.db.sql("""
				SELECT SUM(allocated_amount) as total
				FROM `tabZakaah Allocation History`
				WHERE zakaah_calculation_run = %s
				AND docstatus = 1
			""", self.zakaah_calculation_run, as_dict=True)

			total_paid = total_allocated[0].total if total_allocated and total_allocated[0].total else 0

			# Update calculation run
			calc_run.db_set('paid_zakaah', total_paid)
			calc_run.db_set('outstanding_zakaah', flt(calc_run.total_zakaah) - flt(total_paid))

			# Update status
			if flt(calc_run.outstanding_zakaah) <= 0:
				calc_run.db_set('status', 'Paid')
			elif flt(calc_run.paid_zakaah) > 0:
				calc_run.db_set('status', 'Partially Paid')
			else:
				calc_run.db_set('status', 'Calculated')

		except Exception as e:
			frappe.log_error(f"Error updating calculation run status: {str(e)}", "Allocation History Update Error")


@frappe.whitelist()
def get_journal_entry_unallocated(journal_entry, exclude_allocation=None):
	"""Get unallocated amount for a journal entry"""
	from frappe.utils import flt

	# Get total journal entry amount
	je_amount = frappe.db.sql("""
		SELECT SUM(debit) as total_debit
		FROM `tabJournal Entry Account`
		WHERE parent = %s
	""", journal_entry, as_dict=True)

	total_amount = flt(je_amount[0].total_debit) if je_amount and je_amount[0].total_debit else 0

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
	already_allocated = flt(allocated[0].total_allocated) if allocated and allocated[0].total_allocated else 0

	return {
		'total_amount': total_amount,
		'already_allocated': already_allocated,
		'unallocated': flt(total_amount) - flt(already_allocated)
	}



