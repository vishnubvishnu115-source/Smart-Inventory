(function (global) {
	'use strict';

	const SIGNED_OUT_FLAG = 'smartstock_signed_out';
	let unauthorizedHandler = null;
	let iframeBlurListenerAttached = false;

	function setUnauthorizedHandler(fn) {
		unauthorizedHandler = typeof fn === 'function' ? fn : null;
	}

	function waitForSdk(options = {}) {
		const timeoutMs = Number(options.timeoutMs) || 8000;
		const intervalMs = 100;
		const startedAt = Date.now();

		return new Promise((resolve, reject) => {
			function check() {
				const auth = global.catalyst && global.catalyst.auth;
				if (auth && typeof auth.isUserAuthenticated === 'function' && typeof auth.signIn === 'function') {
					resolve(global.catalyst);
					return;
				}
				if (Date.now() - startedAt >= timeoutMs) {
					reject(new Error('Catalyst Auth SDK did not initialize. Serve via Catalyst Slate or `catalyst serve`.'));
					return;
				}
				setTimeout(check, intervalMs);
			}
			check();
		});
	}

	function formatUser(content = {}) {
		const firstName = String(content.first_name || '').trim();
		const lastName = String(content.last_name || '').trim();
		const email = String(content.email_id || '').trim();
		const fullName = [firstName, lastName].filter(Boolean).join(' ') || email || 'App User';
		const initialsSource = (firstName ? firstName[0] : '') + (lastName ? lastName[0] : '') || email.slice(0, 2);
		const roleName = String(content.role_details?.role_name || 'App User').trim();

		return {
			userId: String(content.user_id || ''),
			email,
			firstName,
			lastName,
			fullName,
			initials: (initialsSource || 'AU').toUpperCase(),
			roleName
		};
	}

	async function checkSession() {
		if (global.sessionStorage && global.sessionStorage.getItem(SIGNED_OUT_FLAG) === '1') {
			return { authenticated: false, signedOut: true, user: null };
		}

		try {
			await waitForSdk();
			const result = await global.catalyst.auth.isUserAuthenticated();
			const content = result && (result.content || result);
			if (!content || !content.user_id) {
				return { authenticated: false, signedOut: false, user: null };
			}
			return {
				authenticated: true,
				signedOut: false,
				user: formatUser(content)
			};
		} catch (err) {
			return {
				authenticated: false,
				signedOut: false,
				user: null,
				error: err && err.message ? err.message : 'Not authenticated'
			};
		}
	}

	function bindIframeClearOnInteraction(containerEl) {
		if (!containerEl || iframeBlurListenerAttached) return;
		iframeBlurListenerAttached = true;

		const clearFlag = () => {
			try {
				global.sessionStorage.removeItem(SIGNED_OUT_FLAG);
			} catch {
				// Ignore storage errors
			}
		};

		containerEl.addEventListener('pointerdown', clearFlag, { passive: true });
		global.addEventListener('blur', () => {
			setTimeout(() => {
				if (document.activeElement && document.activeElement.tagName === 'IFRAME') {
					clearFlag();
				}
			}, 0);
		});
	}

	async function mountEmbeddedSignIn(containerId) {
		await waitForSdk();
		const containerEl = document.getElementById(containerId);
		if (!containerEl) {
			throw new Error(`Missing login container #${containerId}`);
		}
		containerEl.innerHTML = '';
		bindIframeClearOnInteraction(containerEl);
		global.catalyst.auth.signIn(containerId, {
			redirect_url: '/'
		});
	}

	function signOut() {
		try {
			// NOTE: On Catalyst Slate, frontend and backend run on separate origins;
			// signOut clears the client session while a backend IAM session may persist,
			// so this UI flag keeps the user locked at the Login Screen until next sign-in.
			global.sessionStorage.setItem(SIGNED_OUT_FLAG, '1');
		} catch {
			// Ignore storage errors
		}

		try {
			if (global.catalyst && global.catalyst.auth && typeof global.catalyst.auth.signOut === 'function') {
				global.catalyst.auth.signOut(global.location.origin);
				return;
			}
		} catch {
			// Fall back to full reload on SDK failure
		}
		global.location.reload();
	}

	async function getAuthHeaders() {
		const isLocal = global.location && (global.location.hostname === 'localhost' || global.location.hostname === '127.0.0.1');
		const auth = global.catalyst && global.catalyst.auth;
		if (!auth || typeof auth.generateAuthToken !== 'function') {
			return {};
		}
		try {
			const tokenRes = await auth.generateAuthToken();
			const token = tokenRes && tokenRes.access_token;
			if (!token) {
				if (isLocal) return {};
				throw new Error('Active Catalyst App User session token unavailable.');
			}
			return { Authorization: token };
		} catch (err) {
			if (isLocal) {
				// On local `catalyst serve`, ports 3001 and 3000 share localhost session cookies cleanly.
				return {};
			}
			if (unauthorizedHandler) unauthorizedHandler();
			throw err;
		}
	}

	async function authFetch(url, options = {}) {
		const authHeaders = await getAuthHeaders();
		const mergedHeaders = Object.assign({}, authHeaders, options.headers || {});
		const response = await global.fetch(url, Object.assign({}, options, {
			credentials: 'include',
			headers: mergedHeaders
		}));

		if (response.status === 401 && unauthorizedHandler) {
			unauthorizedHandler();
		}

		return response;
	}

	global.SmartAuth = {
		waitForSdk,
		checkSession,
		mountEmbeddedSignIn,
		signOut,
		authFetch,
		setUnauthorizedHandler
	};
})(window);
