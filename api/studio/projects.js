'use strict';
const { sendJson, methodNotAllowed, requireAdmin } = require('../_lib/admin');

const base = () => (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const key = () => process.env.SUPABASE_SECRET_KEY || '';

async function db(path, method, body, prefer) {
  const response = await fetch(base() + '/rest/v1/' + path, {
    method: method || 'GET',
    headers: {
      apikey: key(),
      Authorization: 'Bearer ' + key(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(prefer ? { Prefer: prefer } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) {}
  if (!response.ok) {
    const message = data && (data.message || data.details || data.hint);
    throw new Error(message || 'Portfolio database request failed (HTTP ' + response.status + ').');
  }
  return data;
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_) {}
  }
  return {};
}

async function listProjects() {
  const projects = await db('brickmen_projects?select=*&order=created_at.desc');
  const media = await db('brickmen_project_media?select=project_id,is_public,is_hidden,public_storage_path');
  const candidates = await db('brickmen_drive_project_candidates?select=drive_folder_id,folder_path,name');
  const candidateByFolder = {};
  (Array.isArray(candidates) ? candidates : []).forEach((item) => { candidateByFolder[item.drive_folder_id] = item; });
  const counts = {};
  (Array.isArray(media) ? media : []).forEach((item) => {
    const entry = counts[item.project_id] || { total: 0, public: 0 };
    entry.total += 1;
    if (item.is_public && !item.is_hidden && item.public_storage_path) entry.public += 1;
    counts[item.project_id] = entry;
  });
  return (Array.isArray(projects) ? projects : []).map((project) => {
    const view = { ...project };
    const draft = project.draft_content && typeof project.draft_content === 'object' ? project.draft_content : {};
    ['title','location','category','project_year','start_date','description','visibility'].forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(draft, field)) view[field] = draft[field];
    });
    return {
      ...view,
      folder_path: (candidateByFolder[project.drive_folder_id] || {}).folder_path || '',
      media_count: (counts[project.id] || {}).total || 0,
      public_media_count: (counts[project.id] || {}).public || 0
    };
  });
}

