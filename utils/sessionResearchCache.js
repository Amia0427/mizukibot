const crypto = require('crypto');
const config = require('../config');

const MAX_BRIEFS_PER_SESSION = 8;
const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

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
  return Math.max(1000, Number(config.RESEARCH_SUBAGENT_CACHE_TTL_MS || 0) || DEFAULT_CACHE_TTL_MS);
}

function normalizePositiveInteger(value, fallback, minimum = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.floor(parsed));
}

class SessionResearchCache {
  constructor(options = {}) {
    this.briefsBySession = new Map();
    this.clock = typeof options.now === 'function' ? options.now : Date.now;
    this.scheduleInterval = typeof options.setInterval === 'function' ? options.setInterval : setInterval;
    this.cancelInterval = typeof options.clearInterval === 'function' ? options.clearInterval : clearInterval;
    this.maxSessions = normalizePositiveInteger(
      options.maxSessions,
      normalizePositiveInteger(config.RESEARCH_SUBAGENT_CACHE_MAX_SESSIONS, DEFAULT_MAX_SESSIONS)
    );
    this.defaultTtlMs = normalizePositiveInteger(options.defaultTtlMs, getDefaultTtlMs(), 1000);
    this.sweepIntervalMs = normalizePositiveInteger(
      options.sweepIntervalMs,
      normalizePositiveInteger(config.RESEARCH_SUBAGENT_CACHE_SWEEP_INTERVAL_MS, DEFAULT_SWEEP_INTERVAL_MS, 1000),
      1000
    );
    this.autoSweep = options.autoSweep !== false;
    this.sweepTimer = null;
    this.evictions = 0;
    this.expired = 0;
  }

  resolveNow(value) {
    if (value !== undefined && value !== null && value !== '') {
      const explicit = Number(value);
      if (Number.isFinite(explicit)) return explicit;
    }
    const current = Number(this.clock());
    return Number.isFinite(current) ? current : Date.now();
  }

  pruneSession(sessionKey, now) {
    const list = this.briefsBySession.get(sessionKey);
    if (!Array.isArray(list)) return [];
    const kept = list.filter((brief) => Number(brief?.expiresAtMs || 0) > now);
    this.expired += list.length - kept.length;
    if (kept.length === 0) {
      this.briefsBySession.delete(sessionKey);
    } else if (kept.length !== list.length) {
      this.briefsBySession.set(sessionKey, kept);
    }
    return kept;
  }

  pruneExpired(now) {
    for (const sessionKey of Array.from(this.briefsBySession.keys())) {
      this.pruneSession(sessionKey, now);
    }
  }

  touchSession(sessionKey, briefs) {
    this.briefsBySession.delete(sessionKey);
    this.briefsBySession.set(sessionKey, briefs);
  }

  trimToCapacity() {
    while (this.briefsBySession.size > this.maxSessions) {
      const oldestSessionKey = this.briefsBySession.keys().next().value;
      if (oldestSessionKey === undefined) return;
      this.briefsBySession.delete(oldestSessionKey);
      this.evictions += 1;
    }
  }

  ensureSweepTimer() {
    if (!this.autoSweep || this.sweepTimer || this.briefsBySession.size === 0) return;
    this.sweepTimer = this.scheduleInterval(() => {
      this.sweep();
    }, this.sweepIntervalMs);
    this.sweepTimer?.unref?.();
  }

  stopSweepTimer() {
    if (!this.sweepTimer) return false;
    this.cancelInterval(this.sweepTimer);
    this.sweepTimer = null;
    return true;
  }

  sweep(options = {}) {
    const now = this.resolveNow(options.now);
    this.pruneExpired(now);
    if (this.briefsBySession.size === 0) this.stopSweepTimer();
    return this.snapshotMetrics();
  }

  snapshotMetrics() {
    let briefCount = 0;
    for (const briefs of this.briefsBySession.values()) {
      briefCount += Array.isArray(briefs) ? briefs.length : 0;
    }
    return {
      scope: 'process-local',
      size: {
        sessions: this.briefsBySession.size,
        briefs: briefCount
      },
      evictions: this.evictions,
      expired: this.expired
    };
  }

  getMetrics(options = {}) {
    return this.sweep(options);
  }

  saveResearchBrief(input = {}, options = {}) {
    const now = this.resolveNow(options.now);
    const sessionKey = normalizeSessionKey(input.sessionKey, input.userId);
    if (!this.briefsBySession.has(sessionKey) && this.briefsBySession.size >= this.maxSessions) {
      this.pruneExpired(now);
    }
    const ttlMs = normalizePositiveInteger(input.ttlMs || options.ttlMs, this.defaultTtlMs, 1000);
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
    const existing = this.pruneSession(sessionKey, now)
      .filter((item) => normalizeText(item.id) !== id);
    this.touchSession(sessionKey, [brief, ...existing].slice(0, MAX_BRIEFS_PER_SESSION));
    this.trimToCapacity();
    this.ensureSweepTimer();
    return brief;
  }

  getRecentResearchBriefs(sessionKey = '', options = {}) {
    const now = this.resolveNow(options.now);
    const key = normalizeSessionKey(sessionKey);
    const limit = Math.max(1, Math.min(MAX_BRIEFS_PER_SESSION, Number(options.limit || 3) || 3));
    const query = normalizeText(options.query);
    const briefs = this.pruneSession(key, now);
    if (briefs.length === 0) {
      if (this.briefsBySession.size === 0) this.stopSweepTimer();
      return [];
    }
    this.touchSession(key, briefs);
    return briefs
      .filter((brief) => normalizeText(brief.status) === 'completed' && normalizeText(brief.summary))
      .map((brief) => ({ brief, score: query ? scoreBrief(brief, query) : 1 }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || Number(b.brief.createdAtMs || 0) - Number(a.brief.createdAtMs || 0))
      .slice(0, limit)
      .map((entry) => ({ ...entry.brief }));
  }

  clearResearchBriefs(sessionKey = '') {
    if (sessionKey) this.briefsBySession.delete(normalizeSessionKey(sessionKey));
    else this.briefsBySession.clear();
    if (this.briefsBySession.size === 0) this.stopSweepTimer();
  }

  stop() {
    this.stopSweepTimer();
  }
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

function createSessionResearchCache(options = {}) {
  return new SessionResearchCache(options);
}

const defaultResearchCache = createSessionResearchCache();

function saveResearchBrief(input = {}, options = {}) {
  return defaultResearchCache.saveResearchBrief(input, options);
}

function getRecentResearchBriefs(sessionKey = '', options = {}) {
  return defaultResearchCache.getRecentResearchBriefs(sessionKey, options);
}

function clearResearchBriefs(sessionKey = '') {
  return defaultResearchCache.clearResearchBriefs(sessionKey);
}

function getResearchCacheMetrics(options = {}) {
  return defaultResearchCache.getMetrics(options);
}

function stopResearchCache() {
  return defaultResearchCache.stop();
}

function sweepResearchBriefs(options = {}) {
  return defaultResearchCache.sweep(options);
}

module.exports = {
  clearResearchBriefs,
  createSessionResearchCache,
  getRecentResearchBriefs,
  getResearchCacheMetrics,
  normalizeQuery,
  saveResearchBrief,
  stopResearchCache,
  sweepResearchBriefs
};
