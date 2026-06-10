const config = require('../../config');
const { normalizeText } = require('./helpers');

const RECENT_QUERY_RE = /(刚才|刚刚|刚才说|刚说|前面|之前|上次|接着|继续|还没|聊到哪|说到哪|最近|今天|今日|昨天|昨日|前天|\bearlier\b|\blast time\b|\brecent\b|\btoday\b|\byesterday\b|\bcontinue\b|\bwhere did we leave\b|\bwhat did we talk\b)/i;
const SAME_DAY_RE = /(今天|今日|\btoday\b)/i;
const YESTERDAY_RE = /(昨天|昨日|\byesterday\b)/i;

function detectRecentRecallIntent(query = '', options = {}) {
  const text = normalizeText(query);
  const explicit = options.forceRecentRecall === true || options.recentRecall === true;
  const matched = explicit || RECENT_QUERY_RE.test(text);
  const sameDay = SAME_DAY_RE.test(text);
  const yesterday = YESTERDAY_RE.test(text);
  return {
    matched,
    sameDay,
    yesterday,
    shouldPreferRecent: matched,
    sourceBoosts: matched
      ? {
          recent: sameDay || text.includes('刚') ? 1.55 : 1.35,
          journal: sameDay || yesterday ? 1.42 : 1.18,
          task: 1.22,
          personal: 0.88,
          profile: 0.86
        }
      : {}
  };
}

function recentSourceBoost(candidate = {}, intent = {}) {
  if (!intent?.shouldPreferRecent) return 1;
  const source = normalizeText(candidate.source || 'personal').toLowerCase();
  const boosts = intent.sourceBoosts || {};
  return Number(boosts[source] || 1) || 1;
}

function recentCandidateBonus(candidate = {}, intent = {}, options = {}) {
  if (!intent?.shouldPreferRecent) return 0;
  const source = normalizeText(candidate.source || '').toLowerCase();
  const base = {
    recent: 0.42,
    journal: intent.sameDay || intent.yesterday ? 0.34 : 0.18,
    task: 0.2,
    personal: -0.04,
    profile: -0.06
  }[source] || 0;
  const now = Math.max(0, Number(options.now || Date.now()) || Date.now());
  const updatedAt = Math.max(0, Number(candidate.updatedAt || candidate.createdAt || 0) || 0);
  if (!updatedAt || base <= 0) return base;
  const ageHours = Math.max(0, (now - updatedAt) / (3600 * 1000));
  const freshness = Math.max(0, Math.min(1, 1 - (ageHours / Math.max(1, Number(config.MEMORY_RECENT_RECALL_HALF_LIFE_HOURS || 48) || 48))));
  return base + (freshness * 0.18);
}

function shouldRecentFallbackCandidate(candidate = {}, intent = {}) {
  if (!intent?.shouldPreferRecent) return false;
  const source = normalizeText(candidate.source || '').toLowerCase();
  return source === 'recent' || source === 'task' || source === 'journal';
}

function buildRecentFallbackCandidates(candidates = [], intent = {}, options = {}) {
  if (!intent?.shouldPreferRecent) return [];
  const limit = Math.max(0, Math.min(8, Number(options.limit || config.MEMORY_RECENT_RECALL_FALLBACK_LIMIT || 4) || 4));
  if (limit <= 0) return [];
  return (Array.isArray(candidates) ? candidates : [])
    .filter((item) => shouldRecentFallbackCandidate(item, intent))
    .filter((item) => normalizeText(item.text))
    .sort((a, b) => {
      const sourceRank = (source) => source === 'recent' ? 3 : source === 'journal' ? 2 : source === 'task' ? 1 : 0;
      const sourceDelta = sourceRank(normalizeText(b.source).toLowerCase()) - sourceRank(normalizeText(a.source).toLowerCase());
      if (sourceDelta !== 0) return sourceDelta;
      return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    })
    .slice(0, limit)
    .map((item) => ({
      ...item,
      score: Math.max(Number(item.score || 0) || 0, 0.36 + recentCandidateBonus(item, intent, options)),
      lexical: Number(item.lexical || 0) || 0,
      matchMode: item.matchMode || 'recent_fallback',
      selectionReason: [normalizeText(item.selectionReason), 'recent_recall_fallback'].filter(Boolean).join('|'),
      scoreParts: {
        ...(item.scoreParts || {}),
        recentFallback: 1,
        recentBonus: recentCandidateBonus(item, intent, options)
      }
    }));
}

module.exports = {
  buildRecentFallbackCandidates,
  detectRecentRecallIntent,
  recentCandidateBonus,
  recentSourceBoost,
  shouldRecentFallbackCandidate
};
