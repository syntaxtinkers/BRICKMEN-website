'use strict';
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
}
function parseCookies(header) {
  const result = {};
  String(header || '').split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index < 0) return;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) return;
    try { result[key] = decodeURIComponent(value); } catch (_) { result[key] = value; }
  });
  return result;
}
function methodNotAllowed(res, allowed) {
  res.setHeader('Allow', allowed.join(', '));
  sendJson(res, 405, { error: 'Method not allowed.' });
}
async function requireAdmin(req, res) {
  const url = (process.env.SUPABASE_URL || '').replace(/\\/+$/, '');
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || '';
  const serviceKey = process.env.SUPABASE_SECRET_KEY || '';
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer\\s+(.+)$/i);
  if (!url || !publishableKey || !serviceKey) {
    sendJson(res, 503, { error: 'Supabase server configuration is incomplete.' });
    return null;
  }
  if (!match) {
    sendJson(res, 401, { error: 'Please sign in to the Brickmen Studio.' });
    return null;
  }
  let response;
  try {
    response = await fetch(url + '/auth/v1/user', {
      method: 'GET',
      headers: { apikey: publishableKey, Authorization: 'Bearer ' + match[1] }
    });
  } catch (_) {
    sendJson(res, 502, { error: 'Unable to verify your studio session.' });
    return null;
  }
  if (!response.ok) {
    sendJson(res, 401, { error: 'Your studio session has expired. Please sign in again.' });
    return null;
  }
  let user;
  try { user = await response.json(); } catch (_) { user = null; }
  const email = String(user && user.email || '').trim().toLowerCase();
  const userId = String(user && user.id || '');
  if (!email || !userId) {
    sendJson(res, 403, { error: 'The signed-in account has no verified email identity.' });
    return null;
  }

  const bootstrapEmails = String(process.env.BRICKMEN_ADMIN_EMAILS || '')
    .split(/[;,\\n]/).map((item) => item.trim().toLowerCase()).filter(Boolean);
  let adminRecord = null;
  try {
    const lookup = await fetch(
      url + '/rest/v1/brickmen_studio_admins?select=role,is_active&user_id=eq.' + encodeURIComponent(userId) + '&limit=1',
      { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
    );
    if (lookup.ok) {
      const rows = await lookup.json();
      if (Array.isArray(rows) && rows.length && rows[0].is_active) adminRecord = rows[0];
    }
  } catch (_) {}

  // The existing environment allowlist remains the safe bootstrap path for the first owner.
  if (!adminRecord && bootstrapEmails.includes(email)) {
    try {
      const seed = await fetch(url + '/rest/v1/brickmen_studio_admins?on_conflict=user_id', {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: 'Bearer ' + serviceKey,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=representation'
        },
        body: JSON.stringify({ user_id: userId, email, role: 'owner', is_active: true })
      });
      if (seed.ok) {
        const rows = await seed.json();
        adminRecord = Array.isArray(rows) && rows.length ? rows[0] : { role: 'owner', is_active: true };
      }
    } catch (_) {}
    if (!adminRecord) adminRecord = { role: 'owner', is_active: true };
  }

  if (!adminRecord) {
    sendJson(res, 403, { error: 'This account is not authorised for Brickmen Studio administration.' });
    return null;
  }
  user.email = email;
  user.studio_role = adminRecord.role || 'admin';
  return user;
}
module.exports = { sendJson, parseCookies, methodNotAllowed, requireAdmin };