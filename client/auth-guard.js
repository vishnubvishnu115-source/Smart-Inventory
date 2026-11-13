/**
 * SmartStock AI - Database-Backed Authentication Guard
 * Manages sessions and auth headers using the custom Data Store 'Users' table.
 * Fully independent of Catalyst native Application User invitation/captcha service.
 */
(function (global) {
	'use strict';

	const TOKEN_KEY = 'smart_auth_token';
	const USER_KEY = 'smart_auth_user';
	let unauthorizedHandler = null;

	function setUnauthorizedHandler(fn) {
		unauthorizedHandler = typeof fn === 'function' ? fn : null;
	}

	function getToken() {
		try {
			return global.localStorage ? global.localStorage.getItem(TOKEN_KEY) : null;
		} catch {
			return null;
		}
	}

	function setSession(token, user) {
		try {
			if (global.localStorage) {
				if (token) global.localStorage.setItem(TOKEN_KEY, token);
				if (user) global.localStorage.setItem(USER_KEY, JSON.stringify(user));
			}
		} catch {
			// Ignore storage errors
		}
	}

	function clearSession() {
		try {
			if (global.localStorage) {
				global.localStorage.removeItem(TOKEN_KEY);
				global.localStorage.removeItem(USER_KEY);
			}
		} catch {
			// Ignore storage errors
		}
	}

	function getStoredUser() {
		try {
			if (!global.localStorage) return null;
			const raw = global.localStorage.getItem(USER_KEY);
			return raw ? JSON.parse(raw) : null;
		} catch {
			return null;
		}
	}

	function formatUser(raw = {}) {
		const fullName = String(raw.fullName || raw.Username || raw.username || 'User').trim();
		const email = String(raw.email || raw.Email || '').trim();
		const username = String(raw.username || raw.Username || '').trim();
		const roleName = String(raw.role || raw.Role || 'Operator').trim();
		const initials = fullName
			.split(' ')
			.map((n) => n[0])
			.filter(Boolean)
			.join('')
			.slice(0, 2)
			.toUpperCase() || 'U';

		return {
			rowId: String(raw.rowId || raw.ROWID || ''),
			userId: String(raw.rowId || raw.ROWID || username),
			username,
			email,
			fullName,
			initials,
			roleName
		};
	}

	async function checkSession(apiBase) {
		const token = getToken();
		if (!token) {
			return { authenticated: false, user: null };
		}

		const cachedUser = getStoredUser();

		// Validate token with backend /me endpoint if apiBase provided
		if (apiBase) {
			try {
				const res = await global.fetch(`${apiBase}/me`, {
					headers: {
						'x-session-token': token,
						'x-smart-token': token
					}
				});
				if (res.ok) {
					const data = await res.json();
					if (data.ok && data.user) {
						const user = formatUser(data.user);
						setSession(token, user);
						return { authenticated: true, user };
					}
				}
				// If 401/invalid token, clear session
				clearSession();
				return { authenticated: false, user: null };
			} catch (err) {
				// If offline / network error but cached token exists, allow session
				if (cachedUser) {
					return { authenticated: true, user: formatUser(cachedUser) };
				}
			}
		}

		if (cachedUser) {
			return { authenticated: true, user: formatUser(cachedUser) };
		}
		return { authenticated: false, user: null };
	}

	async function signIn(apiBase, identifier, password) {
		const cleanId = String(identifier || '').trim();
		const cleanPass = String(password || '').trim();

		if (!cleanId || !cleanPass) {
			throw new Error('Please enter your username/email and password.');
		}

		const res = await global.fetch(`${apiBase}/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: cleanId, password: cleanPass })
		});

		const data = await res.json();
		if (!res.ok || !data.ok) {
			throw new Error(data.error || 'Authentication failed. Invalid username or password.');
		}

		const user = formatUser(data.user);
		setSession(data.token, user);
		return { ok: true, user, token: data.token, capabilities: data.capabilities };
	}

	async function signUp(apiBase, payload) {
		const res = await global.fetch(`${apiBase}/signup`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		});

		const data = await res.json();
		if (!res.ok || !data.ok) {
			throw new Error(data.error || 'Failed to create account.');
		}

		const user = formatUser(data.user);
		setSession(data.token, user);
		return { ok: true, user, token: data.token, capabilities: data.capabilities };
	}

	async function signOut(apiBase) {
		const token = getToken();
		clearSession();

		if (apiBase && token) {
			try {
				await global.fetch(`${apiBase}/logout`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'x-session-token': token,
						'x-smart-token': token
					}
				});
			} catch {
				// Best-effort logout
			}
		}

		if (unauthorizedHandler) {
			unauthorizedHandler();
		} else {
			global.location.reload();
		}
	}

	function getAuthHeaders() {
		const token = getToken();
		if (token) {
			return {
				'x-session-token': token,
				'x-smart-token': token
			};
		}
		return {};
	}

	async function authFetch(url, options = {}) {
		const authHeaders = getAuthHeaders();
		const mergedHeaders = Object.assign({}, authHeaders, options.headers || {});
		const fetchOptions = Object.assign({}, options, {
			headers: mergedHeaders
		});
		if (typeof location !== 'undefined' && location.protocol !== 'file:') {
			fetchOptions.credentials = 'include';
		}
		const response = await global.fetch(url, fetchOptions);

		if (response.status === 401) {
			clearSession();
			if (unauthorizedHandler) {
				unauthorizedHandler();
			}
		}

		return response;
	}

	global.SmartAuth = {
		checkSession,
		signIn,
		signUp,
		signOut,
		authFetch,
		getAuthHeaders,
		setUnauthorizedHandler,
		getToken,
		getStoredUser
	};
})(window);
