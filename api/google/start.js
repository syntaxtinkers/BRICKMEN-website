'use strict';
const crypto = require('node:crypto');
const { sendJson, methodNotAllowed, requireAdmin } = require('../_lib/admin');
module.exports = async function googleStart(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireAdmin(req, res);
  if (!user) return;
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || '';
  if (!clientId || !redirectUri) return sendJson(res, 503, { error: 'Google OAuth client ID or callback URL is not configured yet.' });
  let callback;
  try { callback = new URL(redirectUri); } catch (_) { return sendJson(res, 503, { error: 'The Google callback URL is invalid.' }); }
  if (callback.protocol !== 'https:' || callback.pathname !== '/api/google/callback' || callback.search || callback.hash) {
    return sendJson(res, 503, { error: 'The Google callback URL must be the HTTPS /api/google/callback address.' });
  }
  const state = crypto.randomBytes(32).toString('hex');
  res.setHeader('Set-Cookie', 'brickmen_google_oauth_state=' + state + '; Path=/api/google; HttpOnly; Secure; SameSite=Lax; Max-Age=600');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile https://www.googleapis.com/auth/drive.readonly',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state
  });
  return sendJson(res, 200, { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString() });
};