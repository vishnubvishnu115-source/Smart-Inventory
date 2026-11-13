'use strict';

const crypto = require('crypto');

const TABLE_NAME = 'Users';
const SESSION_SECRET = process.env.SESSION_SECRET || 'smart-inventory-custom-auth-2026';

function unwrapRows(rows) {
	return (rows || []).map((row) => row[TABLE_NAME] || row);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
	const hash = crypto.pbkdf2Sync(String(password), salt, 1000, 64, 'sha256').toString('hex');
	return { hash, salt };
}

function verifyPassword(password, storedHash, salt) {
	if (!storedHash || !salt || !password) return false;
	const computed = crypto.pbkdf2Sync(String(password), salt, 1000, 64, 'sha256').toString('hex');
	return computed === storedHash;
}

function generateSessionToken(user) {
	const payload = {
		rowId: String(user.ROWID || user.rowId),
		username: String(user.Username || user.username),
		email: String(user.Email || user.email),
		fullName: String(user.FullName || user.fullName),
		role: String(user.Role || user.role || 'Operator'),
		status: String(user.Status || user.status || 'Active'),
		exp: Date.now() + 7 * 24 * 3600 * 1000 // 7 days
	};
	const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
	const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
	return `${data}.${sig}`;
}

function verifySessionToken(token) {
	if (!token || typeof token !== 'string') return null;
	const parts = token.split('.');
	if (parts.length !== 2) return null;
	const [data, sig] = parts;
	const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
	if (sig !== expectedSig) return null;
	try {
		const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
		if (payload.exp && Date.now() > payload.exp) return null;
		return payload;
	} catch {
		return null;
	}
}

function formatUserRecord(item) {
	return {
		rowId: String(item.ROWID),
		username: String(item.Username),
		email: String(item.Email || ''),
		fullName: String(item.FullName || item.Username),
		role: String(item.Role || 'Operator'),
		status: String(item.Status || 'Active'),
		createdTime: item.CREATEDTIME || null,
		modifiedTime: item.MODIFIEDTIME || null
	};
}

async function listUsers(catalystApp) {
	try {
		const rows = await catalystApp
			.zcql()
			.executeZCQLQuery(
				`SELECT ROWID, Username, Email, FullName, Role, Status, CREATEDTIME, MODIFIEDTIME FROM ${TABLE_NAME} ORDER BY CREATEDTIME ASC`
			);
		return unwrapRows(rows).map(formatUserRecord);
	} catch (err) {
		console.error('Failed to list users from Data Store:', err.message);
		return [];
	}
}

