const crypto = require('crypto');

const CIPHER_VERSION = 1;
const MASTER_KEY_ERROR = 'WEIXIN_CREDENTIAL_MASTER_KEY must be strict Base64 for exactly 32 bytes';

function decodeMasterKey(value) {
  const encoded = String(value || '').trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error(MASTER_KEY_ERROR);
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error(MASTER_KEY_ERROR);
  return key;
}

function requireKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new TypeError('AES-256-GCM key must be exactly 32 bytes');
  }
  return key;
}

function aadBuffer(value) {
  return Buffer.from(String(value || ''), 'utf8');
}

function encryptSecret(value, key, aad) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', requireKey(key), nonce);
  cipher.setAAD(aadBuffer(aad));
  const ciphertext = Buffer.concat([
    cipher.update(String(value), 'utf8'),
    cipher.final()
  ]);
  return {
    cipherVersion: CIPHER_VERSION,
    ciphertext,
    nonce,
    authTag: cipher.getAuthTag()
  };
}

function decryptSecret(encrypted, key, aad) {
  if (!encrypted || Number(encrypted.cipherVersion) !== CIPHER_VERSION) {
    throw new Error('unsupported Weixin credential cipher version');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', requireKey(key), encrypted.nonce);
  decipher.setAAD(aadBuffer(aad));
  decipher.setAuthTag(encrypted.authTag);
  return Buffer.concat([
    decipher.update(encrypted.ciphertext),
    decipher.final()
  ]).toString('utf8');
}

function hashIdentifier(value, key) {
  return crypto
    .createHmac('sha256', requireKey(key))
    .update('weixin:audit:v1\0', 'utf8')
    .update(String(value || ''), 'utf8')
    .digest('hex');
}

module.exports = {
  CIPHER_VERSION,
  decodeMasterKey,
  decryptSecret,
  encryptSecret,
  hashIdentifier
};
