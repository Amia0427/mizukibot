const crypto = require('crypto');
const config = require('../config');

const briefsBySession = new Map();

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeSessionKey(sessionKey = '', userId = '') {
  return normalizeText(sessionKey) || `user:${normalizeText(userId) || 'unknown'}`;
}

function normalizeQuery(query = '') {
  return normalizeText(query).toLowerCase().replace(/\s+/g, ' ').slice(0, 240);
}

function stableId(parts = []) {
  return crypto.createHash('sha1').update(parts.map((item) => normalizeText(item)).join('\n')).digest('hex').slice(0, 16);
}

function getDefaultTtlMs() {
  return Math.max(1000, Number(config.RESEARCH_SUBAGENT_CACHE_TTL_MS || 0) || 30 * 60 * 1000);
}

function pruneSession(sessionKey = '', now = Date.now()) {
  const key = normalizeSessionKey(sessionKey);
  const list = Array.isArray(briefsBySession.get(key)) ? briefsBySession.get(key) : [];
  const kept = list.filter((brief) => Number(brief?.expiresAtMs || 0) > now);
  if (kept.length > 0) briefsBySession.set(key, kept);
  else briefsBySession.delete(key);
  return kept;
}

function saveResearchBrief(input = {}, options = {}) {
  const now = Number(options.now || Date.now());
  const sessionKey = normalizeSessionKey(input.sessionKey, input.userId);
  const ttlMs = Math.max(1000, Number(input.ttlMs || options.ttlMs || getDefaultTtlMs()) || getDefaultTtlMs());
  const query = normalizeText(input.query);
  const status = normalizeText(input.status || 'completed') || 'completed';
  const id = normalizeText(input.id) || stableId([sessionKey, query, String(now)]);
  const brief = {
    id,
    sessionKey,
    userId: normalizeText(input.userId),
    query,
    status,
    summary: normalizeText(input.summary),
    sources: Array.isArray(input.sources) ? input.sources.map((source) => ({ ...source })) : [],
    error: normalizeText(input.error),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    createdAtMs: now,
    expiresAtMs: now + ttlMs
  };
  const existing = pruneSession(sessionKey, now).filter((item) => normalizeText(item.id) !== id);
  briefsBySession.set(sessionKey, [brief, ...existing].slice(0, 8));
  return brief;
}

function tokenize(text = '') {
  return Array.from(new Set(
    normalizeQuery(text)
      .split(/[^\p{L}\p{N}]+/u)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2)
  ));
}

function scoreBrief(brief = {}, query = '') {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 1;
  const haystack = normalizeQuery(`${brief.query}\n${brief.summary}\n${(brief.sources || []).map((item) => `${item.title || ''} ${item.url || ''}`).join('\n')}`);
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += 1;
  }
  return score;
}

function getRecentResearchBriefs(sessionKey = '', options = {}) {
  const now = Number(options.now || Date.now());
  const limit = Math.max(1, Math.min(8, Number(options.limit || 3) || 3));
  const query = normalizeText(options.query);
  return pruneSession(sessionKey, now)
    .filter((brief) => normalizeText(brief.status) === 'completed' && normalizeText(brief.summary))
    .map((brief) => ({ brief, score: query ? scoreBrief(brief, query) : 1 }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.brief.createdAtMs || 0) - Number(a.brief.createdAtMs || 0))
    .slice(0, limit)
    .map((entry) => ({ ...entry.brief }));
}

function clearResearchBriefs(sessionKey = '') {
  if (sessionKey) briefsBySession.delete(normalizeSessionKey(sessionKey));
  else briefsBySession.clear();
}

module.exports = {
  clearResearchBriefs,
  getRecentResearchBriefs,
  normalizeQuery,
  saveResearchBrief
};
