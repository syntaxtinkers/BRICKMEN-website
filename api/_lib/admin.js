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
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || '';
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!url || !publishableKey) {
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
  const allowed = String(process.env.BRICKMEN_ADMIN_EMAILS || '')
    .split(/[;,\n]/).map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (!email || !allowed.length || !allowed.includes(email)) {
    sendJson(res, 403, { error: 'This account is not authorised for Brickmen Studio administration.' });
    return null;
  }
  return user;
}
module.exports = { sendJson, parseCookies, methodNotAllowed, requireAdmin };