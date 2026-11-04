'use strict';
const { sendJson, methodNotAllowed } = require('./_lib/admin');

module.exports = async function publicPortfolio(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SECRET_KEY || '';
  if (!url || !key) return sendJson(res, 503, { error: 'Portfolio service is not configured.' });
  try {
    const response = await fetch(url + '/rest/v1/rpc/brickmen_public_portfolio', {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: '{}'
    });
    const text = await response.text();
    let projects = [];
    try { projects = text ? JSON.parse(text) : []; } catch (_) {}
    if (!response.ok) return sendJson(res, 503, { error: 'Published portfolio is temporarily unavailable.' });
    const origin = url;
    const clean = Array.isArray(projects) ? projects.map((project) => ({
      ...project,
      media: (Array.isArray(project.media) ? project.media : []).map((item) => ({
        ...item,
        url: typeof item.url === 'string' && item.url.startsWith('/') ? origin + item.url : item.url
      }))
    })) : [];
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return sendJson(res, 200, { projects: clean });
  } catch (_) {
    return sendJson(res, 502, { error: 'Published portfolio is temporarily unavailable.' });
  }
};
