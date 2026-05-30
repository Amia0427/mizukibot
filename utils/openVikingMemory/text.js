function normalizeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function stableHash(value = '') {
  const crypto = require('crypto');
  return crypto
    .createHash('sha1')
    .update(String(value || ''))
    .digest('hex')
    .slice(0, 16);
}

function estimateTokens(value = '') {
  const text = normalizeText(value);
  if (!text) return 0;
  let cjkChars = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x3400 && code <= 0x9fff) cjkChars += 1;
  }
  const latinChars = Math.max(0, text.length - cjkChars);
  return Math.max(1, cjkChars + Math.ceil(latinChars / 4));
}

function clampText(value = '', maxChars = 1000) {
  const text = normalizeText(value);
  const limit = Math.max(0, Number(maxChars || 0) || 0);
  if (!limit || text.length <= limit) return text;
  return `${Array.from(text).slice(0, Math.max(0, limit - 3)).join('')}...`;
}

function canonicalRecallText(value = '') {
  return normalizeText(value)
    .toLowerCase()
    .replace(/\b(?:prefers?|preference|favorite|favourite|likes?|loves?|enjoys?)\b/g, 'like')
    .replace(/\[(?:openvikingrecall|openviking-context|retrievedmemorylite|retrievedmemory|relevantevidence|weakevidence|sessioncontinuity|taskmemory|groupmemory|stylesignals|dailyjournal|longtermprofile|memosrecall)\]/gi, ' ')
    .replace(/<\/?openviking-context>/gi, ' ')
    .replace(/\b(?:score|source|uri|ref|from|venue|time|date)\s*=\s*[\w:./+-]+/gi, ' ')
    .replace(/^\s*\d+[.)、]\s*/gm, ' ')
    .replace(/[，。！？；：、,.!?;:]/g, ' ')
    .replace(/(?:然后|并且|而且|以及|另外|同时|先|再|会|了|的)/g, ' ')
    .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function charNgrams(text = '', n = 3) {
  const compact = canonicalRecallText(text).replace(/\s+/g, '');
  if (!compact) return [];
  if (compact.length <= n) return [compact];
  const grams = [];
  for (let index = 0; index <= compact.length - n; index += 1) {
    grams.push(compact.slice(index, index + n));
  }
  return grams;
}

function diceCoefficient(a = '', b = '') {
  const gramsA = charNgrams(a);
  const gramsB = charNgrams(b);
  if (gramsA.length === 0 || gramsB.length === 0) return 0;
  const counts = new Map();
  for (const gram of gramsA) counts.set(gram, (counts.get(gram) || 0) + 1);
  let overlap = 0;
  for (const gram of gramsB) {
    const count = counts.get(gram) || 0;
    if (count <= 0) continue;
    overlap += 1;
    if (count === 1) counts.delete(gram);
    else counts.set(gram, count - 1);
  }
  return (2 * overlap) / (gramsA.length + gramsB.length);
}

module.exports = {
  canonicalRecallText,
  charNgrams,
  clampNumber,
  clampText,
  diceCoefficient,
  estimateTokens,
  normalizeArray,
  normalizeObject,
  normalizeText,
  stableHash
};
