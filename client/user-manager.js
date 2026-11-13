/**
 * SmartStock AI - User Management Module
 * Connects directly to the custom 'Users' Data Store table for user creation, roles, and status control.
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

	function createUserModule(options) {
		const { container, apiFetch, API_BASE, getCurrentUser, onUsersChanged } = options;

		const state = {
			users: [],
			filterRole: 'ALL',
			searchTerm: '',
			isLoading: false,
			error: null,
			editingUser: null,
			showCreateForm: false
		};

		async function loadUsers() {
			state.isLoading = true;
			state.error = null;
			render();
			try {
				const res = await apiFetch(`${API_BASE}/users`);
				if (res.status === 401) {
					throw new Error('Session expired or login required. Please sign in to view users.');
				}
				const data = await res.json();
				if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to load user list');
				state.users = data.users || [];
				if (onUsersChanged) onUsersChanged(state.users);
			} catch (err) {
				state.error = err.message;
			} finally {
				state.isLoading = false;
				render();
			}
		}

		async function saveUser(payload, isEdit = false) {
			const endpoint = isEdit ? `${API_BASE}/users/update` : `${API_BASE}/users/create`;
			const res = await apiFetch(endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			const data = await res.json();
			if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to save user');
			state.users = data.users || state.users;
			state.showCreateForm = false;
			state.editingUser = null;
			render();
			if (onUsersChanged) onUsersChanged(state.users);
			return data;
		}

		async function deleteUser(rowId) {
			if (!confirm('Are you sure you want to permanently remove this user account?')) return;
			try {
				const res = await apiFetch(`${API_BASE}/users/delete`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ rowId })
				});
				const data = await res.json();
				if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to delete user');
				state.users = data.users || state.users.filter((u) => u.rowId !== rowId);
				render();
				if (onUsersChanged) onUsersChanged(state.users);
			} catch (err) {
				alert('Delete failed: ' + err.message);
			}
		}

		async function toggleUserStatus(user) {
			const newStatus = user.status === 'Active' ? 'Inactive' : 'Active';
			try {
				await saveUser({ rowId: user.rowId, status: newStatus }, true);
			} catch (err) {
				alert('Status change failed: ' + err.message);
			}
		}

		function getFilteredUsers() {
			return state.users.filter((user) => {
				const roleMatches = state.filterRole === 'ALL' || user.role.toUpperCase() === state.filterRole.toUpperCase();
				if (!roleMatches) return false;
				if (!state.searchTerm) return true;
				const term = state.searchTerm.toLowerCase();
				return (
					user.username.toLowerCase().includes(term) ||
					user.fullName.toLowerCase().includes(term) ||
					user.email.toLowerCase().includes(term) ||
					user.role.toLowerCase().includes(term)
				);
			});
		}

		function render() {
			if (!container) return;

			const totalCount = state.users.length;
			const activeCount = state.users.filter((u) => u.status === 'Active').length;
			const adminCount = state.users.filter((u) => u.role === 'Admin').length;
			const opCount = state.users.filter((u) => u.role === 'Operator').length;
			const filtered = getFilteredUsers();

			const formHtml = (state.showCreateForm || state.editingUser) ? `
				<div class="user-form-panel panel" style="margin-bottom:20px;border:1.5px solid var(--primary);box-shadow:0 8px 24px -6px rgba(37,99,235,0.15);">
					<div class="panel-head" style="background:var(--surface-subtle);">
						<div style="display:flex;align-items:center;gap:8px;">
							<span class="user-role-badge ${state.editingUser ? 'role-manager' : 'role-admin'}">${state.editingUser ? 'EDIT USER' : 'NEW USER'}</span>
							<h3 class="panel-title">${state.editingUser ? `Edit Account: ${escapeHtml(state.editingUser.username)}` : 'Create New System User'}</h3>
						</div>
						<button type="button" id="umCancelFormBtn" class="btn btn-sm">Close</button>
					</div>
					<div class="panel-body">
						<form id="umUserForm">
							<input type="hidden" id="umRowId" value="${state.editingUser ? escapeHtml(state.editingUser.rowId) : ''}">
							<div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:16px;">
								<div>
									<div class="field-label">
										<label for="umUsername">Username</label>
										<span class="field-hint">Login handle</span>
									</div>
									<input id="umUsername" class="input-control" type="text" value="${state.editingUser ? escapeHtml(state.editingUser.username) : ''}" ${state.editingUser ? 'disabled style="background:var(--bg);cursor:not-allowed;"' : 'required'} placeholder="e.g. john.doe" />
								</div>
								<div>
									<div class="field-label">
										<label for="umFullName">Full Display Name</label>
									</div>
									<input id="umFullName" class="input-control" type="text" value="${state.editingUser ? escapeHtml(state.editingUser.fullName) : ''}" required placeholder="e.g. John Doe" />
								</div>
								<div>
									<div class="field-label">
										<label for="umEmail">Email Address</label>
									</div>
									<input id="umEmail" class="input-control" type="email" value="${state.editingUser ? escapeHtml(state.editingUser.email) : ''}" required placeholder="john@smartstock.local" />
								</div>
								<div>
									<div class="field-label">
										<label for="umPassword">${state.editingUser ? 'Reset Password' : 'Password'}</label>
										<span class="field-hint">${state.editingUser ? 'Leave blank to keep' : 'Min 4 characters'}</span>
									</div>
									<input id="umPassword" class="input-control" type="password" ${state.editingUser ? '' : 'required'} placeholder="${state.editingUser ? '••••••••' : 'Enter secure password'}" />
								</div>
								<div>
									<div class="field-label">
										<label for="umRole">System Role</label>
									</div>
									<select id="umRole" class="input-control">
										<option value="Operator" ${state.editingUser?.role === 'Operator' ? 'selected' : ''}>Operator (Barcode Scanning & Logs)</option>
										<option value="Manager" ${state.editingUser?.role === 'Manager' ? 'selected' : ''}>Manager (Stock Analysis & Restock)</option>
										<option value="Admin" ${state.editingUser?.role === 'Admin' ? 'selected' : ''}>Admin (Full Access & User Control)</option>
									</select>
								</div>
								<div>
									<div class="field-label">
										<label for="umStatus">Account Status</label>
									</div>
									<select id="umStatus" class="input-control">
										<option value="Active" ${(!state.editingUser || state.editingUser.status === 'Active') ? 'selected' : ''}>Active (Can Sign In)</option>
										<option value="Inactive" ${state.editingUser?.status === 'Inactive' ? 'selected' : ''}>Inactive (Blocked)</option>
									</select>
								</div>
							</div>
							<div style="display:flex;justify-content:flex-end;gap:10px;margin-top:18px;">
								<button type="button" id="umCancelBottomBtn" class="btn btn-sm">Cancel</button>
								<button type="submit" id="umSubmitBtn" class="btn btn-sm btn-primary">${state.editingUser ? 'Save Changes' : 'Create User Account'}</button>
							</div>
							<div id="umFormBanner" class="banner" role="status"></div>
						</form>
					</div>
				</div>
			` : '';

			container.innerHTML = `
				<div class="um-view-root">
					<!-- Header strip -->
					<div class="panel" style="margin-bottom:20px;border-left:4px solid var(--primary);">
						<div class="panel-body" style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;">
							<div>
								<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
									<span class="user-role-badge role-admin">DATA STORE USERS</span>
									<span class="panel-meta">NATIVE TABLE AUTH</span>
								</div>
								<h2 style="margin:0;font-size:1.15rem;font-weight:700;color:var(--ink);">User Directory &amp; Access Control</h2>
								<p style="margin:4px 0 0;font-size:0.82rem;color:var(--muted);">
									Manage user accounts for sign-in and permissions stored directly in the Catalyst <code>Users</code> table.
								</p>
							</div>
							<div style="display:flex;align-items:center;gap:10px;">
								<button type="button" id="umRefreshBtn" class="btn btn-sm">
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>
									Refresh
								</button>
								<button type="button" id="umAddUserBtn" class="btn btn-sm btn-primary">
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/></svg>
									+ Create New User
								</button>
							</div>
						</div>
					</div>

					<!-- KPI Summary Cards -->
					<div class="kpi-strip" style="margin-bottom:20px;">
						<div class="kpi-card">
							<div class="kpi-top">
								<div class="kpi-label">Total Users</div>
								<span class="kpi-icon info">👥</span>
							</div>
							<div class="kpi-value">${totalCount}</div>
							<div class="kpi-sub">Registered accounts</div>
						</div>
						<div class="kpi-card">
							<div class="kpi-top">
								<div class="kpi-label">Active Users</div>
								<span class="kpi-icon ok">✓</span>
							</div>
							<div class="kpi-value">${activeCount}</div>
							<div class="kpi-sub">Authorized for sign in</div>
						</div>
						<div class="kpi-card">
							<div class="kpi-top">
								<div class="kpi-label">Administrators</div>
								<span class="kpi-icon warn">🛡️</span>
							</div>
							<div class="kpi-value">${adminCount}</div>
							<div class="kpi-sub">Full system control</div>
						</div>
						<div class="kpi-card">
							<div class="kpi-top">
								<div class="kpi-label">Operators</div>
								<span class="kpi-icon info">📦</span>
							</div>
							<div class="kpi-value">${opCount}</div>
							<div class="kpi-sub">Scanner & warehouse team</div>
						</div>
					</div>

					<!-- Form Panel (if open) -->
					${formHtml}

					<!-- User Table Panel -->
					<div class="panel">
						<div class="panel-head" style="flex-wrap:wrap;gap:12px;">
							<div style="display:flex;align-items:center;gap:10px;">
								<h3 class="panel-title">System User Accounts</h3>
								<span class="panel-meta">${filtered.length} OF ${totalCount} USERS</span>
							</div>
							<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
								<input id="umSearchInput" class="input-control" type="text" placeholder="Search by name, username, email..." value="${escapeHtml(state.searchTerm)}" style="width:230px;min-height:34px;font-size:0.8rem;" />
								<div class="tabs-container" style="margin:0;">
									<button type="button" class="tab-chip ${state.filterRole === 'ALL' ? 'active' : ''}" data-role="ALL">All</button>
									<button type="button" class="tab-chip ${state.filterRole === 'ADMIN' ? 'active' : ''}" data-role="ADMIN">Admins</button>
									<button type="button" class="tab-chip ${state.filterRole === 'MANAGER' ? 'active' : ''}" data-role="MANAGER">Managers</button>
									<button type="button" class="tab-chip ${state.filterRole === 'OPERATOR' ? 'active' : ''}" data-role="OPERATOR">Operators</button>
								</div>
							</div>
						</div>

						<div class="table-wrap">
							<table>
								<thead>
									<tr>
										<th>User / Username</th>
										<th>Email Address</th>
										<th>System Role</th>
										<th>Account Status</th>
										<th>Created Date</th>
										<th style="text-align:right;">Actions</th>
									</tr>
								</thead>
								<tbody id="umUsersTableBody">
									${state.isLoading ? `
										<tr><td colspan="6" style="padding:28px;text-align:center;color:var(--muted);">Loading users from Catalyst Users table...</td></tr>
									` : state.error ? `
										<tr><td colspan="6" style="padding:28px;text-align:center;color:var(--danger-ink);font-weight:600;">Error: ${escapeHtml(state.error)}</td></tr>
									` : filtered.length === 0 ? `
										<tr><td colspan="6" style="padding:28px;text-align:center;color:var(--muted);">No users match the selected criteria.</td></tr>
									` : filtered.map((u) => {
										const initial = (u.fullName || u.username || 'U').charAt(0).toUpperCase();
										const roleClass = u.role === 'Admin' ? 'role-admin' : u.role === 'Manager' ? 'role-manager' : 'role-operator';
										const statusClass = u.status === 'Active' ? 'ok' : 'low';
										const dateStr = u.createdTime ? new Date(u.createdTime).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
										return `
											<tr>
												<td>
													<div style="display:flex;align-items:center;gap:10px;">
														<div class="user-avatar-sm" aria-hidden="true">${initial}</div>
														<div>
															<strong style="color:var(--ink);">${escapeHtml(u.fullName)}</strong>
															<div style="font-family:var(--mono);font-size:0.75rem;color:var(--muted);">@${escapeHtml(u.username)}</div>
														</div>
													</div>
												</td>
												<td style="color:var(--ink-2);font-size:0.83rem;">${escapeHtml(u.email)}</td>
												<td><span class="user-role-badge ${roleClass}">${escapeHtml(u.role)}</span></td>
												<td><span class="badge-status ${statusClass}">${escapeHtml(u.status)}</span></td>
												<td style="color:var(--muted);font-size:0.8rem;">${dateStr}</td>
												<td style="text-align:right;">
													<div style="display:inline-flex;align-items:center;gap:6px;">
														<button type="button" class="btn btn-sm um-edit-btn" data-rowid="${escapeHtml(u.rowId)}">Edit</button>
														<button type="button" class="btn btn-sm um-toggle-btn" data-rowid="${escapeHtml(u.rowId)}" title="Toggle Active/Inactive">
															${u.status === 'Active' ? 'Deactivate' : 'Activate'}
														</button>
														<button type="button" class="btn btn-sm um-delete-btn" data-rowid="${escapeHtml(u.rowId)}" style="color:var(--danger-ink);">Delete</button>
													</div>
												</td>
											</tr>
										`;
									}).join('')}
								</tbody>
							</table>
						</div>
					</div>
				</div>
			`;

			bindEvents();
		}

		function bindEvents() {
			const refreshBtn = container.querySelector('#umRefreshBtn');
			if (refreshBtn) refreshBtn.addEventListener('click', loadUsers);

			const addBtn = container.querySelector('#umAddUserBtn');
			if (addBtn) {
				addBtn.addEventListener('click', () => {
					state.showCreateForm = true;
					state.editingUser = null;
					render();
				});
			}

			const cancelBtn = container.querySelector('#umCancelFormBtn');
			if (cancelBtn) {
				cancelBtn.addEventListener('click', () => {
					state.showCreateForm = false;
					state.editingUser = null;
					render();
				});
			}

			const cancelBottomBtn = container.querySelector('#umCancelBottomBtn');
			if (cancelBottomBtn) {
				cancelBottomBtn.addEventListener('click', () => {
					state.showCreateForm = false;
					state.editingUser = null;
					render();
				});
			}

			const searchInput = container.querySelector('#umSearchInput');
			if (searchInput) {
				searchInput.addEventListener('input', (e) => {
					state.searchTerm = e.target.value.trim();
					render();
				});
			}

			container.querySelectorAll('.tab-chip[data-role]').forEach((btn) => {
				btn.addEventListener('click', () => {
					state.filterRole = btn.dataset.role;
					render();
				});
			});

			container.querySelectorAll('.um-edit-btn').forEach((btn) => {
				btn.addEventListener('click', () => {
					const rowId = btn.dataset.rowid;
					const user = state.users.find((u) => u.rowId === rowId);
					if (user) {
						state.editingUser = user;
						state.showCreateForm = false;
						render();
					}
				});
			});

			container.querySelectorAll('.um-toggle-btn').forEach((btn) => {
				btn.addEventListener('click', () => {
					const rowId = btn.dataset.rowid;
					const user = state.users.find((u) => u.rowId === rowId);
					if (user) toggleUserStatus(user);
				});
			});

			container.querySelectorAll('.um-delete-btn').forEach((btn) => {
				btn.addEventListener('click', () => {
					const rowId = btn.dataset.rowid;
					deleteUser(rowId);
				});
			});

			const form = container.querySelector('#umUserForm');
			if (form) {
				form.addEventListener('submit', async (e) => {
					e.preventDefault();
					const banner = container.querySelector('#umFormBanner');
					const submitBtn = container.querySelector('#umSubmitBtn');
					banner.className = 'banner';
					banner.textContent = '';

					const rowId = container.querySelector('#umRowId').value;
					const username = container.querySelector('#umUsername').value.trim();
					const fullName = container.querySelector('#umFullName').value.trim();
					const email = container.querySelector('#umEmail').value.trim();
					const password = container.querySelector('#umPassword').value.trim();
					const role = container.querySelector('#umRole').value;
					const status = container.querySelector('#umStatus').value;

					submitBtn.disabled = true;
					submitBtn.textContent = 'Saving User...';
					try {
						const isEdit = Boolean(rowId);
						const payload = isEdit
							? { rowId, fullName, email, role, status, ...(password ? { password } : {}) }
							: { username, fullName, email, password, role, status };

						await saveUser(payload, isEdit);
					} catch (err) {
						banner.className = 'banner error';
						banner.textContent = err.message;
						submitBtn.disabled = false;
						submitBtn.textContent = rowId ? 'Save Changes' : 'Create User Account';
					}
				});
			}
		}

		// Initial load only if token exists
		if (global.SmartAuth && global.SmartAuth.getToken()) {
			loadUsers();
		} else {
			render();
		}

		return {
			load: loadUsers,
			render,
			getState: () => state
		};
	}

	global.createUserModule = createUserModule;
})(window);
