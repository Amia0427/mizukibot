const crypto = require('crypto');

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value || '').trim();
}

function makeJobId() {
  return `post_reply_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function stableHash(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value || {})).digest('hex');
}

function clampPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

module.exports = {
  clampPositiveInt,
  makeJobId,
  normalizeArray,
  normalizeObject,
  normalizeText,
  nowIso,
  stableHash
};
