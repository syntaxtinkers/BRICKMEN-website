'use strict';
const { sendJson, methodNotAllowed, requireAdmin } = require('../_lib/admin');
const { listDriveProjectCandidates } = require('../_lib/drive-store');
module.exports = async function googleCandidates(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const user = await requireAdmin(req, res);
  if (!user) return;
  try {
    const candidates = await listDriveProjectCandidates(300);
    return sendJson(res, 200, { candidates });
  } catch (_) {
    return sendJson(res, 503, { error: 'Project-folder candidates are not ready. Complete the Drive scan first.' });
  }
};
