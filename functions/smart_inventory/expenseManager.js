'use strict';

const CONNECTION_NAMES = ['expense', 'Expense'];
const EXPENSE_DOMAINS = [
	'https://www.zohoapis.in/expense/v1',
	'https://www.zohoapis.com/expense/v1',
	'https://expense.zoho.in/api/v1',
	'https://expense.zoho.com/api/v1'
];

function toZohoApisBaseUrl(domain) {
	if (!domain || typeof domain !== 'string') return 'https://www.zohoapis.in/expense/v1';
	if (domain.includes('.in')) return 'https://www.zohoapis.in/expense/v1';
	if (domain.includes('.eu')) return 'https://www.zohoapis.eu/expense/v1';
	if (domain.includes('.com.au')) return 'https://www.zohoapis.com.au/expense/v1';
	return 'https://www.zohoapis.com/expense/v1';
}

let cachedOrgId = process.env.EXPENSE_ORG_ID || null;
let cachedBaseUrl = process.env.EXPENSE_BASE_URL || 'https://www.zohoapis.in/expense/v1';
let cachedCurrencyId = process.env.EXPENSE_CURRENCY_ID || '4190897000000000064';
let cachedCurrencyCode = process.env.EXPENSE_CURRENCY_CODE || 'INR';
let cachedDefaultCategoryId = '4190897000000034311';

/**
 * Retrieves valid authentication headers from the Catalyst Connection
 */
async function getConnectionHeaders(catalystApp) {
	let lastError = null;
	for (const connName of CONNECTION_NAMES) {
		try {
			const connCreds = await catalystApp.connections().getConnectionCredentials(connName);
			if (connCreds && connCreds.headers) {
				return connCreds.headers;
			}
		} catch (err) {
			lastError = err;
		}
	}
	throw new Error(`Failed to retrieve credentials for connection 'expense'/'Expense': ${lastError ? lastError.message : 'Unknown error'}`);
}

/**
 * Retrieves organizations associated with the Zoho Expense connection
 */
async function getOrganizations(catalystApp) {
	const headers = await getConnectionHeaders(catalystApp);

	for (const domain of EXPENSE_DOMAINS) {
		try {
			const response = await fetch(`${domain}/organizations`, {
				method: 'GET',
				headers: {
					...headers,
					'Content-Type': 'application/json'
				}
			});

			if (!response.ok) {
				continue;
			}

			const data = await response.json();
			if (data && data.code === 0 && Array.isArray(data.organizations) && data.organizations.length > 0) {
				const primaryOrg = data.organizations[0];
				cachedBaseUrl = toZohoApisBaseUrl(domain);
				if (!cachedOrgId) {
					cachedOrgId = primaryOrg.organization_id;
				}
				if (primaryOrg.currency_id) {
					cachedCurrencyId = primaryOrg.currency_id;
				}
				if (primaryOrg.currency_code) {
					cachedCurrencyCode = primaryOrg.currency_code;
				}
				return {
					ok: true,
					organizations: data.organizations,
					baseUrl: cachedBaseUrl,
					currency_id: cachedCurrencyId,
					currency_code: cachedCurrencyCode
				};
			}
		} catch (err) {
			console.warn(`Error probing domain ${domain}:`, err.message);
		}
	}

	return { ok: true, organizations: [], baseUrl: cachedBaseUrl };
}

/**
 * Resolves the active organization ID
 */
async function resolveOrganizationId(catalystApp, explicitOrgId) {
	if (explicitOrgId) return explicitOrgId;
	if (cachedOrgId) return cachedOrgId;

	const orgResult = await getOrganizations(catalystApp);
	if (orgResult.organizations && orgResult.organizations.length > 0) {
		cachedOrgId = orgResult.organizations[0].organization_id;
		return cachedOrgId;
	}

	return null;
}

/**
 * Lists expenses from Zoho Expense
 */
