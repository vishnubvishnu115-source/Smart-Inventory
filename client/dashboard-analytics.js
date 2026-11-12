(function (global) {
	'use strict';

	function escapeHtml(text) {
		return String(text ?? '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function createDashboardModule(options) {
		const container = options.container;
		const apiBase = options.apiBase;
		const onRestock = options.onRestock;
		const onSelectSkuForScan = options.onSelectSkuForScan;
		const onCapabilities = options.onCapabilities;
		const onProductsSync = options.onProductsSync;

		const state = {
			analysis: null,
			filter: 'all',
			search: '',
			stagnantHours: 24,
			loading: false,
			error: null
		};

		const DIST_COLORS = {
			out_of_stock: 'var(--danger)',
			low_stock: 'var(--warn)',
			healthy: 'var(--ok)',
			overstock: 'var(--primary)'
		};

		function statusBadgeClass(status) {
			if (status === 'out_of_stock') return 'danger';
			if (status === 'low_stock') return 'low';
			if (status === 'overstock') return 'info';
			return 'ok';
		}

		function matchesFilter(item) {
			const q = state.search.trim().toLowerCase();
			if (q) {
				const haystack = `${item.sku} ${item.itemName} ${item.supplierEmail}`.toLowerCase();
				if (!haystack.includes(q)) return false;
			}
			if (state.filter === 'reorder') return item.needsReorder;
			if (state.filter === 'stagnant') return item.isStagnant || item.status === 'overstock';
			if (state.filter === 'overstock') return item.status === 'overstock';
			if (state.filter === 'healthy') return item.status === 'healthy' && !item.isStagnant;
			return true;
		}

		function exportCsv() {
			if (!state.analysis || !Array.isArray(state.analysis.items)) return;
			const headers = [
				'SKU',
				'Product',
				'StockCount',
				'ReorderLevel',
				'TargetPar',
				'CoverageRatio',
				'Status',
				'IsStagnant',
				'HoursSinceMovement',
				'RecommendedReorderQty',
				'ExcessUnits',
				'SupplierEmail',
				'RecommendedAction'
			];
			const csvCell = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;
			const rows = state.analysis.items.map((item) =>
				[
					item.sku,
					item.itemName,
					item.stockCount,
					item.reorderLevel,
					item.targetPar,
					item.coverageRatio,
					item.statusLabel,
					item.isStagnant ? 'Yes' : 'No',
					item.hoursSinceMovement ?? '',
					item.recommendedReorderQty,
					item.excessUnits,
					item.supplierEmail,
					item.recommendedAction
				]
					.map(csvCell)
					.join(',')
			);
			const csv = [headers.join(','), ...rows].join('\r\n');
			const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = `stock-analysis-${new Date().toISOString().slice(0, 10)}.csv`;
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);
			URL.revokeObjectURL(url);
		}

		async function load() {
			state.loading = true;
			state.error = null;
			render();
			try {
				const url = `${apiBase}/stock-analysis?stagnantHours=${encodeURIComponent(state.stagnantHours)}`;
				const res = await fetch(url);
				const data = await res.json();
				if (!res.ok || !data.ok) {
					throw new Error(data.error || 'Failed to load stock analysis');
				}
				state.analysis = data.analysis;
				if (typeof onCapabilities === 'function' && data.capabilities) {
					onCapabilities(data.capabilities);
				}
				if (typeof onProductsSync === 'function' && Array.isArray(data.products)) {
					onProductsSync(data.products);
				}
			} catch (err) {
				state.error = err.message || 'Unable to fetch stock analysis';
			} finally {
				state.loading = false;
				render();
			}
		}

		function renderCoverageBars(items) {
			if (!items.length) {
				return '<div class="dash-empty">No SKUs available to plot coverage.</div>';
			}
			const maxScale = Math.max(
				...items.map((i) => Math.max(i.stockCount, i.targetPar, i.reorderLevel * 2, 20))
			);
			return items
				.map((item) => {
					const stockPct = Math.min(100, Math.round((item.stockCount / maxScale) * 100));
					const reorderPct = Math.min(98, Math.round((item.reorderLevel / maxScale) * 100));
					const barColor = DIST_COLORS[item.status] || 'var(--ok)';
					return `
						<div class="cov-row">
							<div class="cov-label">
								<span class="mono" style="font-weight:700;">${escapeHtml(item.sku)}</span>
								<span>${escapeHtml(item.itemName)}</span>
							</div>
							<div class="cov-track" title="On Hand: ${item.stockCount} | Reorder <= ${item.reorderLevel} | Target Par: ${item.targetPar}">
								<div class="cov-fill" style="width:${stockPct}%;background:${barColor};"></div>
								<span class="cov-marker" style="left:${reorderPct}%;" title="Reorder threshold: ${item.reorderLevel}"></span>
							</div>
							<div class="cov-meta mono">${item.stockCount} / ${item.targetPar}</div>
						</div>
					`;
				})
				.join('');
		}

		function renderStuckWatchlist(items) {
			const flagged = items.filter((item) => item.isStagnant || item.status === 'overstock');
			if (!flagged.length) {
				return `
					<div class="watch-clear">
						<strong>No stuck or overstocked SKUs detected</strong>
						<span>All inventory items moved within the ${state.stagnantHours}h window and remain at or below target par.</span>
					</div>
				`;
			}
			return flagged
				.map((item) => {
					const reasons = [];
					if (item.isStagnant) reasons.push(`No stock movement (${escapeHtml(item.movementLabel)})`);
					if (item.excessUnits > 0) reasons.push(`${item.excessUnits} units above target par (${item.targetPar})`);
					return `
						<div class="watch-item">
							<div>
								<div class="watch-title"><span class="mono">${escapeHtml(item.sku)}</span> &middot; ${escapeHtml(item.itemName)}</div>
								<div class="watch-sub">${reasons.join(' &bull; ')}</div>
							</div>
							<div class="watch-qty mono">${item.stockCount} units</div>
						</div>
					`;
				})
				.join('');
		}

		function renderSupplierRows(suppliers) {
			if (!suppliers.length) {
				return '<div class="dash-empty">No supplier records available.</div>';
			}
			return suppliers
				.map((sup) => {
					const needsOrder = sup.recommendedReorderQty > 0;
					return `
						<div class="sup-row">
							<div class="sup-main">
								<div class="sup-email">${escapeHtml(sup.supplierEmail)}</div>
								<div class="sup-skus">SKUs: ${sup.skus.map((s) => `<span class="mono">${escapeHtml(s)}</span>`).join(', ')} (${sup.totalUnits} units on hand)</div>
							</div>
							<span class="badge-status ${needsOrder ? 'low' : 'ok'}">
								${needsOrder ? `Order +${sup.recommendedReorderQty}` : 'Balanced'}
							</span>
						</div>
					`;
				})
				.join('');
		}

		function render() {
			const analysis = state.analysis;
			const summary = analysis?.summary || {
				totalSkus: 0,
				totalUnits: 0,
				needsReorderCount: 0,
				totalRecommendedReorderQty: 0,
				stagnantCount: 0,
				overstockCount: 0,
				excessUnits: 0,
				healthScore: 100,
				averageCoverageRatio: 0
			};
			const items = analysis?.items || [];
			const distribution = analysis?.distribution || [];
			const suppliers = analysis?.supplierSummary || [];
			const filteredItems = items.filter(matchesFilter);

			const filterCounts = {
				all: items.length,
				reorder: items.filter((i) => i.needsReorder).length,
				stagnant: items.filter((i) => i.isStagnant || i.status === 'overstock').length,
				overstock: items.filter((i) => i.status === 'overstock').length,
				healthy: items.filter((i) => i.status === 'healthy' && !i.isStagnant).length
			};

			const healthTone =
				summary.healthScore >= 80 ? 'ok' : summary.healthScore >= 55 ? 'warn' : 'danger';

			container.innerHTML = `
				<div class="dash-toolbar">
					<div>
						<h2 class="dash-heading">Stock Analysis Dashboard</h2>
						<p class="dash-subtitle">Real-time SKU health scoring, threshold coverage, idle/stuck detection, and supplier replenishment rollup.</p>
					</div>
					<div class="dash-controls">
						<input
							id="dashSearchInput"
							type="search"
							class="input-control dash-search"
							placeholder="Filter SKU, product, supplier..."
							value="${escapeHtml(state.search)}"
						/>
						<label class="dash-select-wrap">
							<span>Idle threshold</span>
							<select id="dashStagnantSelect" class="input-control dash-select">
								<option value="1" ${state.stagnantHours === 1 ? 'selected' : ''}>1 hour</option>
								<option value="6" ${state.stagnantHours === 6 ? 'selected' : ''}>6 hours</option>
								<option value="24" ${state.stagnantHours === 24 ? 'selected' : ''}>24 hours</option>
								<option value="168" ${state.stagnantHours === 168 ? 'selected' : ''}>7 days</option>
								<option value="720" ${state.stagnantHours === 720 ? 'selected' : ''}>30 days</option>
							</select>
						</label>
						<button type="button" id="dashRefreshBtn" class="btn btn-sm" ${state.loading ? 'disabled' : ''}>
							${state.loading ? 'Analyzing...' : 'Refresh Analysis'}
						</button>
						<button type="button" id="dashExportBtn" class="btn btn-sm" ${!items.length ? 'disabled' : ''}>
							Export CSV
						</button>
					</div>
				</div>

				${state.error ? `<div class="banner error" style="display:block;margin-bottom:16px;">${escapeHtml(state.error)}</div>` : ''}

				<section class="kpi-strip" aria-label="Stock analysis metrics">
					<div class="kpi-card">
						<div class="kpi-label">Inventory Health</div>
						<div class="kpi-value ${healthTone}">${summary.healthScore}%</div>
						<div class="kpi-sub">${summary.healthyCount || 0} of ${summary.totalSkus} SKUs in optimal band</div>
					</div>
					<div class="kpi-card">
						<div class="kpi-label">Replenishment Queue</div>
						<div class="kpi-value ${summary.needsReorderCount > 0 ? 'warn' : ''}">${summary.needsReorderCount}</div>
						<div class="kpi-sub">${summary.totalRecommendedReorderQty} units recommended to order</div>
					</div>
					<div class="kpi-card">
						<div class="kpi-label">Stuck / Idle &amp; Excess</div>
						<div class="kpi-value ${summary.stagnantCount + summary.overstockCount > 0 ? 'warn' : ''}">${summary.stagnantCount + summary.overstockCount}</div>
						<div class="kpi-sub">${summary.stagnantCount} idle &ge; ${state.stagnantHours}h &middot; ${summary.excessUnits} excess units</div>
					</div>
					<div class="kpi-card">
						<div class="kpi-label">Avg Threshold Coverage</div>
						<div class="kpi-value">${summary.averageCoverageRatio}x</div>
						<div class="kpi-sub">Across ${summary.totalUnits} total units on hand</div>
					</div>
				</section>

				<div class="dash-grid">
					<section class="panel" aria-labelledby="coverageHeading">
						<div class="panel-head">
							<h3 id="coverageHeading" class="panel-title">Stock Coverage vs Reorder Threshold</h3>
							<span class="panel-meta">${items.length} SKUs</span>
						</div>
						<div class="panel-body">
							<div class="dist-bar" aria-label="Stock status distribution">
								${distribution
									.filter((d) => d.count > 0)
									.map(
										(d) => `<span class="dist-seg" style="width:${Math.max(4, d.pct)}%;background:${DIST_COLORS[d.key]};" title="${escapeHtml(d.label)}: ${d.count} (${d.pct}%)"></span>`
									)
									.join('') || '<span class="dist-seg" style="width:100%;background:var(--border);"></span>'}
							</div>
							<div class="dist-legend">
								${distribution
									.map(
										(d) => `<span class="dist-item"><i style="background:${DIST_COLORS[d.key]};"></i>${escapeHtml(d.label)}: <strong>${d.count}</strong></span>`
									)
									.join('')}
							</div>
							<hr class="divider" />
							<div class="cov-list">
								${renderCoverageBars(items)}
							</div>
							<div class="cov-footnote">Vertical marker inside each track indicates <code>ReorderLevel</code>; right figure shows <code>On Hand / Target Par</code>.</div>
						</div>
					</section>

					<div class="right-stack">
						<section class="panel" aria-labelledby="stuckHeading">
							<div class="panel-head">
								<h3 id="stuckHeading" class="panel-title">Idle / Overstock Risk Monitor</h3>
								<span class="panel-meta">&ge; ${state.stagnantHours}H WINDOW</span>
							</div>
							<div class="panel-body">
								${renderStuckWatchlist(items)}
							</div>
						</section>

						<section class="panel" aria-labelledby="supplierHeading">
							<div class="panel-head">
								<h3 id="supplierHeading" class="panel-title">Supplier Replenishment Rollup</h3>
								<span class="panel-meta">${suppliers.length} VENDORS</span>
							</div>
							<div class="panel-body">
								${renderSupplierRows(suppliers)}
							</div>
						</section>
					</div>
				</div>

				<section class="panel" style="margin-top:20px;" aria-labelledby="matrixHeading">
					<div class="panel-head dash-matrix-head">
						<h3 id="matrixHeading" class="panel-title">SKU Stock Diagnostic Matrix</h3>
						<div class="dash-filters" role="group" aria-label="Filter analyzed SKUs">
							<button type="button" class="chip ${state.filter === 'all' ? 'active' : ''}" data-filter="all">All (${filterCounts.all})</button>
							<button type="button" class="chip ${state.filter === 'reorder' ? 'active' : ''}" data-filter="reorder">Needs Reorder (${filterCounts.reorder})</button>
							<button type="button" class="chip ${state.filter === 'stagnant' ? 'active' : ''}" data-filter="stagnant">Stuck / Idle (${filterCounts.stagnant})</button>
							<button type="button" class="chip ${state.filter === 'overstock' ? 'active' : ''}" data-filter="overstock">Overstock (${filterCounts.overstock})</button>
							<button type="button" class="chip ${state.filter === 'healthy' ? 'active' : ''}" data-filter="healthy">Healthy (${filterCounts.healthy})</button>
						</div>
					</div>
					<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th>SKU</th>
									<th>Product</th>
									<th class="num">On Hand / Par</th>
									<th class="num">Coverage</th>
									<th>Last Movement</th>
									<th>Status</th>
									<th>Recommended Action</th>
									<th class="num">Quick Actions</th>
								</tr>
							</thead>
							<tbody>
								${
									filteredItems.length
										? filteredItems
												.map(
													(item) => `
													<tr>
														<td class="mono"><strong>${escapeHtml(item.sku)}</strong></td>
														<td>
															<strong>${escapeHtml(item.itemName)}</strong>
															<div style="font-size:0.75rem;color:var(--muted);">${escapeHtml(item.supplierEmail)}</div>
														</td>
														<td class="num mono">${item.stockCount} / ${item.targetPar}</td>
														<td class="num mono">${item.coverageRatio}x</td>
														<td>${escapeHtml(item.movementLabel)}</td>
														<td>
															<span class="badge-status ${statusBadgeClass(item.status)}">${escapeHtml(item.statusLabel)}</span>
															${item.isStagnant ? '<span class="badge-status low" style="margin-left:4px;">Idle</span>' : ''}
														</td>
														<td style="font-size:0.82rem;color:var(--ink-2);">${escapeHtml(item.recommendedAction)}</td>
														<td class="num">
															<div class="dash-row-actions">
																<button type="button" class="btn btn-sm dash-restock-btn" data-sku="${escapeHtml(item.sku)}">+50</button>
																<button type="button" class="btn btn-sm dash-scan-btn" data-sku="${escapeHtml(item.sku)}">Scan</button>
															</div>
														</td>
													</tr>
												`
												)
												.join('')
										: '<tr><td colspan="8" style="color:var(--muted);">No SKUs match the selected filter.</td></tr>'
								}
							</tbody>
						</table>
					</div>
				</section>
			`;

			bindEvents();
		}

		function bindEvents() {
			const searchEl = container.querySelector('#dashSearchInput');
			if (searchEl) {
				searchEl.addEventListener('input', (e) => {
					const pos = e.target.selectionStart;
					state.search = e.target.value;
					render();
					const nextInput = container.querySelector('#dashSearchInput');
					if (nextInput) {
						nextInput.focus();
						if (typeof pos === 'number') nextInput.setSelectionRange(pos, pos);
					}
				});
			}

			const stagnantEl = container.querySelector('#dashStagnantSelect');
			if (stagnantEl) {
				stagnantEl.addEventListener('change', (e) => {
					state.stagnantHours = Number(e.target.value) || 24;
					load();
				});
			}

			const refreshEl = container.querySelector('#dashRefreshBtn');
			if (refreshEl) refreshEl.addEventListener('click', load);

			const exportEl = container.querySelector('#dashExportBtn');
			if (exportEl) exportEl.addEventListener('click', exportCsv);

			container.querySelectorAll('[data-filter]').forEach((btn) => {
				btn.addEventListener('click', () => {
					state.filter = btn.dataset.filter;
					render();
				});
			});

			container.querySelectorAll('.dash-restock-btn').forEach((btn) => {
				btn.addEventListener('click', async () => {
					if (typeof onRestock === 'function') {
						btn.disabled = true;
						await onRestock(btn.dataset.sku);
						await load();
					}
				});
			});

			container.querySelectorAll('.dash-scan-btn').forEach((btn) => {
				btn.addEventListener('click', () => {
					if (typeof onSelectSkuForScan === 'function') {
						onSelectSkuForScan(btn.dataset.sku);
					}
				});
			});
		}

		return {
			load,
			render,
			getState: () => state
		};
	}

	global.StockDashboardModule = { create: createDashboardModule };
})(window);
