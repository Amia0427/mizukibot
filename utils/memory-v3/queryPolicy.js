const config = require('../../config');
const {
  canonicalizeText,
  normalizeText,
  uniqueBy
} = require('./helpers');

function looksLikePollutedSessionSummary(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return /\[(KnownSummary|KnownImpression|Identity|Likes|Dislikes|Goals|KnownFacts|RelevantRecall|RecentTopics)\]/i.test(normalized);
}

function classifyFacet(query = '', options = {}) {
  const text = normalizeText(query).toLowerCase();
  if (String(options.facet || '').trim()) return String(options.facet).trim().toLowerCase();
  if (/(刚才|刚刚|继续|接着|上次|之前|记得|left off|where.*leave|continue|remember)/i.test(text)) return 'continuity';
  if (/(昨天|昨日|前天|今天|聊了什么|回忆|日记|journal|前几天|那天|最近发生)/i.test(text)) return 'journal';
  if (/(喜欢|不喜欢|偏好|prefer|like|dislike|nickname|称呼)/i.test(text)) return 'preference';
  if (/(是谁|身份|背景|identity|occupation|profile)/i.test(text)) return 'identity';
  if (/(策略|怎么做|task|workflow|strategy|avoid)/i.test(text)) return 'task';
  if (/(群里|group|shared|大家|共同)/i.test(text)) return 'group';
  if (/(语气|风格|口癖|style|tone|jargon|黑话)/i.test(text)) return 'style';
  if (/(前几天|最近发生|journal|日记|那天|最近)/i.test(text)) return 'journal';
  if (/(关系|态度|我们现在|亲密|distance|tone|relationship)/i.test(text)) return 'relationship';
  return 'default';
}

function sourceHalfLifeDays(source = '', type = '') {
  const normalizedSource = normalizeText(source).toLowerCase();
  const normalizedType = normalizeText(type).toLowerCase();
  if (normalizedSource === 'recent') return 14;
  if (normalizedSource === 'task') return 90;
  if (normalizedSource === 'journal') return 120;
  if (normalizedSource === 'profile' || normalizedType === 'identity' || normalizedType === 'impression') return 1200;
  if (normalizedType === 'topic') return Math.max(3, Number(config.MEMORY_TOPIC_TTL_DAYS || 21) || 21) / 2;
  return 360;
}

function calcMemoryStrength(candidate = {}, facet = 'default') {
  const now = Date.now();
  const anchor = Number(candidate.lastRecalledAt || candidate.lastAccessAt || candidate.lastConfirmedAt || candidate.updatedAt || candidate.createdAt || 0) || now;
  const ageDays = Math.max(0, (now - anchor) / (24 * 3600 * 1000));
  const halfLife = Math.max(1, sourceHalfLifeDays(candidate.source, candidate.type));
  const minRecency = candidate.source === 'profile' ? 0.95 : (candidate.source === 'recent' ? 0.35 : 0.65);
  const decayScore = minRecency + ((1 - minRecency) * Math.exp(-ageDays / halfLife));
  const recallCount = Math.max(0, Number(candidate.recallCount || candidate.accessCount || 0) || 0);
  const stabilityScore = Math.max(0, Math.min(1, Number(candidate.stabilityScore || 0) || 0));
  const rehearsalBoost = config.MEMORY_REHEARSAL_ENABLED === false
    ? 0
    : Math.min(0.18, (Math.log1p(recallCount) * 0.03) + (stabilityScore * 0.08));
  const continuityBonus = facet === 'continuity' && (candidate.source === 'recent' || candidate.source === 'task' || candidate.source === 'journal')
    ? Math.max(0, Number(config.MEMORY_CONTINUITY_RECALL_BONUS || 0.18) || 0.18)
    : 0;
  const memoryStrength = Math.max(0, Math.min(1.5, decayScore + rehearsalBoost + continuityBonus));
  return {
    decayScore,
    rehearsalBoost,
    continuityRecallBonus: continuityBonus,
    memoryStrength,
    forgettingReason: ageDays > halfLife ? 'past_half_life' : (recallCount > 0 ? 'rehearsed' : 'fresh_or_unrehearsed')
  };
}

function rewriteQuery(query = '', facet = 'default') {
  const base = normalizeText(query);
  const out = [base];
  if (!base) return out;
  if (facet === 'preference') out.push(`${base} 喜欢 偏好 口味 习惯 不喜欢 dislike like preference`);
  if (facet === 'continuity') out.push(`${base} 刚才 上次 继续 接着 recent continuity pending`);
  if (facet === 'identity') out.push(`${base} 身份 背景 自我介绍 画像 identity profile`);
  if (facet === 'task') out.push(`${base} strategy trigger avoid outcome task`);
  if (facet === 'style') out.push(`${base} style tone phrasing jargon`);
  if (facet === 'journal') out.push(`${base} 最近 发生 记录 日记 回忆 journal episode`);
  if (facet === 'relationship') out.push(`${base} relationship tone attitude distance`);
  return uniqueBy(out.filter(Boolean).slice(0, Math.min(2, Math.max(1, Number(config.MEMORY_V3_QUERY_REWRITE_LIMIT || 2)))), (item) => canonicalizeText(item));
}

function shouldCollectSourceForQuery(source = '', facet = 'default', requestedSource = 'all') {
  const normalizedSource = normalizeText(source).toLowerCase();
  const normalizedFacet = normalizeText(facet || 'default').toLowerCase();
  const wanted = normalizeText(requestedSource || 'all').toLowerCase();
  if (wanted && wanted !== 'all') {
    if (wanted === 'personal') return normalizedSource === 'personal' || normalizedSource === 'profile';
    return normalizedSource === wanted;
  }
  const byFacet = {
    preference: new Set(['recent', 'personal', 'profile']),
    identity: new Set(['recent', 'personal', 'profile']),
    relationship: new Set(['recent', 'personal', 'profile', 'style']),
    continuity: new Set(['recent', 'task', 'journal']),
    task: new Set(['task']),
    group: new Set(['group', 'jargon']),
    style: new Set(['personal', 'profile', 'style', 'jargon']),
    journal: new Set(['journal'])
  };
  const allowed = byFacet[normalizedFacet];
  return allowed ? allowed.has(normalizedSource) : true;
}

module.exports = {
  calcMemoryStrength,
  classifyFacet,
  looksLikePollutedSessionSummary,
  rewriteQuery,
  shouldCollectSourceForQuery,
  sourceHalfLifeDays
};
