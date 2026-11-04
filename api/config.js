'use strict';
const { sendJson, methodNotAllowed } = require('./_lib/admin');
module.exports = async function config(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || '';
  if (!supabaseUrl || !publishableKey) return sendJson(res, 503, { error: 'Supabase browser configuration is incomplete.' });
  return sendJson(res, 200, { supabaseUrl, publishableKey });
};