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

function isLocalOrigin(origin) {
	return typeof origin === 'string' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

function sendJson(req, res, statusCode, payload) {
	const headers = { 'Content-Type': 'application/json; charset=utf-8' };
	const origin = req.headers.origin;
	if (isLocalOrigin(origin)) {
		headers['Access-Control-Allow-Origin'] = origin;
		headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
		headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
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
	const subject = `Restock Order Request: ${itemName} (SKU ${sku}) - ${reorderQty} Units`;
	const body = [
		`Hello ${supplierEmail.split('@')[0] || 'Supply Team'},`,
		'',
		`Our warehouse inventory for ${itemName} (SKU: ${sku}) has dropped to ${newStock} units, which is at or below our reorder threshold of ${reorderLevel} units.`,
		'',
		`Please arrange a restock shipment of ${reorderQty} units of ${itemName} (SKU ${sku}) at your earliest convenience and confirm the estimated delivery date.`,
		'',
		'Thank you,',
		'Smart Inventory Operations'
	].join('\n');

	return { subject, body, generator: 'smart-template' };
}

async function generateEmailDraft(details) {
	const prompt = `Stock is low for ${details.itemName} (SKU ${details.sku}, ${details.newStock} remaining vs reorder level ${details.reorderLevel}). Draft a short, polite restock order email to ${details.supplierEmail} requesting ${details.reorderQty} units. Return JSON with keys "subject" and "body" only.`;

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
		liveMailConfigured: Boolean((process.env.CATALYST_FROM_EMAIL || '').trim())
	};
}

module.exports = async (req, res) => {
	if (req.method === 'OPTIONS') {
		sendJson(req, res, 204, {});
		return;
	}

	const parsedUrl = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
	const pathname = parsedUrl.pathname.replace(/^\/execute/, '') || '/';

	try {
		const catalystApp = catalyst.initialize(req, { scope: 'admin' });
		const capabilities = getCapabilities();

		if (req.method === 'GET' && (pathname === '/' || pathname === '/products' || pathname === '/health')) {
			const products = await listProducts(catalystApp);
			sendJson(req, res, 200, {
				ok: true,
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

		if (req.method === 'POST' && (pathname === '/products' || pathname === '/products/create')) {
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
			const soldQty = Number(body.soldQty);
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

		sendJson(req, res, 404, { ok: false, error: `Route not found: ${req.method} ${pathname}` });
	} catch (err) {
		console.error('smart_inventory error:', err);
		sendJson(req, res, 500, { ok: false, error: err.message || 'Internal server error' });
	}
};
