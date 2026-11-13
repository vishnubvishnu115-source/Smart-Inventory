/**
 * SmartStock AI - Zoho Expense Integration Module
 * Connects directly to Zoho Expense via Catalyst Connection ('expense')
 */
(function (global) {
	'use strict';

	function escapeHtml(str) {
		return String(str ?? '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	function formatCurrency(amount, currency = 'INR') {
		const num = Number(amount || 0);
		try {
			return new Intl.NumberFormat('en-IN', {
				style: 'currency',
				currency: currency || 'INR',
				maximumFractionDigits: 2
			}).format(num);
		} catch {
			return `₹${num.toFixed(2)}`;
		}
	}

	function createExpenseModule(options) {
		const { container, apiFetch, API_BASE, getCurrentUser } = options;

		const state = {
			expenses: [],
			summary: null,
			categories: [],
			organizations: [],
			selectedOrgId: null,
			filterStatus: 'ALL',
			filterCategory: 'ALL',
			isLoading: false,
			error: null,
			showAddModal: false,
			isSubmitting: false
		};

		async function loadOrganizations() {
			try {
				const res = await apiFetch(`${API_BASE}/expenses/organizations`);
				const data = await res.json();
				if (data.ok && Array.isArray(data.organizations)) {
					state.organizations = data.organizations;
					if (data.organizations.length > 0 && !state.selectedOrgId) {
						state.selectedOrgId = data.organizations[0].organization_id;
					}
				}
			} catch (err) {
				console.warn('Failed to load organizations:', err);
			}
		}

		async function loadCategories() {
			if (!state.selectedOrgId && state.organizations.length === 0) return;
			try {
				const query = state.selectedOrgId ? `?organization_id=${state.selectedOrgId}` : '';
				const res = await apiFetch(`${API_BASE}/expenses/categories${query}`);
				const data = await res.json();
				if (data.ok && Array.isArray(data.expense_categories)) {
					state.categories = data.expense_categories;
				}
			} catch (err) {
				console.warn('Failed to load categories:', err);
			}
		}

		async function loadExpenses() {
			state.isLoading = true;
			state.error = null;
			render();

			try {
				await loadOrganizations();
				await loadCategories();

				const queryParams = new URLSearchParams();
				if (state.selectedOrgId) queryParams.append('organization_id', state.selectedOrgId);
				if (state.filterStatus !== 'ALL') queryParams.append('status', state.filterStatus);
				if (state.filterCategory !== 'ALL') queryParams.append('category_id', state.filterCategory);

				const [expRes, sumRes] = await Promise.all([
					apiFetch(`${API_BASE}/expenses?${queryParams.toString()}`),
					apiFetch(`${API_BASE}/expenses/summary${state.selectedOrgId ? `?organization_id=${state.selectedOrgId}` : ''}`)
				]);

				const expData = await expRes.json();
				const sumData = await sumRes.json();

				if (!expRes.ok || !expData.ok) {
					throw new Error(expData.error || 'Failed to load expense records from Zoho Expense.');
				}

				state.expenses = expData.expenses || [];
				if (sumData.ok && sumData.summary) {
					state.summary = sumData.summary;
				}
				if (expData.organization_id && !state.selectedOrgId) {
					state.selectedOrgId = expData.organization_id;
				}
			} catch (err) {
				state.error = err.message;
			} finally {
				state.isLoading = false;
				render();
			}
		}

		async function submitNewExpense(payload) {
			state.isSubmitting = true;
			render();
			try {
				const query = state.selectedOrgId ? `?organization_id=${state.selectedOrgId}` : '';
				const res = await apiFetch(`${API_BASE}/expenses${query}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload)
				});
				const data = await res.json();
				if (!res.ok || !data.ok) {
					throw new Error(data.error || 'Failed to record expense.');
				}
				state.showAddModal = false;
				await loadExpenses();
			} catch (err) {
				alert(`Error saving expense: ${err.message}`);
			} finally {
				state.isSubmitting = false;
				render();
			}
		}

		function render() {
			if (!container) return;

			if (state.isLoading && (!state.expenses || state.expenses.length === 0)) {
				container.innerHTML = `
					<div class="card" style="padding: 48px; text-align: center;">
						<div class="spinner" style="margin: 0 auto 16px auto;"></div>
						<div style="font-weight: 600; color: var(--ink);">Connecting to Zoho Expense...</div>
						<div style="font-size: 13px; color: var(--muted); margin-top: 6px;">Fetching synchronized expense records via Catalyst Connection</div>
					</div>
				`;
				return;
			}

			if (state.error) {
				container.innerHTML = `
					<div class="card" style="padding: 32px; border-left: 4px solid var(--danger);">
						<div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap;">
							<div>
								<div style="font-size: 16px; font-weight: 700; color: var(--danger-ink); margin-bottom: 6px;">
									Zoho Expense Sync Notice
								</div>
								<div style="font-size: 14px; color: var(--ink); margin-bottom: 12px;">
									${escapeHtml(state.error)}
								</div>
								<div style="font-size: 12px; color: var(--muted); line-height: 1.5;">
									Make sure your Zoho Expense organization exists and your Catalyst Connection <code>expense</code> has authorization for <code>ZohoExpense.expenses.ALL</code> or <code>ZohoExpense.fullaccess.all</code>.
								</div>
							</div>
							<button type="button" class="btn btn-secondary" id="btnRetryExpenses" style="white-space: nowrap;">
								Retry Sync
							</button>
						</div>
					</div>
				`;
				const retryBtn = container.querySelector('#btnRetryExpenses');
				if (retryBtn) retryBtn.addEventListener('click', () => loadExpenses());
				return;
			}

			const summary = state.summary || {
				totalAmount: state.expenses.reduce((acc, e) => acc + Number(e.bcy_total || e.amount || 0), 0),
				totalExpensesCount: state.expenses.length,
				currency: state.expenses[0]?.currency_code || 'INR',
				currency_id: state.expenses[0]?.currency_id || '4190897000000000064'
			};

			const filteredExpenses = state.expenses.filter((exp) => {
				if (state.filterStatus !== 'ALL' && exp.status !== state.filterStatus) return false;
				if (state.filterCategory !== 'ALL' && exp.category_id !== state.filterCategory) return false;
				return true;
			});

			let html = `
				<div style="display: flex; flex-direction: column; gap: 20px;">
					<!-- KPI Row -->
					<div class="kpi-strip" style="margin-bottom: 0;">
						<div class="kpi-card">
							<div class="kpi-label">Total Inventory Expenses</div>
							<div class="kpi-value">${formatCurrency(summary.totalAmount, summary.currency)}</div>
							<div class="kpi-sub">${summary.totalExpensesCount} recorded ledger items</div>
						</div>

						<div class="kpi-card">
							<div class="kpi-label">Active Organization</div>
							<div class="kpi-value" style="font-size: 1.25rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
								${escapeHtml(state.organizations[0]?.name || state.selectedOrgId || 'SIM')}
							</div>
							<div class="kpi-sub">Currency: ${escapeHtml(summary.currency)} (₹)</div>
						</div>

						<div class="kpi-card">
							<div class="kpi-label">Expense Categories</div>
							<div class="kpi-value">${state.categories.length || Object.keys(summary.categoryBreakdown || {}).length || 3}</div>
							<div class="kpi-sub">Restock, Freight &amp; Packaging</div>
						</div>

						<div class="kpi-card">
							<div class="kpi-label">Connection Status</div>
							<div style="display: flex; align-items: center; gap: 8px; margin-top: 8px;">
								<span style="display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--ok);"></span>
								<span style="font-size: 0.95rem; font-weight: 700; color: var(--ok-ink);">Connected</span>
							</div>
							<div class="kpi-sub">OAuth Link: expense &middot; DC: .in</div>
						</div>
					</div>

					<!-- Toolbar & Table Card -->
					<div class="panel">
						<div class="panel-head" style="flex-wrap: wrap; gap: 12px;">
							<div style="display: flex; align-items: center; gap: 10px;">
								<h3 class="panel-title">Expense Ledger</h3>
								<span class="panel-meta">${filteredExpenses.length} Records</span>
							</div>

							<!-- Category & Status Filters -->
							<div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
								<select id="selExpenseCategoryFilter" class="input-control" style="width: auto; min-height: 34px; padding: 4px 10px; font-size: 0.8rem;">
									<option value="ALL">All Categories</option>
									${state.categories.map((c) => `
										<option value="${escapeHtml(c.category_id)}" ${state.filterCategory === c.category_id ? 'selected' : ''}>${escapeHtml(c.category_name)}</option>
									`).join('')}
								</select>

								<button type="button" class="btn btn-secondary btn-sm" id="btnRefreshExpenses" title="Sync with Zoho Expense">
									<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg>
									<span>Sync</span>
								</button>
								<button type="button" class="btn btn-primary btn-sm" id="btnOpenAddExpense">
									<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
									<span>Record Expense</span>
								</button>
							</div>
						</div>

						<div class="table-wrap">
							<table>
								<thead>
									<tr>
										<th>Date</th>
										<th>Merchant / Payee</th>
										<th>Category</th>
										<th>Status</th>
										<th class="num">Amount</th>
									</tr>
								</thead>
								<tbody>
									${filteredExpenses.length === 0 ? `
										<tr>
											<td colspan="5" style="padding: 40px; text-align: center; color: var(--muted); font-size: 0.85rem;">
												No expenses recorded yet. Click <strong>Record Expense</strong> to create your first entry in Zoho Expense.
											</td>
										</tr>
									` : filteredExpenses.map((exp) => {
										const stat = String(exp.status || 'unreported').toLowerCase();
										const statusClass = stat === 'approved' || stat === 'reimbursed'
											? 'badge-success'
											: stat === 'rejected'
											? 'badge-danger'
											: 'badge-info';
										return `
											<tr>
												<td class="mono" style="font-size: 0.82rem;">${escapeHtml(exp.date || '-')}</td>
												<td>
													<strong style="color: var(--ink);">${escapeHtml(exp.merchant_name || exp.description || 'Expense Item')}</strong>
													${exp.description && exp.merchant_name && exp.description !== exp.merchant_name ? `
														<div style="font-size: 0.76rem; color: var(--muted); margin-top: 2px;">${escapeHtml(exp.description)}</div>
													` : ''}
												</td>
												<td>
													<span class="badge badge-neutral">${escapeHtml(exp.category_name || '-')}</span>
												</td>
												<td>
													<span class="badge ${statusClass}" style="text-transform: capitalize;">${escapeHtml(exp.status || 'unreported')}</span>
												</td>
												<td class="num" style="font-weight: 700; color: var(--ink); font-size: 0.9rem;">
													${formatCurrency(exp.total || exp.amount, exp.currency_code)}
												</td>
											</tr>
										`;
									}).join('')}
								</tbody>
							</table>
						</div>
					</div>
				</div>

				<!-- Record Expense Modal -->
				${state.showAddModal ? `
					<div class="auth-modal-backdrop active" id="addExpenseBackdrop" style="z-index: 9999;">
						<div class="auth-modal-dialog" style="max-width: 500px;">
							<button type="button" class="auth-modal-close" id="btnCloseAddExpense" aria-label="Close dialog">&times;</button>

							<div style="display: flex; align-items: center; gap: 10px; margin-bottom: 6px;">
								<div style="width: 28px; height: 28px; border-radius: 7px; background: var(--primary); display: flex; align-items: center; justify-content: center; color: #fff;">
									<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>
								</div>
								<span style="font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--primary);">Zoho Expense Sync</span>
							</div>
							<h3 style="margin: 0 0 4px; font-size: 1.3rem; font-weight: 800; color: var(--ink);">Record Inventory Expense</h3>
							<p style="font-size: 0.82rem; color: var(--muted); margin: 0 0 18px;">Direct entry synchronized to Zoho Expense organization <strong>${escapeHtml(state.organizations[0]?.name || 'SIM')}</strong>.</p>

							<form id="formRecordExpense">
								<div style="display: flex; flex-direction: column; gap: 14px;">
									<div>
										<div class="field-label">
											<label for="expMerchant">Merchant / Supplier</label>
											<span class="field-hint">Payee name</span>
										</div>
										<input type="text" id="expMerchant" class="input-control" placeholder="e.g. Acme Supplies, FastFreight Logistics" required />
									</div>

									<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
										<div>
											<div class="field-label">
												<label for="expAmount">Amount (₹ INR)</label>
											</div>
											<input type="number" step="0.01" min="0.01" id="expAmount" class="input-control" placeholder="0.00" required />
										</div>
										<div>
											<div class="field-label">
												<label for="expDate">Date</label>
											</div>
											<input type="date" id="expDate" class="input-control" value="${new Date().toISOString().slice(0, 10)}" required />
										</div>
									</div>

									<div>
										<div class="field-label">
											<label for="expCategory">Expense Category</label>
											<span class="field-hint">Zoho Expense</span>
										</div>
										<select id="expCategory" class="input-control">
											${state.categories.length > 0 ? state.categories.map((c) => `
												<option value="${escapeHtml(c.category_id)}">${escapeHtml(c.category_name)}</option>
											`).join('') : `
												<option value="4190897000000034311">Inventory Restock &amp; Purchase</option>
												<option value="4190897000000038004">Freight &amp; Shipping Logistics</option>
												<option value="4190897000000039004">Packaging &amp; Barcode Supplies</option>
											`}
										</select>
									</div>

									<div>
										<div class="field-label">
											<label for="expDescription">Notes / Inventory Ref</label>
											<span class="field-hint">Optional</span>
										</div>
										<textarea id="expDescription" class="input-control" rows="2" placeholder="e.g. PO-2026-1102 restock batch, shipment fee, labels"></textarea>
									</div>

									<div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; padding-top: 14px; border-top: 1px solid var(--border);">
										<button type="button" class="btn btn-secondary" id="btnCancelAddExpense">Cancel</button>
										<button type="submit" class="btn btn-primary" ${state.isSubmitting ? 'disabled' : ''} style="min-width: 140px;">
											${state.isSubmitting ? 'Saving to Zoho...' : 'Save Expense'}
										</button>
									</div>
								</div>
							</form>
						</div>
					</div>
				` : ''}
			`;

			container.innerHTML = html;

			const refreshBtn = container.querySelector('#btnRefreshExpenses');
			if (refreshBtn) refreshBtn.addEventListener('click', () => loadExpenses());

			const catFilter = container.querySelector('#selExpenseCategoryFilter');
			if (catFilter) {
				catFilter.addEventListener('change', (e) => {
					state.filterCategory = e.target.value;
					render();
				});
			}

			const openAddBtn = container.querySelector('#btnOpenAddExpense');
			if (openAddBtn) {
				openAddBtn.addEventListener('click', () => {
					state.showAddModal = true;
					render();
				});
			}

			const closeAddBtn = container.querySelector('#btnCloseAddExpense');
			if (closeAddBtn) {
				closeAddBtn.addEventListener('click', () => {
					state.showAddModal = false;
					render();
				});
			}

			const cancelAddBtn = container.querySelector('#btnCancelAddExpense');
			if (cancelAddBtn) {
				cancelAddBtn.addEventListener('click', () => {
					state.showAddModal = false;
					render();
				});
			}

			const backdrop = container.querySelector('#addExpenseBackdrop');
			if (backdrop) {
				backdrop.addEventListener('click', (e) => {
					if (e.target === backdrop) {
						state.showAddModal = false;
						render();
					}
				});
			}

			const form = container.querySelector('#formRecordExpense');
			if (form) {
				form.addEventListener('submit', (e) => {
					e.preventDefault();
					const merchant = form.querySelector('#expMerchant').value.trim();
					const amount = parseFloat(form.querySelector('#expAmount').value);
					const date = form.querySelector('#expDate').value;
					const categoryId = form.querySelector('#expCategory').value;
					const description = form.querySelector('#expDescription').value.trim();

					submitNewExpense({
						merchant_name: merchant,
						amount: amount,
						date: date,
						category_id: categoryId || undefined,
						description: description,
						currency_id: state.summary?.currency_id || '4190897000000000064'
					});
				});
			}
		}

		return {
			load: loadExpenses,
			getState: () => state
		};
	}

	global.createExpenseModule = createExpenseModule;
})(typeof window !== 'undefined' ? window : this);
