const fs = require('fs');
const path = require('path');
const config = require('../../config');

const STORE_FILE = String(config.STYLE_PROFILE_STORE_FILE || path.join(config.DATA_DIR, 'style_profile.json')).trim();
const STYLE_STORE_DIR = path.join(path.dirname(STORE_FILE), 'style');
const STYLE_GLOBAL_FILE = path.join(STYLE_STORE_DIR, 'global.json');
const STYLE_GROUP_DIR = path.join(STYLE_STORE_DIR, 'group');
const GLOBAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const GROUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const GLOBAL_SAMPLE_LIMIT = 400;
const GROUP_SAMPLE_LIMIT = 300;
const MAX_COMMON_ENDINGS = 4;

function nowMs() {
  return Date.now();
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function atomicWriteJson(filePath, data) {
  const tempFile = `${filePath}.${process.pid}.tmp`;
  const body = JSON.stringify(data, null, 2);
  try {
    fs.writeFileSync(tempFile, body, 'utf8');
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    try {
      fs.writeFileSync(filePath, body, 'utf8');
    } finally {
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch (_) {}
    }
    if (error && error.code !== 'EPERM') throw error;
  }
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeText(value, maxChars = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function normalizeId(value) {
  return normalizeText(value, 80);
}

function clampNumber(value, min, max, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

module.exports = {
  GLOBAL_SAMPLE_LIMIT,
  GLOBAL_WINDOW_MS,
  GROUP_SAMPLE_LIMIT,
  GROUP_WINDOW_MS,
  MAX_COMMON_ENDINGS,
  STORE_FILE,
  STYLE_GLOBAL_FILE,
  STYLE_GROUP_DIR,
  STYLE_STORE_DIR,
  atomicWriteJson,
  clampNumber,
  ensureDir,
  normalizeArray,
  normalizeId,
  normalizeText,
  nowMs,
  safeReadJson
};
