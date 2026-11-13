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
		box: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
		layers: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
		alert: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
		mail: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>'
	};

	function createProductManagerModule(options) {
		const container = options.container;
		const apiBase = options.apiBase;
		const fetcher = options.fetcher || (global.SmartAuth ? global.SmartAuth.authFetch : global.fetch.bind(global));
		const onProductsSync = options.onProductsSync;
		const onCapabilities = options.onCapabilities;
		const onSelectSkuForScan = options.onSelectSkuForScan;
		const onRequestAddSku = options.onRequestAddSku;

		const state = {
			products: [],
			search: '',
			statusFilter: 'all',
			editingSku: null,
			confirmDeleteSku: null,
			loading: false,
			saving: false,
			banner: null,
			draft: {
				sku: '',
				itemName: '',
				stockCount: '25',
				reorderLevel: '10',
				supplierEmail: ''
			}
		};

		function setBanner(type, message) {
			state.banner = { type, message };
		}

		function clearBanner() {
			state.banner = null;
		}

		function resetForm() {
			state.editingSku = null;
			state.draft = {
				sku: '',
				itemName: '',
				stockCount: '25',
				reorderLevel: '10',
				supplierEmail: ''
			};
		}

		function startEdit(sku) {
			const product = state.products.find((p) => p.sku === sku);
			if (!product) return;
			clearBanner();
			state.confirmDeleteSku = null;
			state.editingSku = product.sku;
			state.draft = {
				sku: product.sku,
				itemName: product.itemName,
				stockCount: String(product.stockCount),
				reorderLevel: String(product.reorderLevel),
				supplierEmail: product.supplierEmail
			};
			render();
			const nameInput = container.querySelector('#pmNameInput');
			if (nameInput) nameInput.focus();
		}

		function syncResponse(data) {
			if (Array.isArray(data.products)) {
				state.products = data.products;
				if (typeof onProductsSync === 'function') {
					onProductsSync(data.products);
				}
			}
			if (data.capabilities && typeof onCapabilities === 'function') {
				onCapabilities(data.capabilities);
			}
		}

		async function load(preserveBanner) {
			state.loading = true;
			if (!preserveBanner) clearBanner();
			render();
			try {
				const res = await fetcher(`${apiBase}/products`);
				if (res.status === 401) {
					throw new Error('Session expired or login required. Please sign in to manage catalog.');
				}
				const data = await res.json();
				if (!res.ok || !data.ok) {
					throw new Error(data.error || 'Failed to load catalog');
				}
				syncResponse(data);
			} catch (err) {
				setBanner('error', err.message || 'Unable to load product catalog');
			} finally {
				state.loading = false;
				render();
			}
		}

		async function saveProduct(event) {
			event.preventDefault();
			clearBanner();

			const skuInputEl = container.querySelector('#pmSkuInput');
			const nameEl = container.querySelector('#pmNameInput');
			const stockEl = container.querySelector('#pmStockInput');
			const reorderEl = container.querySelector('#pmReorderInput');
			const emailEl = container.querySelector('#pmEmailInput');

			state.draft = {
				sku: (skuInputEl?.value || '').trim(),
				itemName: (nameEl?.value || '').trim(),
				stockCount: (stockEl?.value || '').trim(),
				reorderLevel: (reorderEl?.value || '').trim(),
				supplierEmail: (emailEl?.value || '').trim()
			};

			const isEditing = Boolean(state.editingSku);
			const endpoint = isEditing ? `${apiBase}/products/update` : `${apiBase}/products`;
			const payload = isEditing
				? {
						sku: state.editingSku,
						newSku: state.draft.sku,
						itemName: state.draft.itemName,
						stockCount: Number(state.draft.stockCount),
						reorderLevel: Number(state.draft.reorderLevel),
						supplierEmail: state.draft.supplierEmail
					}
				: {
						sku: state.draft.sku,
						itemName: state.draft.itemName,
						stockCount: Number(state.draft.stockCount),
						reorderLevel: Number(state.draft.reorderLevel),
						supplierEmail: state.draft.supplierEmail
					};

			state.saving = true;
			render();
			try {
				const res = await fetcher(endpoint, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload)
				});
				const data = await res.json();
				if (!res.ok || !data.ok) {
					throw new Error(data.error || 'Failed to save product');
				}
				syncResponse(data);
				if (isEditing) {
					setBanner(
						'success',
						`Updated SKU ${data.updated.sku} (${data.updated.itemName}). Stock: ${data.updated.stockCount}, Reorder <= ${data.updated.reorderLevel}.`
					);
				} else {
					setBanner(
						'success',
						`Created SKU ${data.created.sku} (${data.created.itemName}) with ${data.created.stockCount} units.`
					);
				}
				resetForm();
			} catch (err) {
				setBanner('error', err.message || 'Save failed');
			} finally {
				state.saving = false;
				render();
			}
		}

		async function removeProduct(sku) {
			clearBanner();
			state.saving = true;
			render();
			try {
				const res = await fetcher(`${apiBase}/products/delete`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ sku })
				});
				const data = await res.json();
				if (!res.ok || !data.ok) {
					throw new Error(data.error || 'Failed to delete product');
				}
				if (state.editingSku === sku) {
					resetForm();
				}
				state.confirmDeleteSku = null;
				syncResponse(data);
				setBanner('success', `Deleted SKU ${data.deleted.sku} (${data.deleted.itemName}).`);
			} catch (err) {
				setBanner('error', err.message || 'Delete failed');
			} finally {
				state.saving = false;
				render();
			}
		}

		function setProducts(products) {
			if (Array.isArray(products)) {
				state.products = products;
				if (!container.hidden) render();
			}
		}

		function getFilteredProducts() {
			const q = state.search.trim().toLowerCase();
			return state.products.filter((p) => {
				if (state.statusFilter === 'low' && p.stockCount > p.reorderLevel) return false;
				if (state.statusFilter === 'healthy' && p.stockCount <= p.reorderLevel) return false;
				if (!q) return true;
				return `${p.sku} ${p.itemName} ${p.supplierEmail}`.toLowerCase().includes(q);
			});
		}

		function updateThresholdHint() {
			const hintEl = container.querySelector('#pmThresholdHint');
			if (!hintEl) return;
			const stock = Number(state.draft.stockCount);
			const reorder = Number(state.draft.reorderLevel);
			if (!Number.isFinite(stock) || !Number.isFinite(reorder)) {
				hintEl.innerHTML = '';
				return;
			}
			const isLow = stock <= reorder;
			hintEl.innerHTML = `<span class="badge-status ${isLow ? 'low' : 'ok'}">${isLow ? 'Immediate Low-Stock Alert' : 'Above Reorder Threshold'}</span>`;
		}

		function render() {
			const isEditing = Boolean(state.editingSku);
			const filtered = getFilteredProducts();
			const totalUnits = state.products.reduce((sum, p) => sum + Number(p.stockCount || 0), 0);
			const lowCount = state.products.filter((p) => p.stockCount <= p.reorderLevel).length;
			const healthyCount = state.products.length - lowCount;
			const vendorCount = new Set(state.products.map((p) => p.supplierEmail).filter(Boolean)).size;

			container.innerHTML = `
				<div class="page-head-card">
					<div>
						<div class="eyebrow">Catalog Operations</div>
						<h2 class="dash-heading">Product Catalog &amp; SKU Directory</h2>
						<p class="dash-subtitle">Browse, filter, edit, or audit active 3-digit SKUs synced with Catalyst Data Store.</p>
					</div>
					<div class="dash-controls">
						<div class="search-wrap">
							<span class="search-icon" aria-hidden="true">${ICONS.search}</span>
							<input
								id="pmSearchInput"
								type="search"
								class="input-control dash-search has-icon"
								placeholder="Search SKU, product, vendor..."
								value="${escapeHtml(state.search)}"
							/>
						</div>
						<button type="button" id="pmRefreshBtn" class="btn btn-sm" ${state.loading ? 'disabled' : ''}>
							${ICONS.refresh}
							<span>${state.loading ? 'Syncing...' : 'Refresh'}</span>
						</button>
						<button type="button" id="pmGoAddSkuBtn" class="btn btn-sm btn-primary">+ Add New SKU</button>
					</div>
				</div>

				<section class="kpi-strip" aria-label="Catalog metrics">
					<div class="kpi-card">
						<div class="kpi-top">
							<div class="kpi-label">Total Catalog SKUs</div>
							<span class="kpi-icon info" aria-hidden="true">${ICONS.box}</span>
						</div>
						<div class="kpi-value">${state.products.length}</div>
						<div class="kpi-sub">Active products in Data Store</div>
					</div>
					<div class="kpi-card">
						<div class="kpi-top">
							<div class="kpi-label">Catalog Stock Units</div>
							<span class="kpi-icon ok" aria-hidden="true">${ICONS.layers}</span>
						</div>
						<div class="kpi-value">${totalUnits}</div>
						<div class="kpi-sub">Combined units across SKUs</div>
					</div>
					<div class="kpi-card">
						<div class="kpi-top">
							<div class="kpi-label">Low-Stock SKUs</div>
							<span class="kpi-icon ${lowCount > 0 ? 'warn' : 'ok'}" aria-hidden="true">${ICONS.alert}</span>
						</div>
						<div class="kpi-value ${lowCount > 0 ? 'warn' : ''}">${lowCount}</div>
						<div class="kpi-sub">At or below ReorderLevel</div>
					</div>
					<div class="kpi-card">
						<div class="kpi-top">
							<div class="kpi-label">Assigned Suppliers</div>
							<span class="kpi-icon info" aria-hidden="true">${ICONS.mail}</span>
						</div>
						<div class="kpi-value">${vendorCount}</div>
						<div class="kpi-sub">Unique replenishment contacts</div>
					</div>
				</section>

				${
					state.banner
						? `<div class="banner ${escapeHtml(state.banner.type)}" style="display:block;margin-bottom:16px;">${escapeHtml(state.banner.message)}</div>`
						: ''
				}

				${
					isEditing
						? `
						<section class="panel" style="margin-bottom:20px;" aria-labelledby="pmFormHeading">
							<div class="panel-head">
								<h3 id="pmFormHeading" class="panel-title">Edit SKU ${escapeHtml(state.editingSku)}</h3>
								<span class="panel-meta">EDIT MODE</span>
							</div>
							<div class="panel-body">
								<form id="pmForm">
									<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;">
										<div>
											<div class="field-label"><label for="pmSkuInput">SKU Code</label></div>
											<input id="pmSkuInput" class="input-control mono" type="text" inputmode="numeric" maxlength="3" value="${escapeHtml(state.draft.sku)}" required />
										</div>
										<div>
											<div class="field-label"><label for="pmNameInput">Product Name</label></div>
											<input id="pmNameInput" class="input-control" type="text" maxlength="255" value="${escapeHtml(state.draft.itemName)}" required />
										</div>
										<div>
											<div class="field-label"><label for="pmStockInput">Stock On Hand</label></div>
											<input id="pmStockInput" class="input-control" type="number" min="0" step="1" value="${escapeHtml(state.draft.stockCount)}" required />
										</div>
										<div>
											<div class="field-label"><label for="pmReorderInput">Reorder Level (&le;)</label></div>
											<input id="pmReorderInput" class="input-control" type="number" min="0" step="1" value="${escapeHtml(state.draft.reorderLevel)}" required />
										</div>
										<div>
											<div class="field-label"><label for="pmEmailInput">Supplier Email</label></div>
											<input id="pmEmailInput" class="input-control" type="email" maxlength="255" value="${escapeHtml(state.draft.supplierEmail)}" required />
										</div>
									</div>
									<div id="pmThresholdHint" style="margin-top:10px;"></div>
									<div class="pm-form-actions">
										<button id="pmSaveBtn" type="submit" class="btn btn-primary" ${state.saving ? 'disabled' : ''}>
											${state.saving ? 'Saving...' : 'Save SKU Changes'}
										</button>
										<button id="pmCancelEditBtn" type="button" class="btn">Cancel</button>
									</div>
								</form>
							</div>
						</section>
						`
						: ''
				}

				<section class="panel" aria-labelledby="pmCatalogHeading">
					<div class="panel-head dash-matrix-head">
						<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
							<h3 id="pmCatalogHeading" class="panel-title">Managed SKU Catalog</h3>
							<span class="panel-meta">${filtered.length} OF ${state.products.length} SKUs</span>
						</div>
						<div class="dash-filters" role="group" aria-label="Filter catalog status">
							<button type="button" class="chip pm-status-chip ${state.statusFilter === 'all' ? 'active' : ''}" data-status="all">All (${state.products.length})</button>
							<button type="button" class="chip pm-status-chip ${state.statusFilter === 'low' ? 'active' : ''}" data-status="low">Low Stock (${lowCount})</button>
							<button type="button" class="chip pm-status-chip ${state.statusFilter === 'healthy' ? 'active' : ''}" data-status="healthy">Healthy (${healthyCount})</button>
						</div>
					</div>
					<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th>SKU</th>
									<th>Product</th>
									<th class="num">On Hand</th>
									<th class="num">Reorder &le;</th>
									<th>Status</th>
									<th>Supplier</th>
									<th class="num">Actions</th>
								</tr>
							</thead>
							<tbody>
								${
									filtered.length
										? filtered
												.map((item) => {
													const isConfirming = state.confirmDeleteSku === item.sku;
													const isLow = item.stockCount <= item.reorderLevel;
													return `
													<tr class="${state.editingSku === item.sku ? 'pm-row-editing' : ''}">
														<td><span class="sku-pill mono">${escapeHtml(item.sku)}</span></td>
														<td><strong>${escapeHtml(item.itemName)}</strong></td>
														<td class="num mono"><strong>${item.stockCount}</strong></td>
														<td class="num mono">${item.reorderLevel}</td>
														<td>
															<span class="badge-status ${isLow ? 'low' : 'ok'}">
																${isLow ? 'Low Stock' : 'Healthy'}
															</span>
														</td>
														<td style="color:var(--muted);font-size:0.82rem;">${escapeHtml(item.supplierEmail)}</td>
														<td class="num">
															<div class="dash-row-actions">
																${
																	isConfirming
																		? `
																			<button type="button" class="btn btn-sm pm-btn-danger pm-confirm-del" data-sku="${escapeHtml(item.sku)}" ${state.saving ? 'disabled' : ''}>Confirm Delete</button>
																			<button type="button" class="btn btn-sm pm-cancel-del" data-sku="${escapeHtml(item.sku)}">Cancel</button>
																		`
																		: `
																			<button type="button" class="btn btn-sm pm-edit-btn" data-sku="${escapeHtml(item.sku)}">Edit</button>
																			<button type="button" class="btn btn-sm pm-del-btn" data-sku="${escapeHtml(item.sku)}">Delete</button>
																			<button type="button" class="btn btn-sm pm-scan-btn" data-sku="${escapeHtml(item.sku)}">Scan</button>
																		`
																}
															</div>
														</td>
													</tr>
												`;
												})
												.join('')
										: '<tr><td colspan="7" style="color:var(--muted);">No SKUs match the selected filter.</td></tr>'
								}
							</tbody>
						</table>
					</div>
				</section>
			`;

			updateThresholdHint();
			bindEvents();
		}

		function bindEvents() {
			const searchEl = container.querySelector('#pmSearchInput');
			if (searchEl) {
				searchEl.addEventListener('input', (e) => {
					const pos = e.target.selectionStart;
					state.search = e.target.value;
					render();
					const nextEl = container.querySelector('#pmSearchInput');
					if (nextEl) {
						nextEl.focus();
						if (typeof pos === 'number') nextEl.setSelectionRange(pos, pos);
					}
				});
			}

			const skuInputEl = container.querySelector('#pmSkuInput');
			if (skuInputEl) {
				skuInputEl.addEventListener('input', () => {
					skuInputEl.value = skuInputEl.value.replace(/\D/g, '').slice(0, 3);
					state.draft.sku = skuInputEl.value;
				});
			}

			const nameEl = container.querySelector('#pmNameInput');
			if (nameEl) nameEl.addEventListener('input', () => { state.draft.itemName = nameEl.value; });
			const stockEl = container.querySelector('#pmStockInput');
			if (stockEl) {
				stockEl.addEventListener('input', () => {
					state.draft.stockCount = stockEl.value;
					updateThresholdHint();
				});
			}
			const reorderEl = container.querySelector('#pmReorderInput');
			if (reorderEl) {
				reorderEl.addEventListener('input', () => {
					state.draft.reorderLevel = reorderEl.value;
					updateThresholdHint();
				});
			}
			const emailEl = container.querySelector('#pmEmailInput');
			if (emailEl) emailEl.addEventListener('input', () => { state.draft.supplierEmail = emailEl.value; });

			const formEl = container.querySelector('#pmForm');
			if (formEl) formEl.addEventListener('submit', saveProduct);

			const refreshEl = container.querySelector('#pmRefreshBtn');
			if (refreshEl) refreshEl.addEventListener('click', () => load(false));

			const goAddEl = container.querySelector('#pmGoAddSkuBtn');
			if (goAddEl) {
				goAddEl.addEventListener('click', () => {
					if (typeof onRequestAddSku === 'function') {
						onRequestAddSku();
					}
				});
			}

			container.querySelectorAll('.pm-status-chip').forEach((chip) => {
				chip.addEventListener('click', () => {
					state.statusFilter = chip.dataset.status || 'all';
					render();
				});
			});

			const cancelEditEl = container.querySelector('#pmCancelEditBtn');
			if (cancelEditEl) {
				cancelEditEl.addEventListener('click', () => {
					clearBanner();
					resetForm();
					render();
				});
			}

			container.querySelectorAll('.pm-edit-btn').forEach((btn) => {
				btn.addEventListener('click', () => startEdit(btn.dataset.sku));
			});

			container.querySelectorAll('.pm-del-btn').forEach((btn) => {
				btn.addEventListener('click', () => {
					clearBanner();
					state.confirmDeleteSku = btn.dataset.sku;
					render();
				});
			});

			container.querySelectorAll('.pm-cancel-del').forEach((btn) => {
				btn.addEventListener('click', () => {
					state.confirmDeleteSku = null;
					render();
				});
			});

			container.querySelectorAll('.pm-confirm-del').forEach((btn) => {
				btn.addEventListener('click', () => removeProduct(btn.dataset.sku));
			});

			container.querySelectorAll('.pm-scan-btn').forEach((btn) => {
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
			setProducts,
			getState: () => state
		};
	}

	global.ProductManagerModule = { create: createProductManagerModule };
})(window);
