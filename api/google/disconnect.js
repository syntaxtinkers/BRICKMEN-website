'use strict';
const { sendJson, methodNotAllowed, requireAdmin } = require('../_lib/admin');
const { deleteDriveConnection } = require('../_lib/drive-store');
module.exports = async function googleDisconnect(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireAdmin(req, res);
  if (!user) return;
  try {
    await deleteDriveConnection();
    return sendJson(res, 200, { disconnected: true });
  } catch (_) {
    return sendJson(res, 503, { error: 'Unable to disconnect Google Drive right now.' });
  }
};