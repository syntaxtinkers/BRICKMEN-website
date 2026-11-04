'use strict';

// Public browser configuration only. Keep this endpoint independent from the
// admin/auth helpers so Studio can always load its Supabase sign-in settings.
module.exports = async function config(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed.' }));
    return;
  }

  try {
    const supabaseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
    const publishableKey = String(process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();

    if (!supabaseUrl || !publishableKey) {
      res.statusCode = 503;
      res.end(JSON.stringify({
        error: 'Supabase browser configuration is missing. In Vercel, check SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY under Production environment variables, then redeploy.'
      }));
      return;
    }

    let parsed;
    try {
      parsed = new URL(supabaseUrl);
    } catch (_) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: 'SUPABASE_URL is not a valid URL. Check its Vercel Production value.' }));
      return;
    }

    if (parsed.protocol !== 'https:' || !/\.supabase\.co$/i.test(parsed.hostname)) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: 'SUPABASE_URL must be the HTTPS URL of the Brickmen Supabase project.' }));
      return;
    }

    res.statusCode = 200;
    res.end(JSON.stringify({ supabaseUrl, publishableKey }));
  } catch (_) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'Brickmen could not load its public Supabase configuration.' }));
  }
};
