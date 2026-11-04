'use strict';
const { sendJson, methodNotAllowed, requireAdmin } = require('../_lib/admin');
const { getScanState } = require('../_lib/drive-store');
module.exports = async function googleScanStatus(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const user = await requireAdmin(req, res);
  if (!user) return;
  try {
    const state = await getScanState();
    if (!state) return sendJson(res, 200, { status: 'idle', scannedFiles: 0, scannedFolders: 0, candidateFolders: 0 });
    return sendJson(res, 200, {
      status: state.status,
      scannedFiles: Number(state.scanned_files || 0),
      scannedFolders: Number(state.scanned_folders || 0),
      candidateFolders: Number(state.candidate_folders || 0),
      incompleteSearch: Boolean(state.incomplete_search),
      startedAt: state.started_at,
      completedAt: state.completed_at,
      error: state.last_error || null
    });
  } catch (_) {
    return sendJson(res, 503, { error: 'Drive scan status is unavailable. Apply the archive inventory migration first.' });
  }
};