module.exports = async function studioProjects(req, res) {
  const user = await requireAdmin(req, res);
  if (!user) return;

  try {
    if (req.method === 'GET') {
      const projects = await listProjects();
      return sendJson(res, 200, { projects });
    }
    if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

    const body = parseBody(req);
    const action = String(body.action || '');

    if (action === 'sync_candidates') {
      const result = await db('rpc/brickmen_sync_candidates_to_projects', 'POST', {});
      const projects = await listProjects();
      return sendJson(res, 200, {
        synced: Number(result || 0),
        total: projects.length,
        projects
      });
    }

    const projectId = String(body.projectId || '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
      return sendJson(res, 400, { error: 'A valid project ID is required.' });
    }

    if (action === 'save') {
      const patch = {};
      const fields = ['title', 'location', 'category', 'description'];
      fields.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(body, field)) {
          patch[field] = field === 'title' ? String(body[field] || '').trim().slice(0, 180) :
            String(body[field] || '').trim().slice(0, field === 'description' ? 12000 : 240);
        }
      });
      if (Object.prototype.hasOwnProperty.call(body, 'project_year')) {
        const year = body.project_year === '' || body.project_year === null ? null : Number(body.project_year);
        if (year !== null && (!Number.isInteger(year) || year < 1900 || year > 2200)) {
          return sendJson(res, 400, { error: 'Enter a valid project year.' });
        }
        patch.project_year = year;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'start_date')) {
        const date = body.start_date ? String(body.start_date) : null;
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'Enter a valid project start date.' });
        patch.start_date = date;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'visibility')) {
        const allowed = ['title', 'location', 'category', 'project_year', 'start_date', 'description'];
        const visibility = {};
        if (!body.visibility || typeof body.visibility !== 'object' || Array.isArray(body.visibility)) {
          return sendJson(res, 400, { error: 'Project visibility settings are invalid.' });
        }
        allowed.forEach((field) => {
          if (Object.prototype.hasOwnProperty.call(body.visibility, field)) {
            visibility[field] = Boolean(body.visibility[field]);
          }
        });
        patch.visibility = visibility;
      }
      if (patch.title !== undefined && !patch.title) return sendJson(res, 400, { error: 'Project title cannot be empty.' });
      if (!Object.keys(patch).length) return sendJson(res, 400, { error: 'There are no changes to save.' });
      const currentRows = await db('brickmen_projects?select=id,draft_content&id=eq.' + encodeURIComponent(projectId) + '&limit=1');
      if (!Array.isArray(currentRows) || !currentRows.length) return sendJson(res, 404, { error: 'Project not found.' });
      const draftContent = Object.assign({}, currentRows[0].draft_content || {}, patch);
      delete draftContent.updated_at;
      const rows = await db('brickmen_projects?id=eq.' + encodeURIComponent(projectId), 'PATCH', {
        draft_content: draftContent,
        updated_at: new Date().toISOString()
      }, 'return=representation');
      if (!Array.isArray(rows) || !rows.length) return sendJson(res, 404, { error: 'Project not found.' });
      return sendJson(res, 200, { project: rows[0], savedAsDraft: true });
    }

    if (action === 'publish') {
      // Publishing is the explicit approval gate: copy every imported, visible image
      // from private review storage to the public portfolio bucket.
      const projectMedia = await db('brickmen_project_media?select=id,drive_file_id,file_name,mime_type,private_storage_path,public_storage_path,is_hidden&project_id=eq.' + encodeURIComponent(projectId));
      let prepared = 0;
      for (const item of (Array.isArray(projectMedia) ? projectMedia : [])) {
        if (item.is_hidden) continue;
        if (item.public_storage_path) {
          if (!item.is_public) await db('brickmen_project_media?id=eq.' + encodeURIComponent(item.id), 'PATCH', { is_public: true, updated_at: new Date().toISOString() });
          prepared++; continue;
        }
        if (!item.private_storage_path) continue;
        const source = await fetch(base() + '/storage/v1/object/brickmen-studio-private/' + item.private_storage_path, {
          headers: { apikey: key(), Authorization: 'Bearer ' + key() }
        });
        if (!source.ok) throw new Error('Could not read private image "' + item.file_name + '" before publishing (HTTP ' + source.status + ').');
        const safeName = String(item.file_name || 'image').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-100);
        const publicPath = projectId + '/' + item.id + '-' + safeName;
        const upload = await fetch(base() + '/storage/v1/object/brickmen-portfolio-public/' + publicPath, {
          method: 'POST',
          headers: { apikey: key(), Authorization: 'Bearer ' + key(), 'Content-Type': item.mime_type || 'application/octet-stream', 'x-upsert': 'true' },
          body: Buffer.from(await source.arrayBuffer())
        });
        if (!upload.ok) throw new Error('Could not prepare "' + item.file_name + '" for the public portfolio (HTTP ' + upload.status + ').');
        const updated = await db('brickmen_project_media?id=eq.' + encodeURIComponent(item.id) + '&project_id=eq.' + encodeURIComponent(projectId), 'PATCH', {
          is_public: true, public_storage_path: publicPath, updated_at: new Date().toISOString()
        }, 'return=representation');
        if (!Array.isArray(updated) || !updated.length) throw new Error('A copied image could not be linked to its project.');
        prepared++;
      }
      if (!prepared) return sendJson(res, 409, { error: 'Import at least one photograph to this project before publishing.' });
      const projectRows = await db('brickmen_projects?select=draft_content&id=eq.' + encodeURIComponent(projectId) + '&limit=1');
      const draftContent = projectRows && projectRows[0] && projectRows[0].draft_content && typeof projectRows[0].draft_content === 'object' ? projectRows[0].draft_content : {};
      const livePatch = {};
      ['title','location','category','project_year','start_date','description','visibility'].forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(draftContent, field)) livePatch[field] = draftContent[field];
      });
      const layoutRows = await db('brickmen_project_layouts?select=draft_layout&project_id=eq.' + encodeURIComponent(projectId) + '&limit=1');
      if (Array.isArray(layoutRows) && layoutRows.length) {
        await db('brickmen_project_layouts?project_id=eq.' + encodeURIComponent(projectId), 'PATCH', {
          published_layout: layoutRows[0].draft_layout || { version: 1, elements: [] },
          updated_at: new Date().toISOString()
        });
      }
      const now = new Date().toISOString();
      const rows = await db('brickmen_projects?id=eq.' + encodeURIComponent(projectId), 'PATCH', {
        ...livePatch,
        draft_content: null,
        review_status: 'approved',
        approved_by: user.id,
        approved_at: now,
        is_published: true,
        published_at: now,
        updated_at: now
      }, 'return=representation');
      if (!Array.isArray(rows) || !rows.length) return sendJson(res, 404, { error: 'Project not found.' });
      return sendJson(res, 200, { project: rows[0] });
    }

    if (action === 'unpublish') {
      const rows = await db('brickmen_projects?id=eq.' + encodeURIComponent(projectId), 'PATCH', {
        is_published: false,
        updated_at: new Date().toISOString()
      }, 'return=representation');
      if (!Array.isArray(rows) || !rows.length) return sendJson(res, 404, { error: 'Project not found.' });
      return sendJson(res, 200, { project: rows[0] });
    }

    if (action === 'delete') {
      const media = await db('brickmen_project_media?select=id,private_storage_path,public_storage_path&project_id=eq.' + encodeURIComponent(projectId));
      for (const item of (Array.isArray(media) ? media : [])) {
        for (const bucketPath of [['brickmen-studio-private', item.private_storage_path], ['brickmen-portfolio-public', item.public_storage_path]]) {
          if (!bucketPath[1]) continue;
          await fetch(base() + '/storage/v1/object/' + bucketPath[0] + '/' + bucketPath[1], {
            method: 'DELETE', headers: { apikey: key(), Authorization: 'Bearer ' + key() }
          });
        }
      }
      await db('brickmen_projects?id=eq.' + encodeURIComponent(projectId), 'DELETE');
      return sendJson(res, 200, { deleted: true, driveFilesUntouched: true });
    }

    if (action === 'reject') {
      const rows = await db('brickmen_projects?id=eq.' + encodeURIComponent(projectId), 'PATCH', {
        review_status: 'rejected',
        is_published: false,
        updated_at: new Date().toISOString()
      }, 'return=representation');
      if (!Array.isArray(rows) || !rows.length) return sendJson(res, 404, { error: 'Project not found.' });
      return sendJson(res, 200, { project: rows[0] });
    }

    return sendJson(res, 400, { error: 'Unsupported portfolio action.' });
  } catch (error) {
    return sendJson(res, 503, { error: error && error.message ? error.message : 'Portfolio service is unavailable.' });
  }
};
