'use strict';
function getConfig() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SECRET_KEY || '';
  if (!url || !key) throw new Error('Supabase backend configuration is incomplete.');
  return { url, key };
}
async function supabaseRest(path, options) {
  const config = getConfig();
  const response = await fetch(config.url + '/rest/v1/' + path, {
    method: (options && options.method) || 'GET',
    headers: Object.assign({
      apikey: config.key,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    }, (options && options.headers) || {}),
    body: options && options.body
  });
  if (!response.ok) throw new Error('Secure Drive connection storage failed (HTTP ' + response.status + ').');
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
async function getDriveConnection() {
  const rows = await supabaseRest('brickmen_google_drive_connection?select=id,connected_email,granted_scopes,connected_at,refresh_token_ciphertext,refresh_token_iv,refresh_token_tag&id=eq.true&limit=1');
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}
async function saveDriveConnection(record) {
  return supabaseRest('brickmen_google_drive_connection?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(record)
  });
}
async function deleteDriveConnection() {
  return supabaseRest('brickmen_google_drive_connection?id=eq.true', {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' }
  });
}
module.exports = { getDriveConnection, saveDriveConnection, deleteDriveConnection };