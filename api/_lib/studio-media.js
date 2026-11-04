'use strict';
const { sendJson, methodNotAllowed, requireAdmin } = require('./admin');
const { getDriveConnection } = require('./drive-store');
const { decryptToken } = require('./token-crypto');

const base = () => (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const serviceKey = () => process.env.SUPABASE_SECRET_KEY || '';
async function db(path, method, body, prefer) {
  const response = await fetch(base() + '/rest/v1/' + path, {
    method: method || 'GET',
    headers: { apikey: serviceKey(), Authorization: 'Bearer ' + serviceKey(), 'Content-Type': 'application/json', Accept: 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const raw = await response.text(); let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (_) {}
  if (!response.ok) throw new Error(data && (data.message || data.details) || 'Media database request failed (HTTP ' + response.status + ').');
  return data;
}
function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (_) {} }
  return {};
}
async function accessToken() {
  const connection = await getDriveConnection();
  if (!connection) throw new Error('Connect Google Drive before browsing project photographs.');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID || '', client_secret: process.env.GOOGLE_CLIENT_SECRET || '', refresh_token: decryptToken(connection), grant_type: 'refresh_token' })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error('Google Drive could not refresh its connection. Reconnect Drive from Studio.');
  return data.access_token;
}
async function project(projectId) {
  const rows = await db('brickmen_projects?select=id,drive_folder_id,title&id=eq.' + encodeURIComponent(projectId) + '&limit=1');
  if (!Array.isArray(rows) || !rows.length) throw new Error('Project not found.');
  return rows[0];
}
async function descendants(rootId) {
  const seen = new Set([rootId]); const queue = [rootId]; const images = [];
  while (queue.length && seen.size < 5000) {
    const parent = queue.shift();
    const filter = encodeURIComponent('{' + parent + '}');
    const rows = await db('brickmen_drive_items?select=drive_file_id,name,mime_type,size_bytes,created_time,thumbnail_link,web_view_link,parent_ids&parent_ids=cs.' + filter + '&limit=1000');
    for (const item of Array.isArray(rows) ? rows : []) {
      if (item.mime_type === 'application/vnd.google-apps.folder') {
        if (!seen.has(item.drive_file_id)) { seen.add(item.drive_file_id); queue.push(item.drive_file_id); }
      } else if (String(item.mime_type || '').startsWith('image/')) images.push(item);
    }
  }
  return images.sort((a,b) => String(a.name).localeCompare(String(b.name)));
}
async function driveMedia(token, fileId) {
  const response = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media', { headers: { Authorization: 'Bearer ' + token } });
  if (!response.ok) throw new Error('Google Drive could not read this photograph (HTTP ' + response.status + ').');
  return response;
}
module.exports = async function studioMedia(req, res) {
  const user = await requireAdmin(req, res); if (!user) return;
  try {
    if (req.method === 'GET') {
      const projectId = String(req.query && req.query.projectId || '');
      if (!/^[0-9a-f-]{36}$/i.test(projectId)) return sendJson(res, 400, { error: 'A valid project ID is required.' });
      const p = await project(projectId);
      const [items, saved] = await Promise.all([
        descendants(p.drive_folder_id),
        db('brickmen_project_media?select=id,drive_file_id,file_name,mime_type,is_public,is_cover,is_hidden,private_storage_path,caption,alt_text,sort_order,media_category,project_id,crop,image_adjustments&project_id=eq.' + encodeURIComponent(projectId))
      ]);
      const byId = new Map((Array.isArray(saved) ? saved : []).map(x => [x.drive_file_id, x]));
      const previewId = String(req.query && req.query.preview || '');
      if (previewId) {
        if (!items.some(x => x.drive_file_id === previewId)) return sendJson(res, 404, { error: 'Photograph not found in this project folder.' });
        const token = await accessToken(); const image = await driveMedia(token, previewId);
        const bytes = Buffer.from(await image.arrayBuffer());
        res.statusCode = 200; res.setHeader('Content-Type', image.headers.get('content-type') || 'application/octet-stream');
        res.setHeader('Cache-Control', 'private, max-age=300'); res.setHeader('Content-Length', String(bytes.length)); return res.end(bytes);
      }
      return sendJson(res, 200, { photos: items.map(x => ({ ...x, selected: byId.has(x.drive_file_id), media: byId.get(x.drive_file_id) || null })) });
    }
    if (req.method !== 'POST') return methodNotAllowed(res, ['GET','POST']);
    const body = parseBody(req); const projectId = String(body.projectId || '');
    if (!/^[0-9a-f-]{36}$/i.test(projectId)) return sendJson(res, 400, { error: 'A valid project ID is required.' });
    const p = await project(projectId); const action = String(body.action || '');
    if (action === 'import' || action === 'import_batch') {
      const fileIds = action === 'import_batch' && Array.isArray(body.fileIds)
        ? body.fileIds.map(String).slice(0, 3)
        : [String(body.fileId || '')];
      if (!fileIds.length || fileIds.some(id => !id)) return sendJson(res, 400, { error: 'One or more photograph IDs are required.' });
      const items = await descendants(p.drive_folder_id);
      const token = await accessToken();
      const imported = [];
      for (const fileId of fileIds) {
        const item = items.find(x => x.drive_file_id === fileId);
        if (!item) throw new Error('A selected photograph is not inside this project folder.');
        if (Number(item.size_bytes || 0) > 50 * 1024 * 1024) { imported.push({ fileId, skipped: 'File exceeds the 50 MB image storage limit.' }); continue; }
        const source = await driveMedia(token, fileId);
        const bytes = Buffer.from(await source.arrayBuffer());
        const path = projectId + '/' + fileId;
        const upload = await fetch(base() + '/storage/v1/object/brickmen-studio-private/' + path, {
          method: 'POST', headers: { apikey: serviceKey(), Authorization: 'Bearer ' + serviceKey(), 'Content-Type': item.mime_type || source.headers.get('content-type') || 'application/octet-stream', 'x-upsert': 'true' }, body: bytes
        });
        if (!upload.ok) { const message = await upload.text(); throw new Error('Private image storage failed for "' + item.name + '": ' + message.slice(0,300)); }
        const rows = await db('brickmen_project_media?on_conflict=project_id,drive_file_id', 'POST', {
          project_id: projectId, drive_file_id: fileId, file_name: item.name, mime_type: item.mime_type,
          private_storage_path: path, source_created_time: item.created_time || null, is_public: false
        }, 'resolution=merge-duplicates,return=representation');
        imported.push({ fileId, media: Array.isArray(rows) ? rows[0] : null });
      }
      return sendJson(res, 200, { imported });
    }
    if (action === 'update') {
      const mediaId = String(body.mediaId || '');
      const patch = {};
      if (Object.prototype.hasOwnProperty.call(body,'caption')) patch.caption = String(body.caption || '').slice(0,500);
      if (Object.prototype.hasOwnProperty.call(body,'alt_text')) patch.alt_text = String(body.alt_text || '').slice(0,500);
      if (Object.prototype.hasOwnProperty.call(body,'media_category')) patch.media_category = String(body.media_category || '').slice(0,80);
      if (Object.prototype.hasOwnProperty.call(body,'sort_order')) patch.sort_order = Math.max(0, Math.min(10000, Number(body.sort_order)||0));
      if (Object.prototype.hasOwnProperty.call(body,'is_hidden')) patch.is_hidden = Boolean(body.is_hidden);
      if (Object.prototype.hasOwnProperty.call(body,'image_adjustments')) {
        const a = body.image_adjustments && typeof body.image_adjustments === 'object' ? body.image_adjustments : {};
        patch.image_adjustments = {
          brightness: Math.max(50, Math.min(150, Number(a.brightness) || 100)),
          contrast: Math.max(50, Math.min(150, Number(a.contrast) || 100)),
          saturation: Math.max(0, Math.min(200, Number(a.saturation) || 100)),
          grayscale: Math.max(0, Math.min(100, Number(a.grayscale) || 0)),
          blur: Math.max(0, Math.min(10, Number(a.blur) || 0))
        };
      }
      if (Object.prototype.hasOwnProperty.call(body,'crop')) {
        const crop = body.crop && typeof body.crop === 'object' ? body.crop : {};
        patch.crop = { x: 0, y: 0, width: 100, height: 100, fit: crop.fit === 'contain' ? 'contain' : 'cover' };
      }
      if (Object.prototype.hasOwnProperty.call(body,'is_cover')) {
        if (body.is_cover) await db('brickmen_project_media?project_id=eq.' + encodeURIComponent(projectId), 'PATCH', { is_cover: false });
        patch.is_cover = Boolean(body.is_cover);
        if (body.is_cover) await db('brickmen_projects?id=eq.' + encodeURIComponent(projectId), 'PATCH', { cover_media_id: mediaId });
      }
      if (Object.prototype.hasOwnProperty.call(body,'is_public')) {
        if (body.is_public) return sendJson(res, 409, { error: 'A private photograph must be copied to the public portfolio bucket before it can be marked public. This safety step is not enabled yet.' });
        patch.is_public = false;
      }
      if (!Object.keys(patch).length) return sendJson(res, 400, { error: 'No media changes supplied.' });
      patch.updated_at = new Date().toISOString();
      const rows = await db('brickmen_project_media?id=eq.' + encodeURIComponent(mediaId) + '&project_id=eq.' + encodeURIComponent(projectId), 'PATCH', patch, 'return=representation');
      if (!Array.isArray(rows) || !rows.length) return sendJson(res, 404, { error: 'Imported photograph not found.' });
      return sendJson(res, 200, { media: rows[0] });
    }
    return sendJson(res, 400, { error: 'Unsupported media action.' });
  } catch (error) {
    return sendJson(res, 503, { error: error && error.message ? error.message : 'Studio media service is unavailable.' });
  }
};
