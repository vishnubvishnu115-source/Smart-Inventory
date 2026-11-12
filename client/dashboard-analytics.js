(function (global) {
	'use strict';

	function escapeHtml(text) {
		return String(text ?? '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	const ICONS = {
		search: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
		refresh: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>',
		download: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>',
		shieldOk: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/></svg>',
		activity: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
		alert: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
		clock: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
		layers: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>'
	};

	function createDashboardModule(options) {
		const container = options.container;
		const apiBase = options.apiBase;
		const fetcher = options.fetcher || (global.SmartAuth ? global.SmartAuth.authFetch : global.fetch.bind(global));
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
			out_of_stock: '#dc2626',
			low_stock: '#d97706',
			healthy: '#059669',
			overstock: '#0f62fe'
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
				const res = await fetcher(url);
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

		function renderHealthDonut(distribution, summary) {
			const total = Math.max(1, summary.totalSkus || 0);
			const radius = 50;
			const circumference = 2 * Math.PI * radius;
			let offset = 0;

			const segments = (distribution || [])
				.filter((d) => d.count > 0)
				.map((d) => {
					const fraction = d.count / total;
					const segLen = Math.max(0, fraction * circumference - 3);
					const dashArray = `${segLen} ${circumference}`;
					const dashOffset = -offset;
					offset += fraction * circumference;
					return `<circle cx="64" cy="64" r="${radius}" fill="none" stroke="${DIST_COLORS[d.key] || '#059669'}" stroke-width="14" stroke-dasharray="${dashArray}" stroke-dashoffset="${dashOffset}" stroke-linecap="butt" />`;
				})
				.join('');

			return `
				<div class="donut-wrap">
					<svg class="donut-svg" viewBox="0 0 128 128" width="132" height="132" aria-label="Inventory health donut chart">
						<circle cx="64" cy="64" r="${radius}" fill="none" stroke="#eef2f7" stroke-width="14" />
						<g transform="rotate(-90 64 64)">${segments}</g>
						<text x="64" y="61" text-anchor="middle" class="donut-score">${summary.healthScore}%</text>
						<text x="64" y="77" text-anchor="middle" class="donut-sub">HEALTH</text>
					</svg>
					<div class="donut-legend">
						${(distribution || [])
							.map(
								(d) => `
								<div class="donut-legend-row">
									<span class="donut-legend-key"><i style="background:${DIST_COLORS[d.key]};"></i>${escapeHtml(d.label)}</span>
									<span class="donut-legend-val mono"><strong>${d.count}</strong> <span>(${d.pct}%)</span></span>
								</div>
							`
							)
							.join('')}
					</div>
				</div>
			`;
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
					const barColor = DIST_COLORS[item.status] || '#059669';
					return `
						<div class="cov-row">
							<div class="cov-label">
								<span class="sku-pill mono">${escapeHtml(item.sku)}</span>
								<span class="cov-name">${escapeHtml(item.itemName)}</span>
							</div>
							<div class="cov-track" title="On Hand: ${item.stockCount} | Reorder <= ${item.reorderLevel} | Target Par: ${item.targetPar}">
								<div class="cov-fill" style="width:${stockPct}%;background:${barColor};"></div>
								<span class="cov-marker" style="left:${reorderPct}%;" title="Reorder threshold: ${item.reorderLevel}"></span>
							</div>
							<div class="cov-meta mono"><strong>${item.stockCount}</strong> / ${item.targetPar}</div>
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
						<span class="watch-clear-icon" aria-hidden="true">${ICONS.shieldOk}</span>
						<div>
							<strong>Inventory flow is healthy</strong>
							<span>No SKUs have been idle for &ge; ${state.stagnantHours}h or holding stock above target par.</span>
						</div>
					</div>
				`;
			}
			return flagged
				.map((item) => {
					const reasons = [];
					if (item.isStagnant) reasons.push(`Idle for ${escapeHtml(item.movementLabel)}`);
					if (item.excessUnits > 0) reasons.push(`${item.excessUnits} units over par (${item.targetPar})`);
					return `
						<div class="watch-item">
							<div>
								<div class="watch-title"><span class="sku-pill mono">${escapeHtml(item.sku)}</span> ${escapeHtml(item.itemName)}</div>
								<div class="watch-sub">${reasons.join(' &bull; ')}</div>
							</div>
							<span class="badge-status ${item.status === 'overstock' ? 'info' : 'low'} mono">${item.stockCount} units</span>
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
					const initials = (sup.supplierEmail || 'SP').slice(0, 2).toUpperCase();
					return `
						<div class="sup-row">
							<div class="sup-left">
								<span class="sup-avatar">${escapeHtml(initials)}</span>
								<div class="sup-main">
									<div class="sup-email">${escapeHtml(sup.supplierEmail)}</div>
									<div class="sup-skus">SKUs ${sup.skus.map((s) => `<span class="mono">${escapeHtml(s)}</span>`).join(', ')} &middot; ${sup.totalUnits} on hand</div>
								</div>
							</div>
							<span class="badge-status ${needsOrder ? 'low' : 'ok'}">
								${needsOrder ? `Reorder +${sup.recommendedReorderQty}` : 'Balanced'}
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
				averageCoverageRatio: 0,
				healthyCount: 0
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
			const stuckTotal = summary.stagnantCount + summary.overstockCount;

			container.innerHTML = `
				<div class="page-head-card">
					<div>
						<div class="eyebrow">Operations Intelligence</div>
						<h2 class="dash-heading">Stock Health &amp; Stagnation Analytics</h2>
						<p class="dash-subtitle">Real-time threshold coverage, idle/stuck stock detection, and vendor replenishment priorities.</p>
					</div>
					<div class="dash-controls">
						<div class="search-wrap">
							<span class="search-icon" aria-hidden="true">${ICONS.search}</span>
							<input
								id="dashSearchInput"
								type="search"
								class="input-control dash-search has-icon"
								placeholder="Search SKU, product, vendor..."
								value="${escapeHtml(state.search)}"
							/>
						</div>
						<label class="dash-select-wrap">
							<span>Idle window</span>
							<select id="dashStagnantSelect" class="input-control dash-select">
								<option value="1" ${state.stagnantHours === 1 ? 'selected' : ''}>1 hour</option>
								<option value="6" ${state.stagnantHours === 6 ? 'selected' : ''}>6 hours</option>
								<option value="24" ${state.stagnantHours === 24 ? 'selected' : ''}>24 hours</option>
								<option value="168" ${state.stagnantHours === 168 ? 'selected' : ''}>7 days</option>
								<option value="720" ${state.stagnantHours === 720 ? 'selected' : ''}>30 days</option>
							</select>
						</label>
						<button type="button" id="dashRefreshBtn" class="btn btn-sm" ${state.loading ? 'disabled' : ''}>
							${ICONS.refresh}
							<span>${state.loading ? 'Analyzing...' : 'Refresh'}</span>
						</button>
						<button type="button" id="dashExportBtn" class="btn btn-sm btn-subtle-primary" ${!items.length ? 'disabled' : ''}>
							${ICONS.download}
							<span>Export CSV</span>
						</button>
					</div>
				</div>

				${state.error ? `<div class="banner error" style="display:block;margin-bottom:16px;">${escapeHtml(state.error)}</div>` : ''}

				<section class="kpi-strip" aria-label="Stock analysis metrics">
					<div class="kpi-card">
						<div class="kpi-top">
							<div class="kpi-label">Inventory Health</div>
							<span class="kpi-icon ${healthTone}" aria-hidden="true">${ICONS.activity}</span>
						</div>
						<div class="kpi-value ${healthTone}">${summary.healthScore}%</div>
						<div class="kpi-sub">${summary.healthyCount || 0} of ${summary.totalSkus} SKUs in optimal band</div>
					</div>
					<div class="kpi-card">
						<div class="kpi-top">
							<div class="kpi-label">Reorder Queue</div>
							<span class="kpi-icon ${summary.needsReorderCount > 0 ? 'warn' : 'ok'}" aria-hidden="true">${ICONS.alert}</span>
						</div>
						<div class="kpi-value ${summary.needsReorderCount > 0 ? 'warn' : ''}">${summary.needsReorderCount}</div>
						<div class="kpi-sub">${summary.totalRecommendedReorderQty} recommended order units</div>
					</div>
					<div class="kpi-card">
						<div class="kpi-top">
							<div class="kpi-label">Stuck &amp; Overstock</div>
							<span class="kpi-icon ${stuckTotal > 0 ? 'warn' : 'ok'}" aria-hidden="true">${ICONS.clock}</span>
						</div>
						<div class="kpi-value ${stuckTotal > 0 ? 'warn' : ''}">${stuckTotal}</div>
						<div class="kpi-sub">${summary.stagnantCount} idle &ge; ${state.stagnantHours}h &middot; ${summary.excessUnits} excess units</div>
					</div>
					<div class="kpi-card">
						<div class="kpi-top">
							<div class="kpi-label">Threshold Coverage</div>
							<span class="kpi-icon info" aria-hidden="true">${ICONS.layers}</span>
						</div>
						<div class="kpi-value">${summary.averageCoverageRatio}x</div>
						<div class="kpi-sub">Across ${summary.totalUnits} total units on hand</div>
					</div>
				</section>

				<div class="dash-grid">
					<section class="panel" aria-labelledby="coverageHeading">
						<div class="panel-head">
							<h3 id="coverageHeading" class="panel-title">Status Mix &amp; Par Coverage</h3>
							<span class="panel-meta">${items.length} SKUs</span>
						</div>
						<div class="panel-body">
							${renderHealthDonut(distribution, summary)}
							<hr class="divider" />
							<div class="cov-header">
								<span>SKU Stock vs Target Par</span>
								<span class="cov-legend-note"><i class="marker-dot"></i> Reorder threshold</span>
							</div>
							<div class="cov-list">
								${renderCoverageBars(items)}
							</div>
						</div>
					</section>

					<div class="right-stack">
						<section class="panel" aria-labelledby="stuckHeading">
							<div class="panel-head">
								<h3 id="stuckHeading" class="panel-title">Idle &amp; Excess Watchlist</h3>
								<span class="panel-meta">&ge; ${state.stagnantHours}H WINDOW</span>
							</div>
							<div class="panel-body">
								${renderStuckWatchlist(items)}
							</div>
						</section>

						<section class="panel" aria-labelledby="supplierHeading">
							<div class="panel-head">
								<h3 id="supplierHeading" class="panel-title">Vendor Replenishment Rollup</h3>
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
														<td><span class="sku-pill mono">${escapeHtml(item.sku)}</span></td>
														<td>
															<strong>${escapeHtml(item.itemName)}</strong>
															<div style="font-size:0.75rem;color:var(--muted);">${escapeHtml(item.supplierEmail)}</div>
														</td>
														<td class="num mono"><strong>${item.stockCount}</strong> / ${item.targetPar}</td>
														<td class="num mono">${item.coverageRatio}x</td>
														<td style="color:var(--ink-2);">${escapeHtml(item.movementLabel)}</td>
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
