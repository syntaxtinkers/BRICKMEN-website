'use strict';
const { sendJson, methodNotAllowed, requireAdmin } = require('../_lib/admin');
const { getDriveConnection } = require('../_lib/drive-store');
module.exports = async function googleStatus(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const user = await requireAdmin(req, res);
  if (!user) return;
  try {
    const record = await getDriveConnection();
    return sendJson(res, 200, {
      connected: !!record,
      email: record ? record.connected_email : null,
      connectedAt: record ? record.connected_at : null,
      scopes: record ? record.granted_scopes : []
    });
  } catch (_) {
    return sendJson(res, 503, { error: 'Unable to read the Google Drive connection status. Apply the Brickmen Drive database migration first.' });
  }
};