async function findUserByUsernameOrEmail(catalystApp, identifier) {
	const clean = String(identifier || '').trim().replace(/['"\\]/g, '');
	if (!clean) return null;
	try {
		const rows = await catalystApp
			.zcql()
			.executeZCQLQuery(
				`SELECT ROWID, Username, Email, PasswordHash, Salt, FullName, Role, Status, CREATEDTIME, MODIFIEDTIME FROM ${TABLE_NAME} WHERE Username = '${clean}' OR Email = '${clean}'`
			);
		const items = unwrapRows(rows);
		return items.length > 0 ? items[0] : null;
	} catch (err) {
		console.error('Error finding user:', err.message);
		return null;
	}
}

async function findUserById(catalystApp, rowId) {
	const cleanId = String(rowId || '').trim().replace(/['"\\]/g, '');
	if (!cleanId) return null;
	try {
		const rows = await catalystApp
			.zcql()
			.executeZCQLQuery(
				`SELECT ROWID, Username, Email, PasswordHash, Salt, FullName, Role, Status, CREATEDTIME, MODIFIEDTIME FROM ${TABLE_NAME} WHERE ROWID = '${cleanId}'`
			);
		const items = unwrapRows(rows);
		return items.length > 0 ? items[0] : null;
	} catch (err) {
		console.error('Error finding user by ID:', err.message);
		return null;
	}
}

async function createUser(catalystApp, body) {
	const username = String(body.username || '').trim().toLowerCase();
	const email = String(body.email || '').trim().toLowerCase();
	const fullName = String(body.fullName || body.username || '').trim();
	const password = String(body.password || '').trim();
	const role = String(body.role || 'Operator').trim();
	const status = String(body.status || 'Active').trim();

	if (!username || username.length < 3 || !/^[a-zA-Z0-9_.-]+$/.test(username)) {
		return { status: 400, error: 'Username must be at least 3 characters and contain only letters, numbers, hyphens, and underscores.' };
	}
	if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		return { status: 400, error: 'A valid email address is required.' };
	}
	if (!password || password.length < 4) {
		return { status: 400, error: 'Password must be at least 4 characters.' };
	}
	if (!fullName) {
		return { status: 400, error: 'Full Name is required.' };
	}

	const existing = await findUserByUsernameOrEmail(catalystApp, username);
	if (existing) {
		return { status: 409, error: `Username "${username}" or email is already in use.` };
	}

	const { hash, salt } = hashPassword(password);

	const inserted = await catalystApp.datastore().table(TABLE_NAME).insertRow({
		Username: username,
		Email: email,
		FullName: fullName,
		PasswordHash: hash,
		Salt: salt,
		Role: role,
		Status: status
	});

	return {
		status: 201,
		created: formatUserRecord(inserted)
	};
}

async function updateUser(catalystApp, rowId, body) {
	const existing = await findUserById(catalystApp, rowId);
	if (!existing) {
		return { status: 404, error: 'User record not found.' };
	}

	const updatePayload = {
		ROWID: existing.ROWID,
		Email: body.email !== undefined ? String(body.email).trim().toLowerCase() : existing.Email,
		FullName: body.fullName !== undefined ? String(body.fullName).trim() : existing.FullName,
		Role: body.role !== undefined ? String(body.role).trim() : existing.Role,
		Status: body.status !== undefined ? String(body.status).trim() : existing.Status
	};

	if (body.password && String(body.password).trim().length >= 4) {
		const { hash, salt } = hashPassword(String(body.password).trim());
		updatePayload.PasswordHash = hash;
		updatePayload.Salt = salt;
	}

	await catalystApp.datastore().table(TABLE_NAME).updateRow(updatePayload);

	const refreshed = await findUserById(catalystApp, existing.ROWID);
	return {
		status: 200,
		user: formatUserRecord(refreshed)
	};
}

async function deleteUser(catalystApp, rowId) {
	const existing = await findUserById(catalystApp, rowId);
	if (!existing) {
		return { status: 404, error: 'User not found.' };
	}

	// Protect default admin from being deleted if only 1 admin remains
	if (existing.Username === 'admin') {
		const users = await listUsers(catalystApp);
		const admins = users.filter((u) => u.role === 'Admin');
		if (admins.length <= 1) {
			return { status: 400, error: 'Cannot delete the primary System Administrator.' };
		}
	}

	await catalystApp.datastore().table(TABLE_NAME).deleteRow(existing.ROWID);
	return {
		status: 200,
		deletedRowId: String(existing.ROWID)
	};
}

async function authenticateCredentials(catalystApp, usernameOrEmail, password) {
	const clean = String(usernameOrEmail || '').trim();
	if (!clean || !password) {
		return { status: 400, error: 'Username/Email and Password are required.' };
	}

	const user = await findUserByUsernameOrEmail(catalystApp, clean);
	if (!user) {
		return { status: 401, error: 'Invalid username or password.' };
	}

	if (user.Status && String(user.Status).toUpperCase() !== 'ACTIVE') {
		return { status: 403, error: 'Account is deactivated. Please contact an administrator.' };
	}

	const valid = verifyPassword(password, user.PasswordHash, user.Salt);
	if (!valid) {
		return { status: 401, error: 'Invalid username or password.' };
	}

	const userRecord = formatUserRecord(user);
	const token = generateSessionToken(userRecord);

	return {
		status: 200,
		token,
		user: userRecord
	};
}

function extractToken(req) {
	if (req.headers && req.headers['x-session-token']) {
		return String(req.headers['x-session-token']).trim();
	}
	if (req.headers && req.headers['x-smart-token']) {
		return String(req.headers['x-smart-token']).trim();
	}
	const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
	if (authHeader.startsWith('Bearer ')) {
		return authHeader.slice(7).trim();
	}
	return null;
}

module.exports = {
	TABLE_NAME,
	hashPassword,
	verifyPassword,
	listUsers,
	findUserByUsernameOrEmail,
	findUserById,
	createUser,
	updateUser,
	deleteUser,
	authenticateCredentials,
	generateSessionToken,
	verifySessionToken,
	extractToken
};