async function listExpenses(catalystApp, options = {}) {
	const headers = await getConnectionHeaders(catalystApp);
	const orgId = await resolveOrganizationId(catalystApp, options.organizationId);

	if (!orgId) {
		return {
			error: 'No Zoho Expense Organization ID found. Please specify organizationId or ensure an organization exists in Zoho Expense.',
			status: 400
		};
	}

	const queryParams = new URLSearchParams();
	if (options.page) queryParams.append('page', String(options.page));
	if (options.per_page) queryParams.append('per_page', String(options.per_page));
	if (options.status) queryParams.append('status', options.status);
	if (options.category_id) queryParams.append('category_id', options.category_id);
	if (options.date_start) queryParams.append('date_start', options.date_start);
	if (options.date_end) queryParams.append('date_end', options.date_end);

	const url = `${cachedBaseUrl}/expenses${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
	const response = await fetch(url, {
		method: 'GET',
		headers: {
			...headers,
			'X-com-zoho-expense-organizationid': String(orgId),
			'Content-Type': 'application/json'
		}
	});

	const data = await response.json();
	if (!response.ok || data.code !== 0) {
		return {
			error: data.message || `Failed to fetch expenses: HTTP ${response.status}`,
			status: response.status || 500,
			details: data
		};
	}

	const liveExpenses = data.expenses || [];

	// Automatically reconcile Data Store 'Expenses' table with live Zoho Expense state:
	// When expenses are deleted in Zoho Expense, remove the matching orphaned records from Data Store.
	// When expenses are added in Zoho Expense, ensure they are mirrored in Data Store.
	if (!options.category_id && !options.status && !options.date_start && !options.date_end) {
		await reconcileDataStoreWithLiveExpenses(catalystApp, orgId, liveExpenses);
	}

	return {
		ok: true,
		expenses: liveExpenses,
		page_context: data.page_context,
		organization_id: orgId
	};
}

/**
 * Reconciles Catalyst Data Store 'Expenses' table with live Zoho Expense state
 */
async function reconcileDataStoreWithLiveExpenses(catalystApp, orgId, liveExpenses) {
	try {
		const liveExpenseIds = new Set((liveExpenses || []).map((e) => String(e.expense_id || '')));
		const dsRows = await catalystApp.zcql().executeZCQLQuery('SELECT ROWID, expense_id FROM Expenses');
		const dsList = (dsRows || []).map((r) => r.Expenses || r);

		// 1. Delete orphaned rows from Data Store (expenses deleted in Zoho Expense)
		const orphaned = dsList.filter((item) => {
			return item.expense_id && !liveExpenseIds.has(String(item.expense_id));
		});

		if (orphaned.length > 0) {
			const table = catalystApp.datastore().table('Expenses');
			for (const row of orphaned) {
				try {
					await table.deleteRow(row.ROWID);
				} catch (_) {}
			}
			console.log(`Reconciled: Purged ${orphaned.length} deleted expenses from Catalyst Data Store.`);
		}

		// 2. Backfill any live Zoho Expense that is missing from Data Store
		const dsExpenseIds = new Set(dsList.map((item) => String(item.expense_id || '')));
		const missing = (liveExpenses || []).filter((e) => e.expense_id && !dsExpenseIds.has(String(e.expense_id)));
		if (missing.length > 0) {
			const table = catalystApp.datastore().table('Expenses');
			for (const exp of missing) {
				try {
					await table.insertRow({
						expense_id: String(exp.expense_id),
						expense_date: exp.date || exp.expense_date || new Date().toISOString().slice(0, 10),
						amount: Number(exp.amount || exp.total || exp.bcy_total || 0),
						merchant_name: String(exp.merchant_name || exp.description || 'Expense'),
						category_name: String(exp.category_name || ''),
						category_id: String(exp.category_id || ''),
						currency_code: String(exp.currency_code || 'INR'),
						currency_id: String(exp.currency_id || cachedCurrencyId || ''),
						status: String(exp.status || 'unreported'),
						description: String(exp.description || ''),
						paid_through_account_name: String(exp.paid_through_account_name || 'Petty Cash'),
						payment_mode: String(exp.payment_mode || 'Cash'),
						reference_number: String(exp.reference_number || ''),
						user_name: String(exp.user_name || ''),
						user_email: String(exp.user_email || ''),
						report_name: String(exp.report_name || ''),
						report_id: String(exp.report_id || '')
					});
				} catch (insErr) {
					console.warn('Failed to backfill expense into Data Store:', insErr.message);
				}
			}
			console.log(`Reconciled: Backfilled ${missing.length} expenses into Catalyst Data Store.`);
		}
	} catch (syncErr) {
		console.warn('Data Store reconciliation skipped:', syncErr.message);
	}
}

/**
 * Retrieves aggregate summary metrics of expenses
 */
async function getExpenseSummary(catalystApp, options = {}) {
	const listResult = await listExpenses(catalystApp, { ...options, per_page: 200 });
	if (listResult.error) return listResult;

	const expenses = listResult.expenses || [];
	let totalAmount = 0;
	const categoryBreakdown = {};
	const statusBreakdown = {};

	for (const exp of expenses) {
		const amt = Number(exp.bcy_total || exp.amount || 0);
		totalAmount += amt;

		const cat = exp.category_name || 'Uncategorized';
		categoryBreakdown[cat] = (categoryBreakdown[cat] || 0) + amt;

		const stat = exp.status || 'unreported';
		statusBreakdown[stat] = (statusBreakdown[stat] || 0) + 1;
	}

	return {
		ok: true,
		summary: {
			totalExpensesCount: expenses.length,
			totalAmount: Number(totalAmount.toFixed(2)),
			currency: expenses[0]?.currency_code || cachedCurrencyCode || 'INR',
			currency_id: expenses[0]?.currency_id || cachedCurrencyId || '4190897000000000064',
			categoryBreakdown,
			statusBreakdown,
			recentExpenses: expenses.slice(0, 10)
		},
		organization_id: listResult.organization_id
	};
}

/**
 * Creates a new expense in Zoho Expense (e.g. from restock or inventory purchase)
 */
async function createExpense(catalystApp, expensePayload, explicitOrgId) {
	const headers = await getConnectionHeaders(catalystApp);
	const orgId = await resolveOrganizationId(catalystApp, explicitOrgId);

	if (!orgId) {
		return {
			error: 'No Zoho Expense Organization ID found to create expense.',
			status: 400
		};
	}

	// 1. Resolve currency ID
	let currencyId = expensePayload.currency_id || cachedCurrencyId;
	if (!currencyId) {
		await getOrganizations(catalystApp);
		currencyId = cachedCurrencyId || '4190897000000000064';
	}

	// Support both direct expense inputs and Zoho Books/Inventory Bill webhooks
	const amount = Number(expensePayload.amount ?? expensePayload.total_amount ?? expensePayload.total ?? 0);
	const date = expensePayload.date || expensePayload.bill_date || expensePayload.expense_date || new Date().toISOString().slice(0, 10);
	const merchantName = (expensePayload.merchant_name || expensePayload.vendor_name || expensePayload.merchant || 'Inventory Supplier').trim();
	const referenceNumber = String(expensePayload.reference_number || expensePayload.bill_number || expensePayload.bill_id || '').trim();

	let description = (expensePayload.description || expensePayload.notes || '').trim();
	if (!description && expensePayload.bill_number) {
		description = `Bill #${expensePayload.bill_number} from ${merchantName}`;
	}
	if (!description && Array.isArray(expensePayload.expenses) && expensePayload.expenses.length > 0) {
		description = expensePayload.expenses.map(e => e.description || e.account_name).filter(Boolean).join(', ');
	}
	if (!description) {
		description = `Inventory Purchase - ${merchantName}`;
	}

	// 2. Resolve category ID
	let categoryId = expensePayload.category_id;
	if (!categoryId) {
		try {
			const catRes = await listCategories(catalystApp, orgId);
			if (catRes.expense_categories && catRes.expense_categories.length > 0) {
				categoryId = catRes.expense_categories[0].category_id;
			}
		} catch (_) {}
	}
	if (!categoryId) {
		categoryId = cachedDefaultCategoryId;
	}

	// 3. Build line items (supporting bill line items if passed)
	const rawLineItems = Array.isArray(expensePayload.expenses) && expensePayload.expenses.length > 0
		? expensePayload.expenses
		: (Array.isArray(expensePayload.line_items) ? expensePayload.line_items : null);

	const formattedLineItems = rawLineItems && rawLineItems.length > 0
		? rawLineItems.map(item => ({
			amount: Number(item.amount ?? item.item_total ?? (amount / rawLineItems.length)),
			category_id: categoryId,
			description: String(item.description || item.account_name || description)
		}))
		: [
			{
				amount: amount,
				category_id: categoryId,
				description: description || `Inventory item: ${merchantName}`
			}
		];

	// 4. Build payload according to Zoho Expense API requirements
	const zohoPayload = {
		currency_id: String(currencyId),
		date: date,
		merchant_name: merchantName,
		payment_mode: expensePayload.payment_mode || 'Cash',
		line_items: formattedLineItems
	};
	if (referenceNumber) {
		zohoPayload.reference_number = referenceNumber;
	}

	const url = `${cachedBaseUrl}/expenses`;
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			...headers,
			'X-com-zoho-expense-organizationid': String(orgId),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(zohoPayload)
	});

	const data = await response.json();
	console.log('Zoho POST /expenses returned:', JSON.stringify(data));
	if (!response.ok || data.code !== 0) {
		return {
			error: data.message || `Failed to create expense: HTTP ${response.status}`,
			status: response.status || 500,
			details: data
		};
	}

	const exp = data.expense || (Array.isArray(data.expenses) ? data.expenses[0] : null) || {};

	// Mirror newly created expense into Catalyst Data Store 'Expenses' table
	try {
		const table = catalystApp.datastore().table('Expenses');
		const rowToInsert = {
			expense_id: String(exp.expense_id || ('exp_' + Date.now())),
			expense_date: exp.date || date,
			amount: Number(exp.amount || exp.total || amount || 0),
			merchant_name: String(exp.merchant_name || merchantName || ''),
			category_name: String(exp.category_name || ''),
			category_id: String(exp.category_id || categoryId || ''),
			currency_code: String(exp.currency_code || 'INR'),
			currency_id: String(exp.currency_id || currencyId || ''),
			status: String(exp.status || 'unreported'),
			description: String(exp.description || description || ''),
			paid_through_account_name: String(exp.paid_through_account_name || expensePayload.paid_through_account_name || 'Petty Cash'),
			payment_mode: String(exp.payment_mode || expensePayload.payment_mode || 'Cash'),
			reference_number: String(exp.reference_number || expensePayload.reference_number || ''),
			user_name: String(exp.user_name || expensePayload.user_name || ''),
			user_email: String(exp.user_email || expensePayload.user_email || ''),
			report_name: String(exp.report_name || ''),
			report_id: String(exp.report_id || '')
		};
		const insertedRow = await table.insertRow(rowToInsert);
		console.log('Successfully mirrored expense to Data Store:', insertedRow.ROWID);
	} catch (dbErr) {
		console.error('Could not mirror expense into Catalyst Data Store Expenses table:', dbErr.message);
	}

	return {
		ok: true,
		expense: exp,
		message: 'Expense created successfully'
	};
}

