'use strict';
const { sendJson, methodNotAllowed, requireAdmin } = require('./admin');

const base = () => (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const key = () => process.env.SUPABASE_SECRET_KEY || '';
const MODEL = 'gpt-6.1-terra';

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
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (_) {}
  if (!response.ok) throw new Error(data && (data.message || data.details) || 'Project AI preparation failed (HTTP ' + response.status + ').');
  return data;
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (_) {} }
  return {};
}

function outputText(data) {
  if (typeof data.output_text === 'string') return data.output_text;
  const out = [];
  (data.output || []).forEach(item => (item.content || []).forEach(part => {
    if (part.type === 'output_text' && part.text) out.push(part.text);
  }));
  return out.join('\n');
}

function parseJson(value) {
  const raw = String(value || '').trim();
  try { return JSON.parse(raw); } catch (_) {}
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new Error('The AI returned an incomplete or unreadable editorial response. Nothing was published.');
}

async function askAI(apiKey, input, maxTokens, schemaName, schema) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      input: [{ role: 'user', content: input }],
      max_output_tokens: maxTokens,
      text: { format: { type: 'json_schema', name: schemaName, strict: true, schema: schema } }
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.error && data.error.message;
    throw new Error('OpenAI ' + schemaName + ' request failed (HTTP ' + response.status + '): ' + (detail || 'No error detail returned.'));
  }
  if (data.status === 'incomplete') {
    const reason = data.incomplete_details && data.incomplete_details.reason || 'output limit reached';
    throw new Error('OpenAI stopped before completing ' + schemaName + ' (' + reason + '). Try again; no partial layout was saved.');
  }
  return parseJson(outputText(data));
}

function objectSchema(properties) {
  return { type: 'object', additionalProperties: false, properties: properties, required: Object.keys(properties) };
}

const observationSchema = objectSchema({
  observations: {
    type: 'array',
    items: objectSchema({
      media_id: { type: 'string' },
      file_name: { type: 'string' },
      visual_analysis: { type: 'string' },
      caption: { type: 'string' },
      alt_text: { type: 'string' },
      orientation: { type: 'string', enum: ['landscape', 'portrait', 'square'] }
    })
  }
});

const orderSchema = objectSchema({ image_order: { type: 'array', items: { type: 'string' } } });

const articleSchema = objectSchema({
  title: { type: 'string' },
  category: { type: 'string' },
  description: { type: 'string' },
  image_order: { type: 'array', items: { type: 'string' } },
  paragraphs: {
    type: 'array',
    items: objectSchema({
      eyebrow: { type: 'string' },
      heading: { type: 'string' },
      body: { type: 'string' }
    })
  },
  visual_direction: objectSchema({
    concept: { type: 'string' },
    typography: { type: 'string' },
    layout: { type: 'string' },
    palette: { type: 'array', items: { type: 'string' } },
    composition: { type: 'string' },
    margin_columns: { type: 'integer' }
  }),
  custom_theme: objectSchema({
    paper: { type: 'string' },
    ink: { type: 'string' },
    accent: { type: 'string' },
    font: { type: 'string' },
    image_radius: { type: 'string' },
    hero_style: { type: 'string' },
    text_style: { type: 'string' },
    margin_columns: { type: 'integer' }
  })
});

function wordCount(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

function mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  return Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  })).then(() => output);
}

