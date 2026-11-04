'use strict';
function getConfig() {
  const url = (process.env.SUPABASE_URL || '').replace(/\\/+$/, '');
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

async function getScanState() {
  const rows = await supabaseRest('brickmen_drive_scan_state?select=*&id=eq.true&limit=1');
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}
async function saveScanState(state) {
  return supabaseRest('brickmen_drive_scan_state?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(Object.assign({ id: true, updated_at: new Date().toISOString() }, state))
  });
}
async function upsertDriveItems(files) {
  const now = new Date().toISOString();
  const records = (Array.isArray(files) ? files : []).map((file) => ({
    drive_file_id: String(file.id),
    name: String(file.name || 'Untitled'),
    mime_type: String(file.mimeType || 'application/octet-stream'),
    parent_ids: Array.isArray(file.parents) ? file.parents.map(String) : [],
    created_time: file.createdTime || null,
    modified_time: file.modifiedTime || null,
    web_view_link: file.webViewLink || null,
    thumbnail_link: file.thumbnailLink || null,
    size_bytes: file.size ? String(file.size) : null,
    md5_checksum: file.md5Checksum || null,
    description: file.description || null,
    drive_id: file.driveId || null,
    is_folder: file.mimeType === 'application/vnd.google-apps.folder',
    last_seen_at: now
  }));
  for (let index = 0; index < records.length; index += 100) {
    await supabaseRest('brickmen_drive_items?on_conflict=drive_file_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(records.slice(index, index + 100))
    });
  }
  return records.length;
}
async function buildDriveProjectCandidates() {
  return supabaseRest('rpc/brickmen_build_drive_project_candidates', {
    method: 'POST',
    body: '{}'
  });
}
async function listDriveProjectCandidates(limit) {
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const rows = await supabaseRest(
    'brickmen_drive_project_candidates?select=drive_folder_id,name,parent_folder_id,folder_path,earliest_file_created_at,direct_file_count,descendant_file_count,is_archived,ai_title,ai_description,ai_categories,ai_confidence,review_status&is_active=eq.true&order=earliest_file_created_at.desc.nullslast&limit=' + safeLimit
  );
  return Array.isArray(rows) ? rows : [];
}
module.exports = {
  getDriveConnection, saveDriveConnection, deleteDriveConnection,
  getScanState, saveScanState, upsertDriveItems,
  buildDriveProjectCandidates, listDriveProjectCandidates
};
