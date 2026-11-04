'use strict';
const { sendJson, methodNotAllowed, requireAdmin } = require('../_lib/admin');
module.exports = async function studioMe(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const user = await requireAdmin(req, res);
  if (!user) return;
  return sendJson(res, 200, { authorised: true, email: user.email });
};