async function signedPhotoUrl(item) {
  const path = String(item.private_storage_path || '').split('/').map(encodeURIComponent).join('/');
  const response = await fetch(base() + '/storage/v1/object/sign/brickmen-studio-private/' + path, {
    method: 'POST',
    headers: {
      apikey: key(),
      Authorization: 'Bearer ' + key(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ expiresIn: 900 })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('Could not prepare "' + item.file_name + '" for visual analysis (storage HTTP ' + response.status + '). ' + String(data.message || data.error || '').slice(0, 180));
  const signed = data.signedURL || data.signedUrl || data.signed_url;
  if (!signed) throw new Error('Storage did not return a secure image link for "' + item.file_name + '".');
  if (/^https?:\/\//i.test(signed)) return signed;
  return base() + '/storage/v1/' + String(signed).replace(/^\/+/, '');
}

async function analyseBatch(apiKey, batch, batchNumber, batchCount) {
  const urls = await Promise.all(batch.map(signedPhotoUrl));
  const content = [{
    type: 'input_text',
    text: 'You are the visual editor of an internationally respected architecture magazine. Examine every attached photograph individually, not as a general batch. Match your analysis to the exact MEDIA ID and filename supplied immediately before each image. Return exactly one observation for every image. Describe visible architectural evidence: spatial organisation, geometry, depth, threshold, light and shadow, apparent materials, surface, landscape, planting, interior/exterior relationships, camera viewpoint and composition. Distinguish what is visible from interpretation. Never invent project facts. Captions must be precise and visually specific, not generic praise. Return the required JSON.'
  }];
  batch.forEach((item, index) => {
    content.push({ type: 'input_text', text: 'MEDIA ID: ' + item.id + '\nEXACT FILENAME: ' + item.file_name + '\nAnalyse the next image as this exact photograph.' });
    content.push({ type: 'input_image', image_url: urls[index], detail: 'high' });
  });

  let result;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { result = await askAI(apiKey, content, 4500, 'brickmen_photo_analysis', observationSchema); }
    catch (error) { throw new Error('Photo analysis failed for ' + batch.map(item => item.file_name).join(', ') + ': ' + error.message); }
    const observed = Array.isArray(result.observations) ? result.observations : [];
    const ids = new Set(observed.map(item => String(item.media_id || '')));
    if (observed.length === batch.length && batch.every(item => ids.has(item.id))) {
      const byId = new Map(observed.map(item => [String(item.media_id), item]));
      return batch.map(item => {
        const row = byId.get(item.id);
        return Object.assign({}, row, { media_id: item.id, file_name: item.file_name });
      });
    }
    if (attempt === 1) {
      const missing = batch.filter(item => !ids.has(item.id)).map(item => item.file_name);
      throw new Error('The AI did not return a verifiable analysis for every photograph in batch ' + batchNumber + '/' + batchCount + '. Missing: ' + missing.join(', ') + '. No incomplete page was saved.');
    }
  }
  return [];
}

function presetMargin(template) {
  const match = /^t(\d{2})$/.exec(String(template || ''));
  if (!match) return 2;
  return ((Number(match[1]) - 1) % 3) + 1;
}

function safeTheme(theme) {
  const source = theme && typeof theme === 'object' ? theme : {};
  const hex = (value, fallback) => /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : fallback;
  const fonts = ['Georgia, serif', 'Arial, sans-serif', 'Palatino, serif', 'Courier New, monospace', 'Trebuchet MS, sans-serif'];
  const radii = ['0px', '2px', '4px', '8px', '12px', '16px'];
  const heroes = ['split', 'stack', 'overlay', 'reverse', 'editorial'];
  const textStyles = ['rail', 'center', 'ink', 'frame', 'italic', 'caps', 'soft', 'rule', 'photo-edge', 'quiet'];
  return {
    paper: hex(source.paper, '#f5f3ed'),
    ink: hex(source.ink, '#242522'),
    accent: hex(source.accent, '#a46c4f'),
    font: fonts.includes(source.font) ? source.font : 'Georgia, serif',
    image_radius: radii.includes(source.image_radius) ? source.image_radius : '0px',
    hero_style: heroes.includes(source.hero_style) ? source.hero_style : 'split',
    text_style: textStyles.includes(source.text_style) ? source.text_style : 'rail',
    margin_columns: [1, 2, 3].includes(Number(source.margin_columns)) ? Number(source.margin_columns) : 2
  };
}

module.exports = async function generateProject(req, res) {
  const user = await requireAdmin(req, res);
  if (!user) return;
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const body = parseBody(req);
    const projectId = String(body.projectId || '');
    const tone = String(body.tone || 'Classy').slice(0, 40);
    const requestedTemplate = String(body.templateId || 'ai-custom');

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
      return sendJson(res, 400, { error: 'A valid project ID is required.' });
    }
    const apiKey = process.env.OPENAI_API_KEY || '';
    if (!apiKey) return sendJson(res, 503, { error: 'AI writing is not connected. Add OPENAI_API_KEY as a Vercel Production secret and redeploy.' });

    const projects = await db('brickmen_projects?select=id,title,location,category,project_year,description,draft_content&id=eq.' + encodeURIComponent(projectId) + '&limit=1');
    if (!Array.isArray(projects) || !projects.length) return sendJson(res, 404, { error: 'Project not found.' });
    const project = projects[0];

    const mediaRows = await db('brickmen_project_media?select=id,drive_file_id,file_name,private_storage_path,is_hidden,caption,alt_text,sort_order,is_cover&project_id=eq.' + encodeURIComponent(projectId) + '&order=sort_order.asc');
    const existingLayouts = await db('brickmen_project_layouts?select=project_id,draft_layout');
    const currentLayoutRow = (Array.isArray(existingLayouts) ? existingLayouts : []).find(row => row.project_id === projectId) || null;
    const savedPhotoLibrary = currentLayoutRow && currentLayoutRow.draft_layout && currentLayoutRow.draft_layout.photo_library ? currentLayoutRow.draft_layout.photo_library : null;
    const savedPhotoStates = new Map((savedPhotoLibrary && Array.isArray(savedPhotoLibrary.items) ? savedPhotoLibrary.items : []).map(item => [String(item.drive_file_id || ''), item]));
    const visible = (Array.isArray(mediaRows) ? mediaRows : []).filter(item => {
      if (!item.private_storage_path) return false;
      const state = savedPhotoStates.get(String(item.drive_file_id || ''));
      return state ? !!state.selected && !state.trashed : !item.is_hidden;
    }).sort((a, b) => {
      const stateA = savedPhotoStates.get(String(a.drive_file_id || ''));
      const stateB = savedPhotoStates.get(String(b.drive_file_id || ''));
      const orderA = stateA && Number.isFinite(Number(stateA.order)) ? Number(stateA.order) : Number(a.sort_order || 0);
      const orderB = stateB && Number.isFinite(Number(stateB.order)) ? Number(stateB.order) : Number(b.sort_order || 0);
      return orderA - orderB || String(a.file_name || '').localeCompare(String(b.file_name || ''));
    });
    if (!visible.length) return sendJson(res, 409, { error: 'No selected, imported photographs are ready for analysis. Open Select images, choose photographs, and prepare them first.' });

    console.log('[Brickmen AI] Start project=' + projectId + ' visible_photos=' + visible.length + ' model=' + MODEL);
    const groups = [];
    for (let i = 0; i < visible.length; i += 4) groups.push(visible.slice(i, i + 4));
    const analysesByBatch = await mapLimit(groups, 2, (batch, index) => analyseBatch(apiKey, batch, index + 1, groups.length));
    const observations = analysesByBatch.flat();
    const observedIds = new Set(observations.map(item => item.media_id));
    const missingAnalysis = visible.filter(item => !observedIds.has(item.id));
    if (missingAnalysis.length || observations.length !== visible.length) {
      throw new Error('Photo audit incomplete: analysed ' + observations.length + ' of ' + visible.length + ' visible photographs. Missing: ' + missingAnalysis.map(item => item.file_name).join(', '));
    }
    console.log('[Brickmen AI] Photo audit complete project=' + projectId + ' analysed=' + observations.length + '/' + visible.length);

    const comic = tone.toLowerCase().includes('superhero') || tone.toLowerCase().includes('comic');
    const voice = comic
      ? 'Write a sophisticated, witty, fictional Brickmen superhero comic feature. The team uses imaginative superpowers of light, space, structure, landscape and craft. Clearly present this as creative brand storytelling, never factual project history.'
      : 'Write like a perceptive architectural journalist for an internationally respected architecture magazine. Be literate, atmospheric, observant and specific. Build a coherent architectural argument across the article. No marketing slogans, generic praise, repetitive captions or filler. Let each paragraph reveal a new spatial idea.';
    const occupied = new Set((Array.isArray(existingLayouts) ? existingLayouts : [])
      .filter(row => row.project_id !== projectId && row.draft_layout)
      .map(row => ({ editorial: 't01', minimal: 't04', gallery: 't03' }[row.draft_layout.template] || row.draft_layout.template))
      .filter(template => /^t(0[1-9]|[1-3][0-9]|40)$/.test(template)));

    let assigned = requestedTemplate;
    if (requestedTemplate === 'ai-custom') assigned = 'custom';
    else if (!/^t(0[1-9]|[1-3][0-9]|40)$/.test(requestedTemplate) || occupied.has(requestedTemplate)) {
      assigned = Array.from({ length: 40 }, (_, index) => 't' + String(index + 1).padStart(2, '0')).find(template => !occupied.has(template));
      if (!assigned) assigned = 'custom';
    }

    const cover = visible[0];
    const bodyPhotoCount = visible.length - 1;
    const paragraphCount = Math.min(7, Math.max(3, Math.ceil(bodyPhotoCount / 3) + 1));
    const photoEvidence = observations.map(item => ({
      media_id: item.media_id,
      filename: item.file_name,
      visual_analysis: item.visual_analysis,
      orientation: item.orientation,
      observed_caption: item.caption
    }));
    const articlePrompt = [
      'Create the editorial package for a complete Brickmen architecture magazine feature.',
      voice,
      'Project metadata; only populated values are facts: ' + JSON.stringify({
        title: project.title || '',
        location: project.location || '',
        category: project.category || '',
        year: project.project_year || ''
      }),
      'Every visible photograph has already been individually examined. Here is the verified photo-by-photo visual evidence. Use it as your primary source and do not invent details: ' + JSON.stringify(photoEvidence),
      'Return a concise standfirst description of 55-75 words, then exactly ' + paragraphCount + ' substantial magazine paragraphs. Each paragraph must contain approximately 65-95 words, have an original short heading and eyebrow, and advance the architectural narrative. The standfirst must not repeat the paragraphs.',
      'The photograph order has been manually arranged by the editor in the project photo folder. Preserve this exact order; do not reorder it. image_order must list MEDIA IDs in precisely the same order as the evidence below, beginning with cover image ' + cover.id + '. The cover is displayed in the hero, so it will not be repeated in the body. Write paragraphs around this fixed sequence: establish the overall spatial idea, move through connected spaces, details, light, landscape and atmosphere, then close with the strongest concluding image. Do not omit or duplicate a photo.',
      'Write captions that are short, factual and tied to the exact photograph. Acknowledge uncertainty rather than guessing. Avoid inventing architect/client, address, use, dimensions, construction methods, branded materials, sustainability claims, awards, budgets or dates.',
      'Art direct the article like a premium architecture journal. Give a coherent editorial concept, considered type pairing, a strict horizontal alignment system, large photographs and restrained whitespace. '+(assigned === 'custom'
        ? 'Invent a new project-specific theme. Choose a restrained paper/ink/accent palette, a typography direction, hero arrangement, text treatment and page margins (1, 2 or 3 grid columns).'
        : 'Use preset template ' + assigned + ' as the visual identity. Choose margin_columns between 1 and 3 to suit its overall character.'),
      'The body sequence will be laid out by the website using one consistent rule: every photograph fills the full content width; every editorial text block is about half that width and aligns exactly to the left or right image edge. Paragraphs must separate groups of photographs. Do not request staggered, narrow, floating or unequal-width images.',
      'If tone is architectural editorial, write genuine architecture journalism, not a description list. If tone is superhero comic, preserve the same visual specificity and substantial writing while framing it as playful fiction.',
      'Return only the requested structured data.'
    ].join('\n\n');

    let article = await askAI(apiKey, [{ type: 'input_text', text: articlePrompt }], 9500, 'brickmen_magazine_article', articleSchema);
    const paragraphs = Array.isArray(article.paragraphs) ? article.paragraphs : [];
    const validArticle = wordCount(article.description) >= 40 &&
      paragraphs.length === paragraphCount &&
      paragraphs.every(paragraph => wordCount(paragraph.body) >= 45 && String(paragraph.heading || '').trim());
    if (!validArticle) {
      console.log('[Brickmen AI] Article quality check retry project=' + projectId + ' paragraphs=' + paragraphs.length + '/' + paragraphCount);
      const repair = 'Rewrite this editorial package to satisfy the requirements. Produce exactly ' + paragraphCount + ' non-repetitive paragraphs, each at least 55 words with a heading and eyebrow, plus a distinct 55-75 word standfirst. Keep every photo ID in image_order exactly once. Existing output: ' + JSON.stringify(article) + '. Return the full corrected structured object.';
      article = await askAI(apiKey, [{ type: 'input_text', text: repair }], 9500, 'brickmen_magazine_article', articleSchema);
    }
    const finalParagraphs = Array.isArray(article.paragraphs) ? article.paragraphs : [];
    if (wordCount(article.description) < 40 || finalParagraphs.length !== paragraphCount || !finalParagraphs.every(paragraph => wordCount(paragraph.body) >= 45 && String(paragraph.heading || '').trim())) {
      throw new Error('The AI could not produce the required full-length architecture article. No incomplete layout was saved; run AI arrange again.');
    }

    // The thumbnail order chosen by the user is authoritative. The AI writes to this sequence; it never silently changes it.
    const orderedIds = visible.map(item => item.id);

    const current = project.draft_content && typeof project.draft_content === 'object' ? project.draft_content : {};
    const draft = Object.assign({}, current, {
      title: String(article.title || current.title || project.title || '').slice(0, 180),
      category: String(article.category || current.category || project.category || '').slice(0, 240),
      description: String(article.description || '').slice(0, 12000),
      ai_generated_at: new Date().toISOString(),
      ai_tone: tone,
      ai_review_required: true,
      ai_photo_count: observations.length,
      ai_article_paragraph_count: finalParagraphs.length,
      ai_model: MODEL
    });

    const captions = new Map();
    observations.forEach(item => captions.set(item.media_id, item));
    (Array.isArray(article.photo_captions) ? article.photo_captions : []).forEach(item => {
      if (item && item.media_id && captions.has(item.media_id)) captions.set(item.media_id, Object.assign({}, captions.get(item.media_id), item));
    });
    await mapLimit(visible, 5, async item => {
      const caption = captions.get(item.id) || {};
      return db('brickmen_project_media?id=eq.' + encodeURIComponent(item.id) + '&project_id=eq.' + encodeURIComponent(projectId), 'PATCH', {
        caption: String(caption.caption || '').slice(0, 500),
        alt_text: String(caption.alt_text || '').slice(0, 500),
        updated_at: new Date().toISOString()
      });
    });

    const customTheme = assigned === 'custom' ? safeTheme(article.custom_theme) : null;
    const marginColumns = assigned === 'custom' ? customTheme.margin_columns : presetMargin(assigned);
    const contentX = marginColumns + 1;
    const contentWidth = 48 - marginColumns * 2;
    const textWidth = Math.max(18, Math.round(contentWidth * 0.5));
    const orientationById = new Map(observations.map(item => [item.media_id, item.orientation]));
    const elements = [];
    let y = 2;
    let photoCursor = 0;
    const bodyIds = orderedIds.filter(id => id !== cover.id);

    finalParagraphs.forEach((paragraph, paragraphIndex) => {
      const width = textWidth;
      const textX = paragraphIndex % 2 === 0 ? contentX : contentX + contentWidth - width;
      const words = wordCount(paragraph.body);
      const textHeight = Math.max(16, Math.min(26, Math.ceil(words / 18) + 10));
      elements.push({
        type: 'text',
        eyebrow: String(paragraph.eyebrow || 'DESIGN NOTE').slice(0, 80),
        heading: String(paragraph.heading || '').slice(0, 160),
        body: String(paragraph.body || '').slice(0, 2600),
        align: 'left',
        x: textX,
        y: y,
        w: width,
        h: textHeight
      });
      y += textHeight + 3;

      const paragraphsLeft = finalParagraphs.length - paragraphIndex;
      const photosLeft = bodyIds.length - photoCursor;
      const groupSize = paragraphsLeft > 0 ? Math.ceil(photosLeft / paragraphsLeft) : 0;
      for (let count = 0; count < groupSize && photoCursor < bodyIds.length; count++) {
        const mediaId = bodyIds[photoCursor++];
        const observation = captions.get(mediaId) || {};
        const orientation = orientationById.get(mediaId) || 'landscape';
        const height = orientation === 'portrait' ? 58 : orientation === 'square' ? 45 : 31;
        elements.push({
          type: 'image',
          mediaId: mediaId,
          width: 'full',
          align: 'full',
          aspect: orientation,
          fit: 'contain',
          caption: String(observation.caption || '').slice(0, 500),
          x: contentX,
          y: y,
          w: contentWidth,
          h: height
        });
        y += height + 4;
      }
    });

    while (photoCursor < bodyIds.length) {
      const mediaId = bodyIds[photoCursor++];
      const orientation = orientationById.get(mediaId) || 'landscape';
      const height = orientation === 'portrait' ? 58 : orientation === 'square' ? 45 : 31;
      elements.push({
        type: 'image', mediaId: mediaId, width: 'full', align: 'full',
        aspect: orientation, fit: 'contain',
        caption: String((captions.get(mediaId) || {}).caption || '').slice(0, 500),
        x: contentX, y: y, w: contentWidth, h: height
      });
      y += height + 4;
    }

    const direction = article.visual_direction && typeof article.visual_direction === 'object' ? article.visual_direction : {};
    const layout = {
      version: 4,
      template: assigned,
      grid: { sizeMm: 5, columns: 48 },
      margin_columns: marginColumns,
      content_columns: contentWidth,
      composition: 'full-width-aligned-magazine',
      heroMediaId: cover.id,
      visual_direction: direction,
      custom_theme: customTheme,
      photo_library: savedPhotoLibrary || { version: 1, items: [] },
      ai_generated_at: new Date().toISOString(),
      analysis: { total: visible.length, analysed: observations.length, complete: true },
      elements: elements
    };

    await db('brickmen_projects?id=eq.' + encodeURIComponent(projectId), 'PATCH', {
      draft_content: draft,
      updated_at: new Date().toISOString()
    });
    await db('brickmen_project_layouts?on_conflict=project_id', 'POST', {
      project_id: projectId,
      grid_size_mm: 5,
      canvas: { width: 240, columns: 48, unit: 'grid' },
      draft_layout: layout,
      updated_by: user.id,
      updated_at: new Date().toISOString()
    }, 'resolution=merge-duplicates,return=minimal');

    console.log('[Brickmen AI] Complete project=' + projectId + ' photos=' + observations.length + ' paragraphs=' + finalParagraphs.length + ' template=' + assigned + ' elements=' + elements.length);
    return sendJson(res, 200, {
      draft_content: draft,
      visual_direction: direction,
      analyzed_photos: observations.length,
      total_photos: visible.length,
      skipped_photos: 0,
      analysis_complete: true,
      text_blocks: finalParagraphs.length,
      template: assigned,
      template_name: assigned === 'custom' ? 'AI-created original design' : assigned,
      review_required: true
    });
  } catch (error) {
    console.error('[Brickmen AI] Failed: ' + (error && error.message ? error.message : 'Unknown error'));
    return sendJson(res, 503, { error: error && error.message ? error.message : 'AI project preparation is unavailable.' });
  }
};
