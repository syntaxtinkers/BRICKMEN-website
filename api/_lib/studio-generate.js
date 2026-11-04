'use strict';
const { sendJson, methodNotAllowed, requireAdmin } = require('./admin');
const base = () => (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const key = () => process.env.SUPABASE_SECRET_KEY || '';
async function db(path, method, body, prefer) {
 const response = await fetch(base() + '/rest/v1/' + path, { method: method || 'GET', headers: { apikey: key(), Authorization: 'Bearer ' + key(), 'Content-Type': 'application/json', Accept: 'application/json', ...(prefer ? { Prefer: prefer } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
 const raw = await response.text(); let data = null; try { data = raw ? JSON.parse(raw) : null; } catch (_) {}
 if (!response.ok) throw new Error(data && (data.message || data.details) || 'Project AI preparation failed (HTTP ' + response.status + ').'); return data;
}
function parseBody(req) { if (req.body && typeof req.body === 'object') return req.body; if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (_) {} } return {}; }
function outputText(data) { if (typeof data.output_text === 'string') return data.output_text; const out = []; (data.output || []).forEach(x => (x.content || []).forEach(y => { if (y.type === 'output_text' && y.text) out.push(y.text); })); return out.join('\n'); }
function parseJson(text) { const s = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim(); try { return JSON.parse(s); } catch (_) {} const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1)); throw new Error('The AI service returned an unreadable project draft.'); }
module.exports = async function generateProject(req, res) {
 const user = await requireAdmin(req, res); if (!user) return; if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
 try {
  const body = parseBody(req), projectId = String(body.projectId || ''), tone = String(body.tone || 'Classy').slice(0, 40);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) return sendJson(res, 400, { error: 'A valid project ID is required.' });
  const apiKey = process.env.OPENAI_API_KEY || ''; if (!apiKey) return sendJson(res, 503, { error: 'AI writing is not connected. Add OPENAI_API_KEY as a Vercel Production secret and redeploy.' });
  const projects = await db('brickmen_projects?select=id,title,location,category,project_year,description,draft_content&id=eq.' + encodeURIComponent(projectId) + '&limit=1');
  if (!Array.isArray(projects) || !projects.length) return sendJson(res, 404, { error: 'Project not found.' }); const project = projects[0];
  const media = await db('brickmen_project_media?select=id,file_name,mime_type,private_storage_path,is_hidden&project_id=eq.' + encodeURIComponent(projectId) + '&order=sort_order.asc');
  const images = (Array.isArray(media) ? media : []).filter(x => x.private_storage_path && !x.is_hidden).slice(0, 8); if (!images.length) return sendJson(res, 409, { error: 'Prepare project photographs before generating its page.' });
  const input = [{ type: 'input_text', text: 'Create a sophisticated architecture portfolio page in ' + tone + ' tone for Brickmen. Return ONLY valid JSON with keys title, category, description, visual_direction, photo_captions. visual_direction includes palette (3 to 5 color names), layout_notes, and template (editorial, minimal, or gallery). photo_captions is an array of {file_name,caption,alt_text}. Metadata supplied by the admin: title=' + String(project.title || '') + '; location=' + String(project.location || '') + '; category=' + String(project.category || '') + '; year=' + String(project.project_year || '') + '. Study the photographs for visible architecture, spatial qualities, materials appearance, light, composition and landscape. Never invent client, architect, exact location, dates, building use, dimensions, construction methods, material brands, sustainability claims, awards or design intent. When uncertain, describe only what is visible. Do not identify people. Captions must be factual and alt text accessible.' }];
  let analyzed = 0, skipped = 0;
  for (const item of images) {
   const file = await fetch(base() + '/storage/v1/object/brickmen-studio-private/' + item.private_storage_path, { headers: { apikey: key(), Authorization: 'Bearer ' + key() } }); if (!file.ok) { skipped++; continue; }
   const bytes = Buffer.from(await file.arrayBuffer()); if (bytes.length > 3 * 1024 * 1024) { skipped++; continue; }
   const mime = ['image/jpeg','image/png','image/webp','image/gif'].includes(item.mime_type) ? item.mime_type : 'image/jpeg';
   input.push({ type: 'input_text', text: 'Photograph filename: ' + item.file_name }); input.push({ type: 'input_image', detail: 'high', image_url: 'data:' + mime + ';base64,' + bytes.toString('base64') }); analyzed++;
  }
  if (!analyzed) return sendJson(res, 409, { error: 'No supported imported photographs were available for AI analysis.' });
  const ai = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-6.1-terra', input: [{ role: 'user', content: input }], max_output_tokens: 2600 }) });
  const resultData = await ai.json().catch(() => ({})); if (!ai.ok) throw new Error(resultData.error && resultData.error.message || 'The AI writing service returned HTTP ' + ai.status + '.');
  const result = parseJson(outputText(resultData)); const current = project.draft_content && typeof project.draft_content === 'object' ? project.draft_content : {};
  const draft = Object.assign({}, current, { title: String(result.title || current.title || project.title || '').slice(0,180), category: String(result.category || current.category || project.category || '').slice(0,240), description: String(result.description || current.description || project.description || '').slice(0,12000), ai_generated_at: new Date().toISOString(), ai_tone: tone, ai_review_required: true });
  await db('brickmen_projects?id=eq.' + encodeURIComponent(projectId), 'PATCH', { draft_content: draft, updated_at: new Date().toISOString() });
  const captions = Array.isArray(result.photo_captions) ? result.photo_captions : [];
  for (const suggestion of captions) { const match = images.find(x => x.file_name === suggestion.file_name); if (match) await db('brickmen_project_media?id=eq.' + encodeURIComponent(match.id), 'PATCH', { caption: String(suggestion.caption || '').slice(0,500), alt_text: String(suggestion.alt_text || '').slice(0,500), updated_at: new Date().toISOString() }); }
  const layouts = await db('brickmen_project_layouts?select=draft_layout&project_id=eq.' + encodeURIComponent(projectId) + '&limit=1'); const layout = Object.assign({}, layouts && layouts[0] && layouts[0].draft_layout || { version: 1, elements: [] }, { template: ['editorial','minimal','gallery'].includes(result.visual_direction && result.visual_direction.template) ? result.visual_direction.template : 'editorial', visual_direction: result.visual_direction || {}, ai_generated_at: new Date().toISOString() });
  await db('brickmen_project_layouts?on_conflict=project_id', 'POST', { project_id: projectId, grid_size_mm: 5, canvas: { width: 240, columns: 48, unit: 'grid' }, draft_layout: layout, updated_by: user.id, updated_at: new Date().toISOString() }, 'resolution=merge-duplicates,return=minimal');
  return sendJson(res, 200, { draft_content: draft, visual_direction: result.visual_direction || {}, analyzed_photos: analyzed, skipped_photos: skipped, review_required: true });
 } catch (error) { return sendJson(res, 503, { error: error && error.message ? error.message : 'AI project preparation is unavailable.' }); }
};
