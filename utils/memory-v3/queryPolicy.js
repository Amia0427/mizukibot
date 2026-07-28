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

function buildRecallPlan(input = {}) {
  const query = normalizeText(input.query);
  const facet = normalizeText(input.facet || classifyFacet(query, input)).toLowerCase() || 'default';
  const requestedSource = normalizeText(input.source || 'all').toLowerCase() || 'all';
  const scope = input.scope && typeof input.scope === 'object' ? input.scope : {};
  const base = {
    facet,
    route: 'default',
    reason: 'mixed_recall',
    allowedSources: ['recent', 'profile', 'personal', 'task', 'group', 'jargon', 'style', 'journal'],
    sourceQuotas: {},
    semanticSlotQuotas: {},
    candidateBudget: { local: 96, vector: 64, bm25: 48, rerank: 0 },
    allowRemoteEmbedding: true,
    allowRemoteRerank: true,
    lexicalFirst: false,
    strictEvidenceThreshold: 0.58,
    weakEvidenceThreshold: 0.2,
    scope: {
      userId: normalizeText(input.userId),
      groupId: normalizeText(scope.groupId || input.groupId),
      sessionKey: normalizeText(scope.sessionKey || input.sessionKey || input.sessionId)
    }
  };
  if (requestedSource !== 'all') {
    base.allowedSources = requestedSource === 'personal' ? ['personal', 'profile'] : [requestedSource];
    base.route = `source/${requestedSource}`;
    base.reason = 'explicit_source';
  } else if (facet === 'continuity' || facet === 'journal') {
    base.route = 'continuity/date';
    base.reason = 'date_or_continuity';
    base.allowedSources = ['recent', 'journal', 'task'];
    base.sourceQuotas = { recent: 3, journal: 4, task: 3 };
    base.semanticSlotQuotas = { continuity: 3, episode: 4 };
    base.candidateBudget = { local: 72, vector: 40, bm25: 56, rerank: 0 };
    base.allowRemoteRerank = false;
    base.lexicalFirst = true;
  } else if (['preference', 'identity', 'relationship'].includes(facet)) {
    base.route = 'profile/preference/relationship';
    base.reason = 'stable_profile_or_relationship';
    base.allowedSources = facet === 'relationship'
      ? ['profile', 'personal', 'style', 'recent']
      : ['profile', 'personal', 'recent'];
    base.sourceQuotas = { profile: 3, personal: 3, style: 2, recent: 1 };
    base.semanticSlotQuotas = { preference_like: 2, preference_dislike: 2, relationship: 2, identity: 2 };
    base.candidateBudget = { local: 64, vector: 48, bm25: 40, rerank: 24 };
  } else if (facet === 'task') {
    base.route = 'task';
    base.reason = 'task_only';
    base.allowedSources = ['task', 'recent'];
    base.sourceQuotas = { task: 4, recent: 2 };
    base.semanticSlotQuotas = { task: 4, continuity: 2 };
    base.candidateBudget = { local: 64, vector: 40, bm25: 48, rerank: 24 };
  } else if (facet === 'group' || facet === 'style') {
    base.route = facet === 'group' ? 'group/style' : 'style';
    base.reason = facet === 'group' ? 'group_scope_only' : 'style_scope_only';
    base.allowedSources = facet === 'group' ? ['group', 'jargon'] : ['style', 'jargon', 'profile', 'personal'];
    base.sourceQuotas = facet === 'group'
      ? { group: 4, jargon: 2 }
      : { style: 3, jargon: 2, profile: 2, personal: 2 };
    base.semanticSlotQuotas = { group_jargon: 3, style_pattern: 3, relationship: 2 };
    base.candidateBudget = { local: 64, vector: 40, bm25: 48, rerank: 20 };
  } else {
    base.candidateBudget.rerank = 20;
  }
  return base;
}

function shouldRunRecallRerank(candidates = [], plan = {}, options = {}) {
  if (options.disableRerank === true || config.MEMORY_RERANK_ENABLED === false) return { enabled: false, reason: 'disabled' };
  if (plan.allowRemoteRerank === false) return { enabled: false, reason: 'plan_disallowed' };
  const list = Array.isArray(candidates) ? candidates : [];
  if (list.length < 2) return { enabled: false, reason: 'insufficient_candidates' };
  const sorted = list.slice().sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  const top = sorted[0];
  const second = sorted[1];
  const margin = Math.max(0, Number(top?.score || 0) - Number(second?.score || 0));
  const lexical = Math.max(...list.map((item) => Number(item.lexical || item.bm25 || 0) || 0));
  const highValue = ['preference', 'identity', 'relationship', 'task', 'group', 'style'].includes(normalizeText(plan.facet).toLowerCase());
  const ambiguous = margin <= Math.max(0.04, Number(options.rerankMarginThreshold || 0.08) || 0.08);
  const lexicalWeak = lexical < Math.max(0.08, Number(options.rerankLexicalThreshold || 0.12) || 0.12);
  if (plan.lexicalFirst && !ambiguous && !lexicalWeak) return { enabled: false, reason: 'lexical_confident', margin, lexical };
  return { enabled: highValue || ambiguous || lexicalWeak, reason: highValue ? 'high_value' : (ambiguous ? 'small_score_margin' : 'lexical_weak'), margin, lexical };
}

module.exports = {
  calcMemoryStrength,
  classifyFacet,
  looksLikePollutedSessionSummary,
  rewriteQuery,
  buildRecallPlan,
  shouldRunRecallRerank,
  shouldCollectSourceForQuery,
  sourceHalfLifeDays
};
