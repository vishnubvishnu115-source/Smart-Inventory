'use strict';

const TABLE_NAME = 'Products';

function unwrapProducts(rows) {
	return (rows || []).map((row) => row[TABLE_NAME] || row);
}

function stripEmoji(value) {
	return String(value ?? '').replace(/[\u{10000}-\u{10FFFF}]/gu, '');
}

function formatProductRecord(item) {
	return {
		rowId: item.ROWID,
		sku: String(item.SKU),
		itemName: item.ItemName,
		stockCount: Number(item.StockCount),
		reorderLevel: Number(item.ReorderLevel),
		supplierEmail: item.SupplierEmail,
		createdTime: item.CREATEDTIME || null,
		modifiedTime: item.MODIFIEDTIME || null
	};
}

async function listProducts(catalystApp) {
	const rows = await catalystApp
		.zcql()
		.executeZCQLQuery(
			`SELECT ROWID, SKU, ItemName, StockCount, ReorderLevel, SupplierEmail, CREATEDTIME, MODIFIEDTIME FROM ${TABLE_NAME} ORDER BY SKU ASC`
		);
	return unwrapProducts(rows).map(formatProductRecord);
}

async function findProductBySku(catalystApp, sku) {
	const cleanSku = String(sku || '').trim();
	if (!/^\d{3}$/.test(cleanSku)) {
		return null;
	}
	const rows = await catalystApp
		.zcql()
		.executeZCQLQuery(
			`SELECT ROWID, SKU, ItemName, StockCount, ReorderLevel, SupplierEmail, CREATEDTIME, MODIFIEDTIME FROM ${TABLE_NAME} WHERE SKU = '${cleanSku}'`
		);
	const items = unwrapProducts(rows);
	return items.length > 0 ? items[0] : null;
}

function validateProductPayload(body, options = {}) {
	const requireAll = options.requireAll !== false;
	const sku = String(body.newSku || body.sku || '').trim();
	const itemName = stripEmoji(body.itemName).trim();
	const supplierEmail = stripEmoji(body.supplierEmail).trim();
	const stockCount = body.stockCount === undefined || body.stockCount === '' ? undefined : Number(body.stockCount);
	const reorderLevel =
		body.reorderLevel === undefined || body.reorderLevel === '' ? undefined : Number(body.reorderLevel);

	if ((requireAll || body.newSku !== undefined || body.sku !== undefined) && !/^\d{3}$/.test(sku)) {
		return { ok: false, error: 'SKU must be a 3-digit numeric code (for example: 403).' };
	}
	if (requireAll || body.itemName !== undefined) {
		if (!itemName || itemName.length > 255) {
			return { ok: false, error: 'Product name is required (max 255 characters).' };
		}
	}
	if (requireAll || stockCount !== undefined) {
		if (!Number.isInteger(stockCount) || stockCount < 0) {
			return { ok: false, error: 'Stock count must be a whole number >= 0.' };
		}
	}
	if (requireAll || reorderLevel !== undefined) {
		if (!Number.isInteger(reorderLevel) || reorderLevel < 0) {
			return { ok: false, error: 'Reorder level must be a whole number >= 0.' };
		}
	}
	if (requireAll || body.supplierEmail !== undefined) {
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supplierEmail) || supplierEmail.length > 255) {
			return { ok: false, error: 'A valid supplier email address (max 255 chars) is required.' };
		}
	}

	return {
		ok: true,
		data: { sku, itemName, stockCount, reorderLevel, supplierEmail }
	};
}

async function createProduct(catalystApp, body) {
	const check = validateProductPayload(body, { requireAll: true });
	if (!check.ok) {
		return { status: 400, error: check.error };
	}

	const existing = await findProductBySku(catalystApp, check.data.sku);
	if (existing) {
		return { status: 409, error: `SKU ${check.data.sku} already exists (${existing.ItemName}).` };
	}

	const inserted = await catalystApp.datastore().table(TABLE_NAME).insertRow({
		SKU: check.data.sku,
		ItemName: check.data.itemName,
		StockCount: check.data.stockCount,
		ReorderLevel: check.data.reorderLevel,
		SupplierEmail: check.data.supplierEmail
	});

	return {
		status: 201,
		created: {
			rowId: inserted.ROWID,
			sku: check.data.sku,
			itemName: check.data.itemName,
			stockCount: check.data.stockCount,
			reorderLevel: check.data.reorderLevel,
			supplierEmail: check.data.supplierEmail
		}
	};
}

async function updateProduct(catalystApp, targetSku, body) {
	const lookupSku = String(targetSku || body.sku || '').trim();
	if (!/^\d{3}$/.test(lookupSku)) {
		return { status: 400, error: 'Target SKU must be a 3-digit numeric code.' };
	}

	const existing = await findProductBySku(catalystApp, lookupSku);
	if (!existing) {
		return { status: 404, error: `SKU ${lookupSku} was not found in Products.` };
	}

	const mergedPayload = {
		sku: body.newSku !== undefined ? body.newSku : lookupSku,
		itemName: body.itemName !== undefined ? body.itemName : existing.ItemName,
		stockCount: body.stockCount !== undefined ? body.stockCount : Number(existing.StockCount),
		reorderLevel: body.reorderLevel !== undefined ? body.reorderLevel : Number(existing.ReorderLevel),
		supplierEmail: body.supplierEmail !== undefined ? body.supplierEmail : existing.SupplierEmail
	};

	const check = validateProductPayload(mergedPayload, { requireAll: true });
	if (!check.ok) {
		return { status: 400, error: check.error };
	}

	if (check.data.sku !== lookupSku) {
		const conflict = await findProductBySku(catalystApp, check.data.sku);
		if (conflict) {
			return { status: 409, error: `Cannot rename to SKU ${check.data.sku}: already assigned to ${conflict.ItemName}.` };
		}
	}

	await catalystApp.datastore().table(TABLE_NAME).updateRow({
		ROWID: existing.ROWID,
		SKU: check.data.sku,
		ItemName: check.data.itemName,
		StockCount: check.data.stockCount,
		ReorderLevel: check.data.reorderLevel,
		SupplierEmail: check.data.supplierEmail
	});

	return {
		status: 200,
		updated: {
			rowId: existing.ROWID,
			previousSku: lookupSku,
			sku: check.data.sku,
			itemName: check.data.itemName,
			stockCount: check.data.stockCount,
			reorderLevel: check.data.reorderLevel,
			supplierEmail: check.data.supplierEmail
		}
	};
}

async function deleteProduct(catalystApp, sku) {
	const cleanSku = String(sku || '').trim();
	if (!/^\d{3}$/.test(cleanSku)) {
		return { status: 400, error: 'SKU must be a 3-digit numeric code.' };
	}

	const existing = await findProductBySku(catalystApp, cleanSku);
	if (!existing) {
		return { status: 404, error: `SKU ${cleanSku} was not found in Products.` };
	}

	await catalystApp.datastore().table(TABLE_NAME).deleteRow(existing.ROWID);

	return {
		status: 200,
		deleted: {
			rowId: existing.ROWID,
			sku: cleanSku,
			itemName: existing.ItemName
		}
	};
}

module.exports = {
	TABLE_NAME,
	listProducts,
	findProductBySku,
	validateProductPayload,
	createProduct,
	updateProduct,
	deleteProduct
};