/**
 * Lists expenses persisted in the Catalyst Data Store 'Expenses' table
 */
async function listExpensesFromDataStore(catalystApp) {
	try {
		const query = 'SELECT ROWID, CREATEDTIME, expense_id, expense_date, amount, merchant_name, category_name, category_id, currency_code, currency_id, status, description, paid_through_account_name, payment_mode, reference_number, user_name, user_email, report_name, report_id FROM Expenses ORDER BY CREATEDTIME DESC';
		const zcqlResult = await catalystApp.zcql().executeZCQLQuery(query);
		const rows = (zcqlResult || []).map(r => r.Expenses || r);
		return {
			ok: true,
			expenses: rows,
			count: rows.length
		};
	} catch (err) {
		console.warn('Failed to query Expenses from Catalyst Data Store:', err.message);
		return {
			ok: false,
			error: err.message,
			expenses: []
		};
	}
}

/**
 * Retrieves expense categories
 */
async function listCategories(catalystApp, explicitOrgId) {
	const headers = await getConnectionHeaders(catalystApp);
	const orgId = await resolveOrganizationId(catalystApp, explicitOrgId);

	if (!orgId) {
		return {
			error: 'No Zoho Expense Organization ID found.',
			status: 400
		};
	}

	const url = `${cachedBaseUrl}/expensecategories`;
	const response = await fetch(url, {
		method: 'GET',
		headers: {
			...headers,
			'X-com-zoho-expense-organizationid': String(orgId),
			'Content-Type': 'application/json'
		}
	});

	const data = await response.json();
	if (!response.ok || data.code !== 0) {
		return {
			error: data.message || `Failed to list categories: HTTP ${response.status}`,
			status: response.status || 500
		};
	}

	return {
		ok: true,
		expense_categories: data.expense_categories || []
	};
}

