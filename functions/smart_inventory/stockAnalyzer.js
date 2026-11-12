'use strict';

const MIN_REORDER_QTY = 50;
const DEFAULT_STAGNANT_HOURS = 24;
const DEFAULT_TZ_OFFSET_MINUTES = Number(process.env.CATALYST_TZ_OFFSET_MINUTES || 330);

function parseCatalystTime(catalystTimestamp, tzOffsetMinutes = DEFAULT_TZ_OFFSET_MINUTES) {
	if (!catalystTimestamp || typeof catalystTimestamp !== 'string') {
		return null;
	}
	const normalized = catalystTimestamp.trim().replace(' ', 'T').replace(/:(\d{3})$/, '.$1') + 'Z';
	const utcMs = Date.parse(normalized);
	if (Number.isNaN(utcMs)) {
		return null;
	}
	const offset = Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 0;
	return utcMs - offset * 60 * 1000;
}

function formatDuration(hours) {
	if (hours === null || !Number.isFinite(hours)) {
		return 'Unknown';
	}
	if (hours < 1) {
		const mins = Math.max(1, Math.round(hours * 60));
		return `${mins}m ago`;
	}
	if (hours < 24) {
		const wholeHours = Math.floor(hours);
		const mins = Math.round((hours - wholeHours) * 60);
		return mins > 0 ? `${wholeHours}h ${mins}m ago` : `${wholeHours}h ago`;
	}
	const days = Math.floor(hours / 24);
	const remHours = Math.round(hours % 24);
	return remHours > 0 ? `${days}d ${remHours}h ago` : `${days}d ago`;
}

function calculateReorderPlan(itemName, sku, newStock, reorderLevel) {
	const needsReorder = newStock <= reorderLevel;
	if (!needsReorder) {
		return {
			needsReorder: false,
			reorderQty: 0,
			reason: `Stock (${newStock}) is above reorder threshold (${reorderLevel}). No purchase order needed.`
		};
	}

	const targetLevel = Math.max(reorderLevel * 5, reorderLevel + MIN_REORDER_QTY);
	const reorderQty = Math.max(MIN_REORDER_QTY, targetLevel - newStock);
	const urgency = newStock === 0 ? 'Out of stock' : 'Low stock';

	return {
		needsReorder: true,
		reorderQty,
		reason: `${urgency}: ${itemName} (SKU ${sku}) dropped to ${newStock} units (<= threshold ${reorderLevel}). Recommended reorder: ${reorderQty} units.`
	};
}

function analyzeProductStock(item, options = {}) {
	const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
	const stagnantHours =
		Number.isFinite(options.stagnantHours) && options.stagnantHours > 0
			? options.stagnantHours
			: DEFAULT_STAGNANT_HOURS;

	const stockCount = Math.max(0, Number(item.stockCount || 0));
	const reorderLevel = Math.max(0, Number(item.reorderLevel || 0));
	const targetPar = Math.max(reorderLevel * 5, reorderLevel + MIN_REORDER_QTY);
	const plan = calculateReorderPlan(item.itemName, item.sku, stockCount, reorderLevel);

	const modifiedMs = parseCatalystTime(item.modifiedTime);
	const hoursSinceMovement =
		modifiedMs !== null ? Math.max(0, (nowMs - modifiedMs) / (1000 * 60 * 60)) : null;

	let status = 'healthy';
	let statusLabel = 'Healthy';
	if (stockCount === 0) {
		status = 'out_of_stock';
		statusLabel = 'Out of Stock';
	} else if (stockCount <= reorderLevel) {
		status = 'low_stock';
		statusLabel = 'Low Stock';
	} else if (stockCount > targetPar) {
		status = 'overstock';
		statusLabel = 'Overstock';
	}

	const isStagnant =
		stockCount > 0 && hoursSinceMovement !== null && hoursSinceMovement >= stagnantHours;

	const coverageRatio =
		reorderLevel > 0 ? Number((stockCount / reorderLevel).toFixed(2)) : stockCount > 0 ? 99 : 0;
	const parFillPct = Math.min(100, Math.round((stockCount / Math.max(targetPar, 1)) * 100));
	const deficitUnits = Math.max(0, reorderLevel - stockCount);
	const excessUnits = Math.max(0, stockCount - targetPar);

	let recommendedAction = 'Monitor normal velocity';
	if (status === 'out_of_stock') {
		recommendedAction = `Urgent restock: order ${plan.reorderQty} units`;
	} else if (status === 'low_stock') {
		recommendedAction = `Reorder ${plan.reorderQty} units soon`;
	} else if (status === 'overstock') {
		recommendedAction = `Pause reorders (${excessUnits} excess units above par)`;
	} else if (isStagnant) {
		recommendedAction = `Review slow movement (idle ${formatDuration(hoursSinceMovement)})`;
	}

	const basePriority =
		status === 'out_of_stock'
			? 400
			: status === 'low_stock'
				? 300
				: status === 'overstock'
					? 200
					: isStagnant
						? 150
						: 100;
	const priorityScore = basePriority + (isStagnant ? 25 : 0) - Math.min(99, stockCount);

	return {
		rowId: item.rowId,
		sku: item.sku,
		itemName: item.itemName,
		supplierEmail: item.supplierEmail,
		stockCount,
		reorderLevel,
		targetPar,
		status,
		statusLabel,
		needsReorder: plan.needsReorder,
		recommendedReorderQty: plan.reorderQty,
		deficitUnits,
		excessUnits,
		coverageRatio,
		parFillPct,
		modifiedTime: item.modifiedTime || null,
		createdTime: item.createdTime || null,
		hoursSinceMovement:
			hoursSinceMovement !== null ? Number(hoursSinceMovement.toFixed(2)) : null,
		movementLabel: formatDuration(hoursSinceMovement),
		isStagnant,
		recommendedAction,
		priorityScore
	};
}

