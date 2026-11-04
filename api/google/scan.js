'use strict';
const { sendJson, methodNotAllowed, requireAdmin } = require('../_lib/admin');
const { getDriveConnection, getScanState, saveScanState, upsertDriveItems, buildDriveProjectCandidates } = require('../_lib/drive-store');
const { decryptToken } = require('../_lib/token-crypto');

const FOLDER_MIME = 'application/vnd.google-apps.folder';

async function getFreshAccessToken(connection) {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) throw new Error('Google OAuth client settings are missing in Vercel.');
  const refreshToken = decryptToken(connection);
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error('Google could not refresh the Drive connection. Reconnect Google Drive from Studio.');
  }
  return data.access_token;
}

async function listDrivePage(accessToken, pageToken) {
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('corpora', 'user');
  url.searchParams.set('includeItemsFromAllDrives', 'true');
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('spaces', 'drive');
  url.searchParams.set('q', 'trashed = false');
  url.searchParams.set('pageSize', '1000');
  url.searchParams.set('orderBy', 'modifiedTime desc');
  url.searchParams.set('fields', 'nextPageToken,incompleteSearch,files(id,name,mimeType,parents,createdTime,modifiedTime,webViewLink,thumbnailLink,size,md5Checksum,description,driveId,shortcutDetails(targetId,targetMimeType))');
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = data && data.error && data.error.message;
    throw new Error(reason || 'Google Drive could not return the next inventory page.');
  }
  return data;
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_) {}
  }
  return {};
}

module.exports = async function googleScan(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireAdmin(req, res);
  if (!user) return;

  const action = String(parseBody(req).action || 'next');
  try {
    if (action === 'start') {
      const connection = await getDriveConnection();
      if (!connection) return sendJson(res, 409, { error: 'Connect Google Drive before starting an archive scan.' });
      const now = new Date().toISOString();
      await saveScanState({
        status: 'scanning',
        page_token: null,
        scanned_files: 0,
        scanned_folders: 0,
        candidate_folders: 0,
        incomplete_search: false,
        started_at: now,
        completed_at: null,
        last_error: null
      });
      return sendJson(res, 200, { status: 'scanning', scannedFiles: 0, scannedFolders: 0, message: 'Drive scan started.' });
    }

    if (action !== 'next') return sendJson(res, 400, { error: 'Unsupported scan action.' });
    const state = await getScanState();
    if (!state || state.status !== 'scanning') {
      return sendJson(res, 409, { error: 'There is no active scan. Start a new Drive scan first.' });
    }
    const connection = await getDriveConnection();
    if (!connection) return sendJson(res, 409, { error: 'The Google Drive connection is missing. Reconnect it from Studio.' });

    const accessToken = await getFreshAccessToken(connection);
    const page = await listDrivePage(accessToken, state.page_token);
    const files = Array.isArray(page.files) ? page.files : [];
    const saved = await upsertDriveItems(files);
    const folderCount = files.filter((file) => file.mimeType === FOLDER_MIME).length;
    const fileCount = files.length - folderCount;
    const scannedFiles = Number(state.scanned_files || 0) + fileCount;
    const scannedFolders = Number(state.scanned_folders || 0) + folderCount;
    const incompleteSearch = Boolean(state.incomplete_search || page.incompleteSearch);
    const nextPageToken = page.nextPageToken || null;

    if (nextPageToken) {
      await saveScanState({
        status: 'scanning',
        page_token: nextPageToken,
        scanned_files: scannedFiles,
        scanned_folders: scannedFolders,
        incomplete_search: incompleteSearch,
        last_error: null
      });
      return sendJson(res, 200, {
        status: 'scanning',
        batchFiles: saved,
        scannedFiles,
        scannedFolders,
        incompleteSearch,
        message: 'Indexed ' + scannedFiles + ' files and ' + scannedFolders + ' folders.'
      });
    }

    let candidateFolders = 0;
    let candidateBuildError = null;
    try {
      const result = await buildDriveProjectCandidates();
      candidateFolders = Number(result || 0);
    } catch (error) {
      candidateBuildError = error && error.message ? error.message : 'Candidate folder analysis failed.';
    }
    await saveScanState({
      status: 'completed',
      page_token: null,
      scanned_files: scannedFiles,
      scanned_folders: scannedFolders,
      candidate_folders: candidateFolders,
      incomplete_search: incompleteSearch,
      completed_at: new Date().toISOString(),
      last_error: candidateBuildError
    });
    return sendJson(res, 200, {
      status: 'completed',
      batchFiles: saved,
      scannedFiles,
      scannedFolders,
      candidateFolders,
      incompleteSearch,
      candidateBuildError,
      message: 'Drive inventory complete.'
    });
  } catch (error) {
    return sendJson(res, 502, {
      error: error && error.message ? error.message : 'The Drive scan batch failed. You can retry the current batch.'
    });
  }
};
