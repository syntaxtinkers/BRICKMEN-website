'use strict';
const crypto = require('node:crypto');
const { parseCookies } = require('../_lib/admin');
const { getDriveConnection, saveDriveConnection } = require('../_lib/drive-store');
const { encryptToken } = require('../_lib/token-crypto');
function redirect(res, base, status) {
  const target = new URL('/studio.html', base);
  target.searchParams.set('drive', status);
  res.statusCode = 302;
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Location', target.toString());
  res.setHeader('Set-Cookie', 'brickmen_google_oauth_state=; Path=/api/google; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  res.end();
}
function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}
module.exports = async function googleCallback(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405; res.setHeader('Allow', 'GET');
    res.setHeader('Cache-Control', 'no-store, max-age=0'); res.end('Method not allowed.'); return;
  }
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || '';
  let base = 'https://brickmen-website.vercel.app';
  try { if (redirectUri) base = new URL(redirectUri).origin; } catch (_) {}
  const query = req.query || {};
  if (query.error) return redirect(res, base, 'error');
  const cookieState = parseCookies(req.headers.cookie).brickmen_google_oauth_state;
  if (!safeEqual(query.state, cookieState) || !query.code) return redirect(res, base, 'state_error');
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
  if (!clientId || !clientSecret || !redirectUri) return redirect(res, base, 'server_config_error');
  try {
    const body = new URLSearchParams({
      code: String(query.code), client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirectUri, grant_type: 'authorization_code'
    });
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
    });
    if (!tokenResponse.ok) return redirect(res, base, 'token_error');
    const token = await tokenResponse.json();
    if (!token.access_token) return redirect(res, base, 'token_error');

    // Google's OAuth token response may omit "scope" when the granted scopes
    // are identical to those requested. Verify the effective scopes with
    // Google's token-info endpoint instead of treating an omitted field as denial.
    let scopeText = String(token.scope || '');
    if (!scopeText.trim()) {
      const infoUrl = new URL('https://oauth2.googleapis.com/tokeninfo');
      infoUrl.searchParams.set('access_token', token.access_token);
      const infoResponse = await fetch(infoUrl.toString(), { method: 'GET' });
      if (!infoResponse.ok) return redirect(res, base, 'scope_error');
      const tokenInfo = await infoResponse.json();
      scopeText = String(tokenInfo.scope || '');
    }
    const grantedScopes = scopeText.split(/\s+/).filter(Boolean);
    if (!grantedScopes.includes('https://www.googleapis.com/auth/drive.readonly')) {
      return redirect(res, base, 'scope_error');
    }
    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: 'Bearer ' + token.access_token }
    });
    const profile = profileResponse.ok ? await profileResponse.json() : {};
    let tokenFields;
    if (token.refresh_token) {
      tokenFields = encryptToken(token.refresh_token);
    } else {
      const prior = await getDriveConnection();
      if (!prior || !prior.refresh_token_ciphertext || !prior.refresh_token_iv || !prior.refresh_token_tag) {
        return redirect(res, base, 'refresh_token_missing');
      }
      tokenFields = {
        refresh_token_ciphertext: prior.refresh_token_ciphertext,
        refresh_token_iv: prior.refresh_token_iv,
        refresh_token_tag: prior.refresh_token_tag
      };
    }
    await saveDriveConnection(Object.assign({
      id: true,
      connected_email: String(profile.email || 'Google account connected').slice(0, 320),
      granted_scopes: grantedScopes,
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, tokenFields));
    return redirect(res, base, 'connected');
  } catch (_) {
    return redirect(res, base, 'save_error');
  }
};