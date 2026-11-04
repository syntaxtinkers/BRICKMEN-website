'use strict';
const crypto = require('node:crypto');
function encryptionKey() {
  const encoded = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || '';
  let key;
  try { key = Buffer.from(encoded, 'base64'); } catch (_) { key = null; }
  if (!key || key.length !== 32) throw new Error('Google token encryption is not configured.');
  return key;
}
function encryptToken(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    refresh_token_ciphertext: ciphertext.toString('base64'),
    refresh_token_iv: iv.toString('base64'),
    refresh_token_tag: cipher.getAuthTag().toString('base64')
  };
}
function decryptToken(record) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(record.refresh_token_iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.refresh_token_tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(record.refresh_token_ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
}
module.exports = { encryptToken, decryptToken };