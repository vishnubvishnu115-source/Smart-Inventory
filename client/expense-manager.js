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
			isSubmitting: false,
			confirmDeleteId: null,
			isDeleting: false
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

		async function deleteExpenseRecord(identifier) {
			state.isDeleting = true;
			render();
			try {
				const query = state.selectedOrgId ? `?organization_id=${state.selectedOrgId}` : '';
				const res = await apiFetch(`${API_BASE}/expenses/delete${query}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ expenseId: identifier })
				});
				const data = await res.json();
				if (!res.ok || !data.ok) {
					throw new Error(data.error || 'Failed to delete expense.');
				}
				state.confirmDeleteId = null;
				await loadExpenses();
			} catch (err) {
				alert(`Failed to delete expense: ${err.message}`);
			} finally {
				state.isDeleting = false;
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

			const currentUser = getCurrentUser ? getCurrentUser() : null;

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
							<div class="kpi-label">Connection & Storage</div>
							<div style="display: flex; align-items: center; gap: 8px; margin-top: 8px;">
								<span style="display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--ok);"></span>
								<span style="font-size: 0.95rem; font-weight: 700; color: var(--ok-ink);">Connected &amp; Mirrored</span>
							</div>
							<div class="kpi-sub">Zoho API &middot; Catalyst Data Store (Expenses)</div>
						</div>
					</div>

					<!-- Toolbar & Table Card -->
					<div class="panel">
						<div class="panel-head" style="flex-wrap: wrap; gap: 12px;">
							<div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
								<h3 class="panel-title">Expense Ledger</h3>
								<span class="panel-meta">${filteredExpenses.length} Records</span>
								<span class="badge badge-success" style="font-size: 0.72rem; padding: 2px 8px;">Dual Synced: Zoho + Data Store</span>
							</div>

							<!-- Category & Status Filters -->
							<div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
								<select id="selExpenseCategoryFilter" class="input-control" style="width: auto; min-height: 34px; padding: 4px 10px; font-size: 0.8rem;">
									<option value="ALL">All Categories</option>
									${state.categories.map((c) => `
										<option value="${escapeHtml(c.category_id)}" ${state.filterCategory === c.category_id ? 'selected' : ''}>${escapeHtml(c.category_name)}</option>
									`).join('')}
								</select>

								<button type="button" class="btn btn-secondary btn-sm" id="btnRefreshExpenses" title="Sync with Zoho Expense and Data Store">
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
										<th>Date &amp; Ref</th>
										<th>Merchant / Payee</th>
										<th>Category &amp; Payment</th>
										<th>Submitter</th>
										<th>Status &amp; Storage</th>
										<th class="num">Amount</th>
										<th style="text-align: right; width: 100px;">Action</th>
									</tr>
								</thead>
								<tbody>
									${filteredExpenses.length === 0 ? `
										<tr>
											<td colspan="7" style="padding: 40px; text-align: center; color: var(--muted); font-size: 0.85rem;">
												No expenses recorded yet. Click <strong>Record Expense</strong> to create your first entry.
											</td>
										</tr>
									` : filteredExpenses.map((exp) => {
										const stat = String(exp.status || 'unreported').toLowerCase();
										const statusClass = stat === 'approved' || stat === 'reimbursed'
											? 'badge-success'
											: stat === 'rejected'
											? 'badge-danger'
											: 'badge-info';
										const refNum = exp.reference_number ? String(exp.reference_number).trim() : '';
										const paymentMode = exp.payment_mode || 'Cash';
										const paidThrough = exp.paid_through_account_name || 'Petty Cash';
										const submitter = exp.user_name || exp.created_by_name || 'Operator';
										const expenseDate = exp.date || exp.expense_date || '-';
										const expId = String(exp.expense_id || exp.ROWID || '');
										const isConfirming = state.confirmDeleteId === expId;

										return `
											<tr>
												<td class="mono" style="font-size: 0.82rem; white-space: nowrap;">
													<div>${escapeHtml(expenseDate)}</div>
													${refNum ? `<span class="badge badge-neutral" style="font-size: 0.68rem; margin-top: 3px; display: inline-block;">${escapeHtml(refNum)}</span>` : ''}
												</td>
												<td>
													<strong style="color: var(--ink);">${escapeHtml(exp.merchant_name || exp.description || 'Inventory Expense')}</strong>
													${exp.description && exp.merchant_name && exp.description !== exp.merchant_name ? `
														<div style="font-size: 0.76rem; color: var(--muted); margin-top: 2px;">${escapeHtml(exp.description)}</div>
													` : ''}
												</td>
												<td>
													<span class="badge badge-neutral">${escapeHtml(exp.category_name || '-')}</span>
													<div style="font-size: 0.74rem; color: var(--muted); margin-top: 3px;">
														${escapeHtml(paymentMode)} &middot; <span style="opacity: 0.85;">${escapeHtml(paidThrough)}</span>
													</div>
												</td>
												<td style="font-size: 0.82rem; color: var(--ink);">
													<div style="font-weight: 600;">${escapeHtml(submitter)}</div>
													<div style="font-size: 0.72rem; color: var(--muted);">${escapeHtml(exp.user_email || '')}</div>
												</td>
												<td>
													<div style="display: flex; flex-direction: column; gap: 3px; align-items: flex-start;">
														<span class="badge ${statusClass}" style="text-transform: capitalize;">${escapeHtml(exp.status || 'unreported')}</span>
														<span style="font-size: 0.68rem; color: var(--ok-ink); font-weight: 600; display: inline-flex; align-items: center; gap: 3px;">
															<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
															Data Store
														</span>
													</div>
												</td>
												<td class="num" style="font-weight: 700; color: var(--ink); font-size: 0.92rem; white-space: nowrap;">
													${formatCurrency(exp.total || exp.amount, exp.currency_code)}
												</td>
												<td style="text-align: right; white-space: nowrap;">
													${isConfirming ? `
														<div style="display: flex; gap: 4px; justify-content: flex-end; align-items: center;">
															<button type="button" class="btn btn-sm exp-btn-confirm-del" data-id="${escapeHtml(expId)}" ${state.isDeleting ? 'disabled' : ''} style="padding: 2px 8px; font-size: 0.72rem; line-height: 1.4; background: var(--danger); border-color: var(--danger); color: #fff;">Confirm</button>
															<button type="button" class="btn btn-sm btn-secondary exp-btn-cancel-del" style="padding: 2px 6px; font-size: 0.72rem; line-height: 1.4;" title="Cancel">&times;</button>
														</div>
													` : `
														<button type="button" class="btn btn-sm exp-btn-del" data-id="${escapeHtml(expId)}" title="Delete expense from Zoho Expense and Catalyst Data Store" style="padding: 3px 8px; font-size: 0.75rem; color: var(--danger-ink); border: 1px solid transparent; background: transparent; cursor: pointer; border-radius: 4px;">
															<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -1px; margin-right: 2px;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
															<span>Delete</span>
														</button>
													`}
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
						<div class="auth-modal-dialog" style="max-width: 540px;">
							<button type="button" class="auth-modal-close" id="btnCloseAddExpense" aria-label="Close dialog">&times;</button>

							<div style="display: flex; align-items: center; gap: 10px; margin-bottom: 6px;">
								<div style="width: 28px; height: 28px; border-radius: 7px; background: var(--primary); display: flex; align-items: center; justify-content: center; color: #fff;">
									<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>
								</div>
								<span style="font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--primary);">Zoho + Catalyst Data Store Sync</span>
							</div>
							<h3 style="margin: 0 0 4px; font-size: 1.3rem; font-weight: 800; color: var(--ink);">Record Inventory Expense</h3>
							<p style="font-size: 0.82rem; color: var(--muted); margin: 0 0 14px;">Direct entry synchronized to Zoho Expense and mirrored into Catalyst Data Store (<code>Expenses</code> table).</p>

							<!-- Autoload Badges Banner -->
							<div style="background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 16px; font-size: 0.78rem;">
								<div style="font-weight: 700; color: var(--ink); margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
									<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
									Autoloaded Context
								</div>
								<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; color: var(--muted);">
									<div>&bull; Operator: <strong style="color:var(--ink);">${escapeHtml(currentUser ? (currentUser.fullName || currentUser.username) : 'Active User')}</strong></div>
									<div>&bull; Currency: <strong style="color:var(--ink);">INR (₹)</strong></div>
									<div>&bull; Initial Status: <strong style="color:var(--ink);">Unreported</strong></div>
									<div>&bull; Org: <strong style="color:var(--ink);">${escapeHtml(state.organizations[0]?.name || 'SIM')}</strong></div>
								</div>
							</div>

							<form id="formRecordExpense">
								<div style="display: flex; flex-direction: column; gap: 14px;">
									<div>
										<div class="field-label">
											<label for="expMerchant">Merchant / Supplier *</label>
											<span class="field-hint">Payee or supplier</span>
										</div>
										<input type="text" id="expMerchant" class="input-control" placeholder="e.g. Acme Hardware, FastFreight Logistics" required />
									</div>

									<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
										<div>
											<div class="field-label">
												<label for="expAmount">Amount (₹ INR) *</label>
											</div>
											<input type="number" step="0.01" min="0.01" id="expAmount" class="input-control" placeholder="0.00" required />
										</div>
										<div>
											<div class="field-label">
												<label for="expDate">Date *</label>
											</div>
											<input type="date" id="expDate" class="input-control" value="${new Date().toISOString().slice(0, 10)}" required />
										</div>
									</div>

									<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
										<div>
											<div class="field-label">
												<label for="expCategory">Category *</label>
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
												<label for="expRefNumber">PO / Ref Number</label>
												<span class="field-hint">Optional</span>
											</div>
											<input type="text" id="expRefNumber" class="input-control" placeholder="e.g. PO-2026-1102" />
										</div>
									</div>

									<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
										<div>
											<div class="field-label">
												<label for="expPaymentMode">Payment Mode</label>
											</div>
											<select id="expPaymentMode" class="input-control">
												<option value="Cash" selected>Cash</option>
												<option value="Card">Corporate Card</option>
												<option value="UPI">UPI Transfer</option>
												<option value="Net Banking">Net Banking / NEFT</option>
											</select>
										</div>
										<div>
											<div class="field-label">
												<label for="expPaidThrough">Paid Through</label>
											</div>
											<select id="expPaidThrough" class="input-control">
												<option value="Petty Cash" selected>Petty Cash</option>
												<option value="Employee Reimbursements">Employee Reimbursements</option>
											</select>
										</div>
									</div>

									<div>
										<div class="field-label">
											<label for="expDescription">Notes / Restock Details</label>
											<span class="field-hint">Optional</span>
										</div>
										<textarea id="expDescription" class="input-control" rows="2" placeholder="e.g. Restock batch for SKU 401, express courier handling"></textarea>
									</div>

									<div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; padding-top: 14px; border-top: 1px solid var(--border);">
										<button type="button" class="btn btn-secondary" id="btnCancelAddExpense">Cancel</button>
										<button type="submit" class="btn btn-primary" ${state.isSubmitting ? 'disabled' : ''} style="min-width: 160px;">
											${state.isSubmitting ? 'Saving Everywhere...' : 'Save & Mirror Expense'}
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
					const refNumber = form.querySelector('#expRefNumber')?.value.trim() || '';
					const paymentMode = form.querySelector('#expPaymentMode')?.value || 'Cash';
					const paidThrough = form.querySelector('#expPaidThrough')?.value || 'Petty Cash';
					const user = getCurrentUser ? getCurrentUser() : null;

					submitNewExpense({
						merchant_name: merchant,
						amount: amount,
						date: date,
						category_id: categoryId || undefined,
						description: description,
						reference_number: refNumber,
						payment_mode: paymentMode,
						paid_through_account_name: paidThrough,
						user_name: user ? (user.fullName || user.username) : 'Operator',
						user_email: user ? (user.email || '') : '',
						currency_id: state.summary?.currency_id || '4190897000000000064'
					});
				});
			}

			// Expense Delete Handlers
			container.querySelectorAll('.exp-btn-del').forEach((btn) => {
				btn.addEventListener('click', () => {
					state.confirmDeleteId = btn.dataset.id;
					render();
				});
			});

			container.querySelectorAll('.exp-btn-cancel-del').forEach((btn) => {
				btn.addEventListener('click', () => {
					state.confirmDeleteId = null;
					render();
				});
			});

			container.querySelectorAll('.exp-btn-confirm-del').forEach((btn) => {
				btn.addEventListener('click', () => {
					deleteExpenseRecord(btn.dataset.id);
				});
			});
		}

		return {
			load: loadExpenses,
			getState: () => state
		};
	}

	global.createExpenseModule = createExpenseModule;
})(typeof window !== 'undefined' ? window : this);
