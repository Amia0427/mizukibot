const fs = require('fs');
const path = require('path');
const { getJsonLineWriter } = require('../storeRegistry');

function ensureDir(dirPath) {
  const dir = String(dirPath || '').trim();
  if (!dir) return;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!String(raw || '').trim()) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function atomicWriteText(filePath, text) {
  ensureDir(path.dirname(filePath));
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempFile, String(text || ''), 'utf8');
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    try {
      fs.writeFileSync(filePath, String(text || ''), 'utf8');
    } finally {
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch (_) {}
    }
    if (error && error.code !== 'EPERM' && error.code !== 'EXDEV') throw error;
  }
}

function atomicWriteJson(filePath, value) {
  atomicWriteText(filePath, JSON.stringify(value, null, 2));
}

function appendLine(filePath, line) {
  getJsonLineWriter(filePath).append(String(line || ''));
}

function safeReadJsonLines(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    return String(raw || '')
      .split(/\r?\n/)
      .map((line) => String(line || '').trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function writeJsonLines(filePath, rows = []) {
  const lines = (Array.isArray(rows) ? rows : [])
    .filter(Boolean)
    .map((row) => JSON.stringify(row));
  atomicWriteText(filePath, lines.join('\n'));
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clampText(value, maxChars = 400) {
  const text = normalizeText(value);
  if (!text) return '';
  const limit = Math.max(1, Number(maxChars) || 1);
  return text.length > limit ? text.slice(0, limit) : text;
}

function normalizeArray(values = [], mapper = null) {
  const list = Array.isArray(values) ? values : [];
  const output = [];
  for (const item of list) {
    const next = typeof mapper === 'function' ? mapper(item) : item;
    if (next === undefined || next === null || next === '') continue;
    output.push(next);
  }
  return output;
}

function uniqueBy(values = [], makeKey = (value) => value) {
  const output = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const key = String(makeKey(value) || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function canonicalizeText(text) {
  return normalizeText(text)
    .toLowerCase()
    .replace(/^likes?(?:[:：]|\s)*/i, '')
    .replace(/^dislikes?(?:[:：]|\s)*/i, '')
    .replace(/^goal(?:[:：]|\s)*/i, '')
    .replace(/^summary(?:[:：]|\s)*/i, '')
    .replace(/^impression(?:[:：]|\s)*/i, '')
    .replace(/^identity(?:[:：]|\s)*/i, '')
    .replace(/^personality(?:[:：]|\s)*/i, '')
    .replace(/^recent topic(?:[:：]|\s)*/i, '')
    .replace(/^style(?:[:：]|\s)*/i, '')
    .replace(/^group jargon(?:[:：]|\s)*/i, '')
    .replace(/[^\u4e00-\u9fa5a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  const normalized = canonicalizeText(text);
  if (!normalized) return [];
  const out = [];
  const words = normalized.match(/[a-z0-9]+/g) || [];
  out.push(...words);
  const zhChunks = normalized.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const chunk of zhChunks) {
    if (chunk.length <= 4) out.push(chunk);
    for (let i = 0; i < chunk.length - 1; i += 1) {
      out.push(chunk.slice(i, i + 2));
    }
  }
  return out;
}

function cosineFromTokenSets(queryTokens = [], docTokens = []) {
  const qMap = new Map();
  const dMap = new Map();
  for (const token of queryTokens) qMap.set(token, (qMap.get(token) || 0) + 1);
  for (const token of docTokens) dMap.set(token, (dMap.get(token) || 0) + 1);

  let dot = 0;
  let qNorm = 0;
  let dNorm = 0;

  for (const value of qMap.values()) qNorm += value * value;
  for (const value of dMap.values()) dNorm += value * value;
  for (const [token, value] of qMap.entries()) {
    if (dMap.has(token)) dot += value * dMap.get(token);
  }

  if (qNorm <= 0 || dNorm <= 0) return 0;
  return dot / (Math.sqrt(qNorm) * Math.sqrt(dNorm));
}

function stableSortByScore(items = []) {
  return (Array.isArray(items) ? items : []).slice().sort((a, b) => {
    if (Number(b.score || 0) !== Number(a.score || 0)) return Number(b.score || 0) - Number(a.score || 0);
    if (Number(b.updatedAt || 0) !== Number(a.updatedAt || 0)) return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

module.exports = {
  ensureDir,
  safeReadJson,
  safeReadJsonLines,
  atomicWriteText,
  atomicWriteJson,
  appendLine,
  writeJsonLines,
  normalizeText,
  clampText,
  normalizeArray,
  uniqueBy,
  canonicalizeText,
  tokenize,
  cosineFromTokenSets,
  stableSortByScore
};