function buildStockAnalysis(products, options = {}) {
	const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
	const stagnantHours =
		Number.isFinite(options.stagnantHours) && options.stagnantHours > 0
			? options.stagnantHours
			: DEFAULT_STAGNANT_HOURS;

	const analyzed = (products || [])
		.map((item) => analyzeProductStock(item, { nowMs, stagnantHours }))
		.sort((a, b) => b.priorityScore - a.priorityScore || a.sku.localeCompare(b.sku));

	const totalSkus = analyzed.length;
	let totalUnits = 0;
	let totalReorderThresholdUnits = 0;
	let outOfStockCount = 0;
	let lowStockCount = 0;
	let healthyCount = 0;
	let overstockCount = 0;
	let stagnantCount = 0;
	let stagnantUnits = 0;
	let excessUnits = 0;
	let totalRecommendedReorderQty = 0;
	let coverageSum = 0;

	const supplierMap = new Map();

	for (const item of analyzed) {
		totalUnits += item.stockCount;
		totalReorderThresholdUnits += item.reorderLevel;
		totalRecommendedReorderQty += item.recommendedReorderQty;
		excessUnits += item.excessUnits;
		coverageSum += item.coverageRatio;

		if (item.status === 'out_of_stock') outOfStockCount += 1;
		else if (item.status === 'low_stock') lowStockCount += 1;
		else if (item.status === 'overstock') overstockCount += 1;
		else healthyCount += 1;

		if (item.isStagnant) {
			stagnantCount += 1;
			stagnantUnits += item.stockCount;
		}

		const email = item.supplierEmail || 'unassigned@example.com';
		if (!supplierMap.has(email)) {
			supplierMap.set(email, {
				supplierEmail: email,
				skuCount: 0,
				totalUnits: 0,
				lowStockCount: 0,
				overstockCount: 0,
				recommendedReorderQty: 0,
				skus: []
			});
		}
		const sup = supplierMap.get(email);
		sup.skuCount += 1;
		sup.totalUnits += item.stockCount;
		if (item.needsReorder) sup.lowStockCount += 1;
		if (item.status === 'overstock') sup.overstockCount += 1;
		sup.recommendedReorderQty += item.recommendedReorderQty;
		sup.skus.push(item.sku);
	}

	const healthScore =
		totalSkus === 0
			? 100
			: Math.max(
					0,
					Math.min(
						100,
						Math.round(
							((healthyCount * 100 + overstockCount * 65 + lowStockCount * 35) / totalSkus)
						)
					)
				);

	const pct = (count) => (totalSkus > 0 ? Math.round((count / totalSkus) * 100) : 0);

	return {
		generatedAt: new Date(nowMs).toISOString(),
		thresholds: {
			minReorderQty: MIN_REORDER_QTY,
			stagnantHours
		},
		summary: {
			totalSkus,
			totalUnits,
			totalReorderThresholdUnits,
			outOfStockCount,
			lowStockCount,
			healthyCount,
			overstockCount,
			stagnantCount,
			stagnantUnits,
			excessUnits,
			needsReorderCount: outOfStockCount + lowStockCount,
			totalRecommendedReorderQty,
			healthScore,
			averageCoverageRatio: totalSkus > 0 ? Number((coverageSum / totalSkus).toFixed(2)) : 0
		},
		distribution: [
			{ key: 'out_of_stock', label: 'Out of Stock', count: outOfStockCount, pct: pct(outOfStockCount) },
			{ key: 'low_stock', label: 'Low Stock', count: lowStockCount, pct: pct(lowStockCount) },
			{ key: 'healthy', label: 'Healthy', count: healthyCount, pct: pct(healthyCount) },
			{ key: 'overstock', label: 'Overstock / Excess', count: overstockCount, pct: pct(overstockCount) }
		],
		supplierSummary: Array.from(supplierMap.values()).sort(
			(a, b) => b.recommendedReorderQty - a.recommendedReorderQty || a.supplierEmail.localeCompare(b.supplierEmail)
		),
		items: analyzed
	};
}

module.exports = {
	MIN_REORDER_QTY,
	DEFAULT_STAGNANT_HOURS,
	parseCatalystTime,
	calculateReorderPlan,
	analyzeProductStock,
	buildStockAnalysis
};

