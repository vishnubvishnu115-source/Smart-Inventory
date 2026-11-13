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

	return {
		ok: true,
		expenses: data.expenses || [],
		page_context: data.page_context,
		organization_id: orgId
	};
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

	const amount = Number(expensePayload.amount || 0);
	const date = expensePayload.date || new Date().toISOString().slice(0, 10);
	const merchantName = (expensePayload.merchant_name || expensePayload.merchant || 'Inventory Supplier').trim();
	const description = (expensePayload.description || expensePayload.notes || `Inventory Purchase - ${merchantName}`).trim();

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

	// 3. Build payload according to Zoho Expense API requirements
	const zohoPayload = {
		currency_id: String(currencyId),
		date: date,
		merchant_name: merchantName,
		line_items: [
			{
				amount: amount,
				category_id: categoryId,
				description: description || `Inventory item: ${merchantName}`
			}
		]
	};

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
	if (!response.ok || data.code !== 0) {
		return {
			error: data.message || `Failed to create expense: HTTP ${response.status}`,
			status: response.status || 500,
			details: data
		};
	}

	return {
		ok: true,
		expense: data.expense,
		message: 'Expense created successfully'
	};
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

module.exports = {
	getOrganizations,
	listExpenses,
	getExpenseSummary,
	createExpense,
	listCategories
};

