'use strict';

const catalyst = require('zcatalyst-sdk-node');
const { calculateReorderPlan, buildStockAnalysis } = require('./stockAnalyzer');
const {
	TABLE_NAME,
	listProducts,
	findProductBySku,
	createProduct,
	updateProduct,
	deleteProduct
} = require('./productManager');
const {
	listUsers,
	createUser,
	updateUser,
	deleteUser,
	authenticateCredentials,
	generateSessionToken,
	verifySessionToken,
	extractToken
} = require('./userManager');
const {
	getOrganizations: getExpenseOrganizations,
	listExpenses,
	getExpenseSummary,
	createExpense,
	deleteExpense,
	listCategories: listExpenseCategories,
	listExpensesFromDataStore
} = require('./expenseManager');

function isAllowedOrigin(origin) {
	if (!origin || typeof origin !== 'string') return false;
	return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ||
	       /^https?:\/\/(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/i.test(origin) ||
	       /^https:\/\/[a-z0-9\-]+\.onslate\.in$/i.test(origin) ||
	       /^https:\/\/[a-z0-9\-]+\.catalystserverless\.in$/i.test(origin) ||
	       /^https:\/\/[a-z0-9\-]+\.zoho\.(com|in)$/i.test(origin) ||
	       origin === 'null';
}

function sendJson(req, res, statusCode, payload) {
	const headers = { 'Content-Type': 'application/json; charset=utf-8' };
	const origin = req.headers.origin || req.headers.Origin;
	if (origin && isAllowedOrigin(origin)) {
		// In Catalyst Cloud production, ZGS (Zoho Global Server) automatically injects
		// 'Access-Control-Allow-Origin: <origin>' and 'Access-Control-Allow-Credentials: true'
		// for all registered domains (such as *.onslate.in and *.catalystserverless.in).
		// If the function ALSO sets Access-Control-Allow-Origin, ZGS concatenates them with commas
		// (e.g. 'https://...onslate.in, https://...onslate.in'), triggering browser CORS violation
		// and causing all client fetch() calls to fail with "TypeError: Failed to fetch".
		const hostname = origin.replace(/^https?:\/\//i, '').split(':')[0].toLowerCase();
		const isZGSManaged = hostname.endsWith('.onslate.in') || hostname.endsWith('.catalystserverless.in');

		if (!isZGSManaged) {
			headers['Access-Control-Allow-Origin'] = origin;
			headers['Access-Control-Allow-Credentials'] = 'true';
		}
		headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, PATCH, OPTIONS';
		headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, x-session-token, X-Session-Token, x-smart-token, X-Smart-Token, X-Requested-With, Accept, Origin';
		headers['Access-Control-Expose-Headers'] = 'x-session-token, X-Session-Token, Authorization';
	}
	res.writeHead(statusCode, headers);
	res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
	if (req.body && typeof req.body === 'object') {
		return Promise.resolve(req.body);
	}
	if (req.body && typeof req.body === 'string') {
		try {
			return Promise.resolve(JSON.parse(req.body));
		} catch {
			return Promise.reject(new Error('Invalid JSON payload'));
		}
	}
	return new Promise((resolve, reject) => {
		let raw = '';
		req.on('data', (chunk) => {
			raw += chunk;
			if (raw.length > 1024 * 64) {
				reject(new Error('Request body too large'));
			}
		});
		req.on('end', () => {
			if (!raw.trim()) {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(raw));
			} catch {
				reject(new Error('Invalid JSON payload'));
			}
		});
		req.on('error', reject);
	});
}

function buildTemplateDraft({ sku, itemName, newStock, reorderLevel, reorderQty, supplierEmail }) {
	const subject = `Purchase Order: ${itemName} (SKU ${sku}) - ${reorderQty} Units`;
	const body = [
		`Hello ${supplierEmail.split('@')[0] || 'Supply Team'},`,
		'',
		`Our warehouse stock for ${itemName} (SKU: ${sku}) reached ${newStock} units, hitting our reorder threshold of ${reorderLevel} units.`,
		'',
		`Please confirm and dispatch an order of ${reorderQty} units of ${itemName} (SKU ${sku}) to our receiving dock.`,
		'',
		'Thank you,',
		'Smart Inventory Operations'
	].join('\n');

	return { subject, body, generator: 'smart-template' };
}

async function generateEmailDraft(details) {
	const prompt = `Write a direct, professional restock purchase order email to supplier ${details.supplierEmail}.
Item: ${details.itemName} (SKU: ${details.sku})
Current Stock: ${details.newStock} units
Reorder Threshold: ${details.reorderLevel} units
Quantity to Order: ${details.reorderQty} units

Writing constraints:
- Direct, concise warehouse business prose.
- No throat-clearing, no filler phrases ("Hope this email finds you well", "I am writing to").
- No AI fluff or buzzwords.
- State the order quantity, SKU, and delivery request directly.
Return JSON with keys "subject" and "body" only.`;

	if (process.env.GEMINI_API_KEY) {
		try {
			const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
			const resp = await fetch(
				`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						contents: [{ parts: [{ text: prompt }] }],
						generationConfig: { responseMimeType: 'application/json', temperature: 0.3 }
					})
				}
			);
			if (resp.ok) {
				const data = await resp.json();
				const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
				const parsed = text ? JSON.parse(text) : null;
				if (parsed?.subject && parsed?.body) {
					return { subject: parsed.subject, body: parsed.body, generator: `gemini:${model}` };
				}
			}
		} catch (err) {
			console.warn('Gemini draft fallback triggered:', err.message);
		}
	}

	if (process.env.OPENAI_API_KEY) {
		try {
			const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
			const resp = await fetch('https://api.openai.com/v1/chat/completions', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
				},
				body: JSON.stringify({
					model,
					temperature: 0.3,
					response_format: { type: 'json_object' },
					messages: [{ role: 'user', content: prompt }]
				})
			});
			if (resp.ok) {
				const data = await resp.json();
				const text = data?.choices?.[0]?.message?.content;
				const parsed = text ? JSON.parse(text) : null;
				if (parsed?.subject && parsed?.body) {
					return { subject: parsed.subject, body: parsed.body, generator: `openai:${model}` };
				}
			}
		} catch (err) {
			console.warn('OpenAI draft fallback triggered:', err.message);
		}
	}

	return buildTemplateDraft(details);
}

async function trySendLiveEmail(catalystApp, toEmail, draft) {
	const fromEmail = (process.env.CATALYST_FROM_EMAIL || '').trim();
	if (!fromEmail) {
		return {
			attempted: false,
			sent: false,
			senderConfigured: false,
			fromEmail: null,
			note: 'Live send skipped: set CATALYST_FROM_EMAIL in Function environment variables and verify that sender domain in Catalyst Console -> Mail -> Sender Domains.'
		};
	}

	try {
		await catalystApp.email().sendMail({
			from_email: fromEmail,
			to_email: [toEmail],
			subject: draft.subject,
			content: `<pre style="font-family: sans-serif; white-space: pre-wrap;">${escapeHtml(draft.body)}</pre>`
		});
		return {
			attempted: true,
			sent: true,
			senderConfigured: true,
			fromEmail,
			note: `Email handed off to Catalyst Mail from ${fromEmail} to ${toEmail}. (Delivery requires DKIM/SPF verification for the sender domain.)`
		};
	} catch (err) {
		return {
			attempted: true,
			sent: false,
			senderConfigured: true,
			fromEmail,
			note: `Catalyst Mail error: ${err.message}`
		};
	}
}

function escapeHtml(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function getCapabilities() {
	return {
		llmConfigured: Boolean(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY),
		liveMailConfigured: Boolean((process.env.CATALYST_FROM_EMAIL || '').trim()),
		expenseConfigured: true
	};
}

async function authenticateAppUser(req) {
	try {
		const userApp = catalyst.initialize(req);
		const currentUser = await userApp.userManagement().getCurrentUser();
		if (!currentUser || !currentUser.user_id) {
			return null;
		}
		if (currentUser.status && String(currentUser.status).toUpperCase() !== 'ACTIVE') {
			return { disabled: true, unconfirmed: false, user: null };
		}
		if (currentUser.is_confirmed === false) {
			return { disabled: false, unconfirmed: true, user: null };
		}
		return {
			disabled: false,
			unconfirmed: false,
			user: {
				userId: String(currentUser.user_id),
				email: currentUser.email_id || '',
				firstName: currentUser.first_name || '',
				lastName: currentUser.last_name || '',
				roleId: String(currentUser.role_details?.role_id || ''),
				roleName: String(currentUser.role_details?.role_name || 'App User')
			}
		};
	} catch {
		return null;
	}
}

async function resolveCurrentUser(req) {
	// 1. Webhook Secret or API Key for server-to-server Deluge / workflow automation
	const webhookSecret = (req.headers && (req.headers['x-webhook-secret'] || req.headers['x-api-key'])) || '';
	if (webhookSecret && webhookSecret === (process.env.WEBHOOK_SECRET || 'smart-inventory-custom-auth-2026')) {
		return {
			user: {
				rowId: 'service_deluge',
				username: 'deluge_bill_automation',
				fullName: 'Zoho Bill Automation',
				email: 'deluge-webhook@zoho.com',
				role: 'Admin'
			}
		};
	}

	const token = extractToken(req);
	if (token) {
		const payload = verifySessionToken(token);
		if (payload) {
			return { user: payload };
		}
	}
	const appUser = await authenticateAppUser(req);
	if (appUser && appUser.user) {
		return { user: appUser.user };
	}
	return null;
}

module.exports = async (req, res) => {
	if (req.method === 'OPTIONS') {
		sendJson(req, res, 204, {});
		return;
	}

	const parsedUrl = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
	let pathname = parsedUrl.pathname
		.replace(/^\/server\/smart_inventory/, '')
		.replace(/^\/execute/, '') || '/';
	if (pathname.length > 1 && pathname.endsWith('/')) {
		pathname = pathname.slice(0, -1);
	}

	try {
		const catalystApp = catalyst.initialize(req, { scope: 'admin' });
		const capabilities = getCapabilities();

		// Public endpoint: Custom Database User Login
		if (req.method === 'POST' && (pathname === '/login' || pathname === '/users/login')) {
			const body = await readJsonBody(req);
			const identifier = body.username || body.identifier || body.email;
			const password = body.password;
			const result = await authenticateCredentials(catalystApp, identifier, password);
			if (result.error) {
				sendJson(req, res, result.status || 401, { ok: false, error: result.error });
				return;
			}
			sendJson(req, res, 200, {
				ok: true,
				token: result.token,
				user: result.user,
				capabilities
			});
			return;
		}

		// Public endpoint: Custom Database User Sign Up / Register
		if (req.method === 'POST' && (pathname === '/signup' || pathname === '/register' || pathname === '/users/signup')) {
			const body = await readJsonBody(req);
			const result = await createUser(catalystApp, body);
			if (result.error) {
				sendJson(req, res, result.status || 400, { ok: false, error: result.error });
				return;
			}
			const token = generateSessionToken(result.created);
			sendJson(req, res, 201, {
				ok: true,
				token,
				user: result.created,
				capabilities
			});
			return;
		}

		// Public endpoint: Logout
		if (req.method === 'POST' && (pathname === '/logout' || pathname === '/users/logout')) {
			sendJson(req, res, 200, { ok: true, message: 'Logged out successfully' });
			return;
		}

		// Public health check
		if (req.method === 'GET' && pathname === '/health') {
			sendJson(req, res, 200, { ok: true, status: 'healthy', capabilities });
			return;
		}

		// Protected endpoints check session token or native app user
		const auth = await resolveCurrentUser(req);
		if (!auth) {
			sendJson(req, res, 401, {
				ok: false,
				code: 'AUTH_REQUIRED',
				error: 'Authentication required. Please sign in using your SmartStock user account.'
			});
			return;
		}

		if (req.method === 'GET' && pathname === '/me') {
			sendJson(req, res, 200, {
				ok: true,
				user: auth.user,
				capabilities
			});
			return;
		}

		// User Management endpoints (Users Table)
		if (req.method === 'GET' && pathname === '/users') {
			const users = await listUsers(catalystApp);
			sendJson(req, res, 200, {
				ok: true,
				users,
				capabilities
			});
			return;
		}

		if (req.method === 'POST' && (pathname === '/users' || pathname === '/users/create')) {
			const body = await readJsonBody(req);
			const result = await createUser(catalystApp, body);
			if (result.error) {
				sendJson(req, res, result.status || 400, { ok: false, error: result.error });
				return;
			}
			const users = await listUsers(catalystApp);
			sendJson(req, res, result.status, {
				ok: true,
				created: result.created,
				users,
				capabilities
			});
			return;
		}

		if (req.method === 'POST' && pathname === '/users/update') {
			const body = await readJsonBody(req);
			const result = await updateUser(catalystApp, body.rowId, body);
			if (result.error) {
				sendJson(req, res, result.status || 400, { ok: false, error: result.error });
				return;
			}
			const users = await listUsers(catalystApp);
			sendJson(req, res, result.status, {
				ok: true,
				user: result.user,
				users,
				capabilities
			});
			return;
		}

		if (req.method === 'POST' && pathname === '/users/delete') {
			const body = await readJsonBody(req);
			const result = await deleteUser(catalystApp, body.rowId);
			if (result.error) {
				sendJson(req, res, result.status || 400, { ok: false, error: result.error });
				return;
			}
			const users = await listUsers(catalystApp);
			sendJson(req, res, result.status, {
				ok: true,
				deletedRowId: result.deletedRowId,
				users,
				capabilities
			});
			return;
		}

		if (req.method === 'GET' && (pathname === '/' || pathname === '/products' || pathname === '/health')) {
			const products = await listProducts(catalystApp);
			sendJson(req, res, 200, {
				ok: true,
				user: auth.user,
				products,
				capabilities
			});
			return;
		}

		if (req.method === 'GET' && (pathname === '/stock-analysis' || pathname === '/dashboard')) {
			const stagnantHoursParam = Number(parsedUrl.searchParams.get('stagnantHours'));
			const stagnantHours = Number.isFinite(stagnantHoursParam) && stagnantHoursParam > 0 ? stagnantHoursParam : undefined;
			const products = await listProducts(catalystApp);
			const analysis = buildStockAnalysis(products, { stagnantHours });
			sendJson(req, res, 200, {
				ok: true,
				analysis,
				products,
				capabilities
			});
			return;
		}

		if (req.method === 'POST' && (pathname === '/products' || pathname === '/products/create' || pathname === '/products/add')) {
			const body = await readJsonBody(req);
			const result = await createProduct(catalystApp, body);
			if (result.error) {
				sendJson(req, res, result.status, { ok: false, error: result.error });
				return;
			}
			const products = await listProducts(catalystApp);
			sendJson(req, res, result.status, {
				ok: true,
				created: result.created,
				products,
				capabilities
			});
			return;
		}

		const skuParamMatch = pathname.match(/^\/products\/(\d{3})$/);
		if (
			(req.method === 'POST' && pathname === '/products/update') ||
			(req.method === 'PUT' && (pathname === '/products' || skuParamMatch))
		) {
			const body = await readJsonBody(req);
			const targetSku = skuParamMatch ? skuParamMatch[1] : body.sku;
			const result = await updateProduct(catalystApp, targetSku, body);
			if (result.error) {
				sendJson(req, res, result.status, { ok: false, error: result.error });
				return;
			}
			const products = await listProducts(catalystApp);
			sendJson(req, res, result.status, {
				ok: true,
				updated: result.updated,
				products,
				capabilities
			});
			return;
		}

		if (
			(req.method === 'POST' && pathname === '/products/delete') ||
			(req.method === 'DELETE' && (pathname === '/products' || skuParamMatch))
		) {
			const body = await readJsonBody(req);
			const targetSku = skuParamMatch ? skuParamMatch[1] : body.sku || parsedUrl.searchParams.get('sku');
			const result = await deleteProduct(catalystApp, targetSku);
			if (result.error) {
				sendJson(req, res, result.status, { ok: false, error: result.error });
				return;
			}
			const products = await listProducts(catalystApp);
			sendJson(req, res, result.status, {
				ok: true,
				deleted: result.deleted,
				products,
				capabilities
			});
			return;
		}

		if (req.method === 'POST' && (pathname === '/' || pathname === '/log-sale')) {
			const body = await readJsonBody(req);
			const sku = String(body.sku || '').trim();
			const soldQty = Number(body.soldQty ?? body.quantitySold);
			const sendLiveEmail = body.sendEmail !== false;

			if (!/^\d{3}$/.test(sku)) {
				sendJson(req, res, 400, { ok: false, error: 'SKU must be a 3-digit code (for example: 401 or 505).' });
				return;
			}
			if (!Number.isInteger(soldQty) || soldQty <= 0) {
				sendJson(req, res, 400, { ok: false, error: 'Units sold must be a positive whole number.' });
				return;
			}

			const product = await findProductBySku(catalystApp, sku);
			if (!product) {
				sendJson(req, res, 404, { ok: false, error: `SKU ${sku} was not found in the Products table.` });
				return;
			}

			const previousStock = Number(product.StockCount);
			const reorderLevel = Number(product.ReorderLevel);
			if (soldQty > previousStock) {
				sendJson(req, res, 400, {
					ok: false,
					error: `Insufficient stock for ${product.ItemName} (SKU ${sku}): ${previousStock} unit(s) available, cannot deduct ${soldQty}.`
				});
				return;
			}

			const newStock = previousStock - soldQty;
			await catalystApp.datastore().table(TABLE_NAME).updateRow({
				ROWID: product.ROWID,
				StockCount: newStock
			});

			const plan = calculateReorderPlan(product.ItemName, sku, newStock, reorderLevel);
			let emailDraft = null;
			let mailDelivery = null;

			if (plan.needsReorder) {
				const targetEmail = String(body.recipientOverride || product.SupplierEmail).trim();
				emailDraft = await generateEmailDraft({
					sku,
					itemName: product.ItemName,
					newStock,
					reorderLevel,
					reorderQty: plan.reorderQty,
					supplierEmail: targetEmail
				});
				emailDraft.to = targetEmail;
				mailDelivery = sendLiveEmail
					? await trySendLiveEmail(catalystApp, targetEmail, emailDraft)
					: { attempted: false, sent: false, note: 'Draft-only mode selected for this scan.' };
			}

			const products = await listProducts(catalystApp);
			sendJson(req, res, 200, {
				ok: true,
				sale: {
					sku,
					itemName: product.ItemName,
					soldQty,
					previousStock,
					newStock,
					reorderLevel,
					supplierEmail: product.SupplierEmail
				},
				agentDecision: plan,
				emailDraft,
				mailDelivery,
				products
			});
			return;
		}

		if (req.method === 'POST' && pathname === '/restock') {
			const body = await readJsonBody(req);
			const sku = String(body.sku || '').trim();
			const addQty = Number(body.addQty || 50);

			if (!/^\d{3}$/.test(sku)) {
				sendJson(req, res, 400, { ok: false, error: 'SKU must be a 3-digit code.' });
				return;
			}
			if (!Number.isInteger(addQty) || addQty <= 0) {
				sendJson(req, res, 400, { ok: false, error: 'Restock quantity must be a positive whole number.' });
				return;
			}

			const product = await findProductBySku(catalystApp, sku);
			if (!product) {
				sendJson(req, res, 404, { ok: false, error: `SKU ${sku} was not found.` });
				return;
			}

			const newStock = Number(product.StockCount) + addQty;
			await catalystApp.datastore().table(TABLE_NAME).updateRow({
				ROWID: product.ROWID,
				StockCount: newStock
			});

			const products = await listProducts(catalystApp);
			sendJson(req, res, 200, {
				ok: true,
				restocked: { sku, itemName: product.ItemName, added: addQty, newStock },
				products
			});
			return;
		}

		// Zoho Expense API Routes via Catalyst Connection ('expense')
		if (req.method === 'GET' && pathname === '/expenses/organizations') {
			const orgResult = await getExpenseOrganizations(catalystApp);
			sendJson(req, res, 200, orgResult);
			return;
		}

		if (req.method === 'GET' && pathname === '/expenses/categories') {
			const orgId = parsedUrl.searchParams.get('organization_id') || parsedUrl.searchParams.get('organizationId');
			const result = await listExpenseCategories(catalystApp, orgId);
			if (result.error) {
				sendJson(req, res, result.status || 500, { ok: false, error: result.error });
				return;
			}
			sendJson(req, res, 200, result);
			return;
		}

		if (req.method === 'GET' && pathname === '/expenses/summary') {
			const orgId = parsedUrl.searchParams.get('organization_id') || parsedUrl.searchParams.get('organizationId');
			const result = await getExpenseSummary(catalystApp, { organizationId: orgId });
			if (result.error) {
				sendJson(req, res, result.status || 500, { ok: false, error: result.error, details: result.details });
				return;
			}
			sendJson(req, res, 200, result);
			return;
		}

		if (req.method === 'GET' && pathname === '/expenses/datastore') {
			const result = await listExpensesFromDataStore(catalystApp);
			sendJson(req, res, result.ok ? 200 : 500, result);
			return;
		}

		if (req.method === 'GET' && pathname === '/expenses') {
			const orgId = parsedUrl.searchParams.get('organization_id') || parsedUrl.searchParams.get('organizationId');
			const page = parsedUrl.searchParams.get('page');
			const perPage = parsedUrl.searchParams.get('per_page');
			const status = parsedUrl.searchParams.get('status');
			const categoryId = parsedUrl.searchParams.get('category_id');

			const result = await listExpenses(catalystApp, {
				organizationId: orgId,
				page,
				per_page: perPage,
				status,
				category_id: categoryId
			});
			if (result.error) {
				sendJson(req, res, result.status || 500, { ok: false, error: result.error, details: result.details });
				return;
			}
			sendJson(req, res, 200, result);
			return;
		}

		if (req.method === 'POST' && pathname === '/expenses') {
			const body = await readJsonBody(req);
			const orgId = parsedUrl.searchParams.get('organization_id') || body.organization_id;
			const result = await createExpense(catalystApp, body, orgId);
			if (result.error) {
				sendJson(req, res, result.status || 500, { ok: false, error: result.error, details: result.details });
				return;
			}
			sendJson(req, res, 201, result);
			return;
		}

		if (
			(req.method === 'POST' && pathname === '/expenses/delete') ||
			(req.method === 'DELETE' && (pathname === '/expenses' || pathname.startsWith('/expenses/')))
		) {
			const body = await readJsonBody(req);
			let expenseId = body.expenseId || body.expense_id || body.rowId || parsedUrl.searchParams.get('expenseId') || parsedUrl.searchParams.get('id');
			if (!expenseId && pathname.startsWith('/expenses/')) {
				const parts = pathname.split('/');
				if (parts.length >= 3 && !['organizations', 'categories', 'summary', 'datastore', 'delete'].includes(parts[2])) {
					expenseId = parts[2];
				}
			}
			const orgId = parsedUrl.searchParams.get('organization_id') || body.organization_id;
			const result = await deleteExpense(catalystApp, expenseId, orgId);
			if (result.error) {
				sendJson(req, res, result.status || 500, { ok: false, error: result.error });
				return;
			}
			sendJson(req, res, 200, result);
			return;
		}

		sendJson(req, res, 404, { ok: false, error: `Route not found: ${req.method} ${pathname}` });
	} catch (err) {
		console.error('smart_inventory error:', err);
		sendJson(req, res, 500, { ok: false, error: err.message || 'Internal server error' });
	}
};