/**
 * Deletes an expense from both Zoho Expense and the Catalyst Data Store
 * Accepts either a Zoho Expense ID (e.g. '4190897000000038027') or Catalyst Data Store ROWID
 */
async function deleteExpense(catalystApp, identifier, explicitOrgId) {
	const cleanId = String(identifier || '').replace(/['"\\]/g, '').trim();
	if (!cleanId) {
		return { ok: false, error: 'Identifier (expense_id or ROWID) is required for deletion.', status: 400 };
	}

	let zohoExpenseId = cleanId;
	let dsRowId = null;

	// Check if cleanId matches a ROWID or an expense_id in Catalyst Data Store
	try {
		const zcqlRes = await catalystApp.zcql().executeZCQLQuery(
			`SELECT ROWID, expense_id FROM Expenses WHERE ROWID = '${cleanId}' OR expense_id = '${cleanId}'`
		);
		const rows = (zcqlRes || []).map((r) => r.Expenses || r);
		if (rows.length > 0) {
			dsRowId = rows[0].ROWID;
			if (rows[0].expense_id) {
				zohoExpenseId = rows[0].expense_id;
			}
		}
	} catch (zcqlErr) {
		console.warn('Data Store lookup before delete warning:', zcqlErr.message);
	}

	// 1. Delete from Zoho Expense if valid Zoho Expense ID (skip temporary exp_ prefixes)
	let zohoSuccess = false;
	let zohoError = null;
	const orgId = await resolveOrganizationId(catalystApp, explicitOrgId);

	if (orgId && zohoExpenseId && !zohoExpenseId.startsWith('exp_')) {
		try {
			const headers = await getConnectionHeaders(catalystApp);
			const url = `${cachedBaseUrl}/expenses/${encodeURIComponent(zohoExpenseId)}`;
			const response = await fetch(url, {
				method: 'DELETE',
				headers: {
					...headers,
					'X-com-zoho-expense-organizationid': String(orgId)
				}
			});
			const data = await response.json();
			if (response.ok && data.code === 0) {
				zohoSuccess = true;
			} else {
				zohoError = data.message || `HTTP ${response.status}`;
			}
		} catch (err) {
			zohoError = err.message;
		}
	}

	// 2. Delete from Catalyst Data Store 'Expenses' table
	let dsDeleted = false;
	try {
		const table = catalystApp.datastore().table('Expenses');
		if (dsRowId) {
			await table.deleteRow(dsRowId);
			dsDeleted = true;
		} else {
			const zcqlRes = await catalystApp.zcql().executeZCQLQuery(
				`SELECT ROWID FROM Expenses WHERE expense_id = '${cleanId}'`
			);
			const rows = (zcqlRes || []).map((r) => r.Expenses || r);
			for (const r of rows) {
				await table.deleteRow(r.ROWID);
				dsDeleted = true;
			}
		}
	} catch (dsErr) {
		console.warn('Failed to delete row from Data Store Expenses table:', dsErr.message);
	}

	return {
		ok: true,
		deletedExpenseId: zohoExpenseId,
		deletedRowId: dsRowId,
		zohoSuccess,
		dsDeleted,
		zohoError,
		message: 'Expense deleted from Zoho Expense and Catalyst Data Store'
	};
}

module.exports = {
	getOrganizations,
	listExpenses,
	getExpenseSummary,
	createExpense,
	deleteExpense,
	listCategories,
	listExpensesFromDataStore,
	reconcileDataStoreWithLiveExpenses
};

