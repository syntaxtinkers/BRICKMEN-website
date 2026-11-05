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
  const media = await db('brickmen_project_media?select=id,file_name,mime_type,private_storage_path,is_hidden,caption,alt_text,sort_order,is_cover&project_id=eq.' + encodeURIComponent(projectId) + '&order=sort_order.asc');
  const visibleMedia = (Array.isArray(media) ? media : []).filter(x => x.private_storage_path && !x.is_hidden);
  const images = visibleMedia.slice(0, 8);
  if (!images.length) return sendJson(res, 409, { error: 'Prepare at least one visible project photograph before arranging the page.' });
  const fileList = images.map(x => x.file_name);
  const superheroTone = tone.toLowerCase().includes('superhero') || tone.toLowerCase().includes('comic');
  const toneGuidance = superheroTone
   ? `Write as a playful Brickmen superhero comic-strip story. Brickmen is the heroic building team; architectural skills become imaginative superpowers (light, space, structure, landscape, craft). Use comic-panel style eyebrow labels such as THE CALL, THE POWER, THE TRANSFORMATION, THE REVEAL, but make each project’s story unique. Energetic and witty, yet sophisticated. Never invent real events, clients, awards, technical achievements or construction facts. The superhero framing is clearly a creative brand-story device, not a factual claim.`
   : `Write in a refined architectural editorial voice. Build a clear design concept from visible spatial relationships, courtyard/landscape connections, light, massing, thresholds, material appearance and atmosphere. It is acceptable to write in Brickmen’s first-person plural as a proposed design narrative (for example, “We shape a breathable threshold between the interior and the planted court”), but frame inferred intent as an architectural reading, not a verified brief. Avoid generic filler.`;
  const instructions = `Create a distinctive architecture portfolio page for Brickmen. ${toneGuidance} This is a visual editorial, not a photo gallery. Return ONLY valid JSON with keys: title, category, description, visual_direction, photo_captions, sections.

Project reference seed: ${projectId.slice(-8)}. Use this seed to make the design rhythm and image sequence specific to THIS project. Do not use the same generic pattern for every project.

Known metadata (treat as facts only when populated): title=${JSON.stringify(project.title || '')}; location=${JSON.stringify(project.location || '')}; category=${JSON.stringify(project.category || '')}; year=${JSON.stringify(project.project_year || '')}.

Available image filenames (use exact spelling in sections): ${JSON.stringify(fileList)}. You will receive visual samples for up to eight of these photographs. Do not claim to have seen photographs that were not included as image inputs.

Writing requirements:
- description: a distinctive opening project concept of roughly 65-100 words, grounded in the supplied images. Describe the architectural idea, not just the objects visible.
- sections: an ordered sequence of 6-12 blocks, mixing 3-4 text blocks with image blocks. Each text block must have type='text', a short eyebrow, an optional short heading, and a 30-65 word body. Derive a project concept from what the photographs collectively reveal; describe how spatial moments connect, and make the prose specific to this project. Add meaningful editorial context, but do not repeat the opening description or reuse generic filler.
- Each image block must have type='image', file_name matching exactly one filename above, width ('wide','medium','narrow'), align ('left','center','right'), aspect ('landscape','portrait','natural'), and an optional concise factual caption. Choose image order and varied scale intentionally.
- Aim for an opening text passage, images separated by further short text passages, and a quieter closing passage. Do not place every image consecutively.
- photo_captions: an array of {file_name,caption,alt_text} for the photographs you actually analysed.
- visual_direction: include palette (3-5 restrained color names), layout_notes, and composition ('asymmetric','alternating','centered','offset','quiet').

Architecture accuracy rules: Study the supplied photographs carefully: spatial qualities, apparent materials/surfaces, light, composition, planting, landscape, courtyards, thresholds and relationships between interior and exterior. You may derive an imaginative architectural concept from these visual clues, but do not present an inferred concept as verified client intent. Never invent a client, architect, exact location, building use, dimensions, construction methods, material brands, sustainability claims, awards or dates. Describe uncertain details cautiously. Do not identify people. Captions and alt text must be factual and accessible. Return valid JSON only.`;
  const input = [{ type: 'input_text', text: instructions }];
  let analyzed = 0, skipped = 0;
  for (const item of images) {
   const file = await fetch(base() + '/storage/v1/object/brickmen-studio-private/' + item.private_storage_path, { headers: { apikey: key(), Authorization: 'Bearer ' + key() } }); if (!file.ok) { skipped++; continue; }
   const bytes = Buffer.from(await file.arrayBuffer()); if (bytes.length > 3 * 1024 * 1024) { skipped++; continue; }
   const mime = ['image/jpeg','image/png','image/webp','image/gif'].includes(item.mime_type) ? item.mime_type : 'image/jpeg';
   input.push({ type: 'input_text', text: 'Photograph filename: ' + item.file_name }); input.push({ type: 'input_image', detail: 'high', image_url: 'data:' + mime + ';base64,' + bytes.toString('base64') }); analyzed++;
  }
  if (!analyzed) return sendJson(res, 409, { error: 'No supported imported photographs were available for AI analysis.' });
  const ai = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-6.1-terra', input: [{ role: 'user', content: input }], max_output_tokens: 6200 }) });
  const resultData = await ai.json().catch(() => ({})); if (!ai.ok) throw new Error(resultData.error && resultData.error.message || 'The AI writing service returned HTTP ' + ai.status + '.');
  const result = parseJson(outputText(resultData)); const current = project.draft_content && typeof project.draft_content === 'object' ? project.draft_content : {};
  const draft = Object.assign({}, current, { title: String(result.title || current.title || project.title || '').slice(0,180), category: String(result.category || current.category || project.category || '').slice(0,240), description: String(result.description || current.description || project.description || '').slice(0,12000), ai_generated_at: new Date().toISOString(), ai_tone: tone, ai_review_required: true });
  await db('brickmen_projects?id=eq.' + encodeURIComponent(projectId), 'PATCH', { draft_content: draft, updated_at: new Date().toISOString() });
  const captions = Array.isArray(result.photo_captions) ? result.photo_captions : [];
  for (const suggestion of captions) { const match = visibleMedia.find(x => x.file_name === suggestion.file_name); if (match) await db('brickmen_project_media?id=eq.' + encodeURIComponent(match.id), 'PATCH', { caption: String(suggestion.caption || '').slice(0,500), alt_text: String(suggestion.alt_text || '').slice(0,500), updated_at: new Date().toISOString() }); }
  const cover = visibleMedia.find(x => x.is_cover) || visibleMedia[0];
  const used = new Set(cover ? [cover.id] : []);
  const sections = [];
  const requestedSections = Array.isArray(result.sections) ? result.sections.slice(0, 36) : [];
  for (const section of requestedSections) {
   if (!section || typeof section !== 'object') continue;
   if (section.type === 'text') {
    const bodyText = String(section.body || '').trim().slice(0, 1800);
    if (bodyText) sections.push({ type: 'text', eyebrow: String(section.eyebrow || 'PROJECT NOTE').slice(0,80), heading: String(section.heading || '').slice(0,140), body: bodyText, align: section.align === 'center' ? 'center' : 'left' });
   } else if (section.type === 'image') {
    const match = images.find(x => x.file_name === String(section.file_name || ''));
    if (!match || used.has(match.id)) continue;
    used.add(match.id);
    const cap = String(section.caption || (captions.find(x => x.file_name === match.file_name) || {}).caption || match.caption || '').slice(0,500);
    sections.push({ type: 'image', mediaId: match.id, width: ['wide','medium','narrow'].includes(section.width) ? section.width : 'wide', align: ['left','center','right'].includes(section.align) ? section.align : 'center', aspect: ['landscape','portrait','natural'].includes(section.aspect) ? section.aspect : 'natural', caption: cap, spaceAfter: 'large' });
   }
  }
  const rhythm = ['wide','medium','wide','narrow','medium'];
  const alignments = ['left','right','center','left','right'];
  visibleMedia.filter(x => !used.has(x.id)).forEach((item, index) => {
   sections.push({ type: 'image', mediaId: item.id, width: rhythm[index % rhythm.length], align: alignments[index % alignments.length], aspect: 'natural', caption: String((captions.find(x => x.file_name === item.file_name) || {}).caption || item.caption || '').slice(0,500), spaceAfter: 'large' });
  });
  if (sections.filter(x => x.type === 'text').length < 2 && draft.description) {
   sections.splice(0, 0, { type: 'text', eyebrow: 'PROJECT NOTE', heading: '', body: draft.description.slice(0, 1200), align: 'left' });
  }
  // Convert editorial blocks to explicit 5 mm grid coordinates (48 columns).
  // The page starts with a calm top offset; block heights include generous whitespace.
  let gridY = 3;
  let textIndex = 0, imageIndex = 0;
  const elements = sections.map((section) => {
   if (section.type === 'text') {
    const width = textIndex % 2 === 0 ? 34 : 28;
    const x = section.align === 'center' ? Math.floor((48 - width) / 2) + 1 : (textIndex % 2 === 0 ? 3 : 17);
    const height = Math.max(7, Math.min(11, 5 + Math.ceil(String(section.body || '').length / 115)));
    const item = { ...section, x: Math.max(1, Math.min(49 - width, x)), y: gridY, w: width, h: height };
    gridY += height + (textIndex === 0 ? 7 : 6);
    textIndex++;
    return item;
   }
   const width = section.width === 'narrow' ? 23 : section.width === 'medium' ? 32 : 43;
   const x = section.align === 'left' ? 2 : section.align === 'right' ? 48 - width : Math.floor((48 - width) / 2) + 1;
   const height = section.aspect === 'portrait' ? 31 : section.aspect === 'landscape' ? 23 : (imageIndex % 2 === 0 ? 25 : 28);
   const item = { ...section, x, y: gridY, w: width, h: height };
   gridY += height + 7;
   imageIndex++;
   return item;
  });
  const direction = result.visual_direction && typeof result.visual_direction === 'object' ? result.visual_direction : {};
  const layout = { version: 2, template: 'editorial', grid: { sizeMm: 5, columns: 48 }, composition: ['asymmetric','alternating','centered','offset','quiet'].includes(direction.composition) ? direction.composition : 'asymmetric', heroMediaId: cover ? cover.id : null, visual_direction: direction, ai_generated_at: new Date().toISOString(), elements };
  await db('brickmen_project_layouts?on_conflict=project_id', 'POST', { project_id: projectId, grid_size_mm: 5, canvas: { width: 240, columns: 48, unit: 'grid' }, draft_layout: layout, updated_by: user.id, updated_at: new Date().toISOString() }, 'resolution=merge-duplicates,return=minimal');
  return sendJson(res, 200, { draft_content: draft, visual_direction: result.visual_direction || {}, analyzed_photos: analyzed, skipped_photos: skipped, review_required: true });
 } catch (error) { return sendJson(res, 503, { error: error && error.message ? error.message : 'AI project preparation is unavailable.' }); }
};
