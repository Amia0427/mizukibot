const config = require('../config');
const { classifyRecallPollution } = require('./recallPollutionGuard');

const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clamp(value, min = 0, max = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function boolFlag(value) {
  if (value === true) return true;
  const text = normalizeText(value).toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

function normalizeType(item = {}) {
  return normalizeText(
    item.type
    || item.memoryKind
    || item.fieldKey
    || item.semanticSlot
    || item.meta?.memoryKind
    || item.meta?.fieldKey
    || 'fact'
  ).toLowerCase() || 'fact';
}

function normalizeSourceKind(item = {}) {
  return normalizeText(item.sourceKind || item.source || item.meta?.sourceKind || item.meta?.source || '').toLowerCase();
}

function ageDaysOf(item = {}, now = Date.now()) {
  const ts = Number(item.updatedAt || item.createdAt || item.ts || item.meta?.updatedAt || 0) || 0;
  if (!ts) return 0;
  return Math.max(0, (Number(now || Date.now()) - ts) / DAY_MS);
}

function resolveLifecycleDays(item = {}, options = {}) {
  const type = normalizeType(item);
  const kind = normalizeText(item.memoryKind || item.meta?.memoryKind).toLowerCase();
  if (Number(item.expiresAt || item.meta?.expiresAt || 0) > 0) return null;
  if (type === 'topic') return Math.max(3, Number(options.topicTtlDays || config.MEMORY_TOPIC_TTL_DAYS || 21) || 21);
  if (type === 'task' || kind === 'task') return Math.max(7, Number(options.taskTtlDays || config.MEMORY_TASK_TTL_DAYS || 45) || 45);
  if (type === 'goal') return Math.max(30, Number(options.goalTtlDays || config.MEMORY_PROFILE_GOAL_TTL_DAYS || 180) || 180);
  if (kind === 'style' || type.includes('style')) return Math.max(30, Number(options.styleTtlDays || config.MEMORY_PROFILE_STYLE_TTL_DAYS || 180) || 180);
  if (kind === 'jargon') return Math.max(30, Number(options.jargonTtlDays || config.MEMORY_GROUP_JARGON_TTL_DAYS || 120) || 120);
  return null;
}

function tokenize(text = '') {
  const normalized = normalizeText(text).toLowerCase();
  const latin = normalized.match(/[a-z0-9_]+/g) || [];
  const zh = normalized.match(/[\u4e00-\u9fff]{2,}/g) || [];
  return latin.concat(zh);
}

function hasPromptPollution(text = '') {
  const value = normalizeText(text).toLowerCase();
  return /(system\s*prompt|developer\s*message|prompt injection|jailbreak|ignore (previous|above|all).*(instruction|rules?)|泄露.*(提示词|密钥|token)|忽略.*(规则|提示词|指令)|记住.*(系统|开发者|提示词|规则)|route[_ -]?policy|memory[_ -]?schema)/i.test(value);
}

function hasAssistantSelfInstruction(text = '') {
  const value = normalizeText(text).toLowerCase();
  return /(assistant|bot|模型|机器人|瑞希|助手).{0,18}(always|must|should|never|no longer|以后|永久|不再).{0,36}(obey|follow|comply|remember|respond|speak|call|refuse|遵守|服从|记住|回复|称呼|拒绝)/i.test(value)
    || /(你|助手|机器人|瑞希).{0,10}(必须|应该|以后|永久).{0,28}(记住|遵守|服从|回复|称呼|拒绝)/i.test(value)
    || /(以后|永久|always|never).{0,16}(你|助手|assistant|bot|瑞希).{0,24}(必须|应该|must|should|记住|遵守|服从|回复)/i.test(value);
}

function hasVolatileLanguage(text = '') {
  const value = normalizeText(text).toLowerCase();
  return /(maybe|probably|possibly|temporary|for now|today only|just now|刚才|现在|今天|临时|暂时|可能|好像|似乎|大概|有点|随便|玩笑|开玩笑|假设|如果)/i.test(value);
}

function specificityScore(text = '') {
  const value = normalizeText(text);
  if (!value) return 0;
  const tokens = tokenize(value);
  let score = 0.25;
  if (value.length >= 8) score += 0.2;
  if (value.length >= 24) score += 0.16;
  if (tokens.length >= 3) score += 0.18;
  if (tokens.length >= 6) score += 0.12;
  if (/[0-9]|[\u4e00-\u9fff]{2,}|[A-Z][a-z]+/.test(value)) score += 0.09;
  if (hasVolatileLanguage(value)) score -= 0.24;
  if (/^(ok|好|嗯|啊|test|测试|随便)$/i.test(value)) score -= 0.35;
  return clamp(score, 0, 1);
}

function sourceScore(item = {}) {
  const source = normalizeSourceKind(item);
  if (source === 'explicit' || source === 'manual') return 1;
  if (source === 'journal' || source === 'daily_journal' || source === 'migration') return 0.82;
  if (source === 'extractor' || source === 'post_reply_learning') return 0.66;
  if (source === 'test') return 0.58;
  return source ? 0.55 : 0.42;
}

function typeStabilityScore(item = {}) {
  const type = normalizeType(item);
  const kind = normalizeText(item.memoryKind || item.meta?.memoryKind).toLowerCase();
  if (['identity', 'like', 'dislike', 'personality', 'hobby', 'summary', 'impression'].includes(type)) return 0.9;
  if (type === 'goal') return 0.74;
  if (kind === 'style' || type.includes('style')) return 0.72;
  if (type === 'task' || kind === 'task') return 0.56;
  if (type === 'topic') return 0.36;
  return 0.68;
}

function evaluateStaleness(item = {}, options = {}) {
  const now = Number(options.now || Date.now()) || Date.now();
  const expiresAt = Number(item.expiresAt || item.meta?.expiresAt || 0) || 0;
  const lifecycleDays = resolveLifecycleDays(item, options);
  const ageDays = ageDaysOf(item, now);
  if (expiresAt > 0) {
    const expired = now >= expiresAt;
    return {
      checked: true,
      expired,
      hardExpired: expired,
      ageDays,
      ttlDays: Math.max(0, (expiresAt - Number(item.createdAt || item.updatedAt || now)) / DAY_MS),
      reason: expired ? 'expires_at_elapsed' : ''
    };
  }
  if (!lifecycleDays) {
    return { checked: true, expired: false, hardExpired: false, ageDays, ttlDays: null, reason: '' };
  }
  const expired = ageDays > lifecycleDays;
  const hardExpired = ageDays > lifecycleDays * 2;
  return {
    checked: true,
    expired,
    hardExpired,
    ageDays,
    ttlDays: lifecycleDays,
    reason: expired ? `type_ttl_${normalizeType(item)}` : ''
  };
}

function evaluateMemoryQuality(item = {}, options = {}) {
  const text = normalizeText(item.text || item.canonicalText || item.value || item.content);
  const reasons = [];
  const confidence = clamp(item.confidence ?? item.meta?.confidence ?? 0.7, 0, 1);
  const evidenceCount = Math.max(0, Number(item.evidenceCount || item.meta?.evidenceCount || 0) || 0);
  const importance = clamp(item.importance ?? item.meta?.importance ?? 1, 0, 3) / 3;
  const stale = evaluateStaleness(item, options);
  const explicit = normalizeSourceKind(item) === 'explicit' || normalizeSourceKind(item) === 'manual';

  if (!text) reasons.push('empty_text');
  if (text && text.length < Math.max(2, Number(options.minTextChars || config.MEMORY_PROFILE_MIN_TEXT_CHARS || 2) || 2)) reasons.push('too_short');
  if (confidence < Math.max(0.01, Number(options.minConfidence || config.MEMORY_EXTRACT_MIN_CONFIDENCE || 0.72) || 0.72)) reasons.push('low_confidence');
  if (hasPromptPollution(text)) reasons.push('prompt_pollution');
  if (hasAssistantSelfInstruction(text)) reasons.push('assistant_self_instruction');
  const pollution = classifyRecallPollution(text, { allowBenignContext: true });
  if (pollution.polluted) {
    reasons.push('memory_pollution', ...pollution.reasons);
  }
  if (hasVolatileLanguage(text)) reasons.push('volatile_or_hypothetical');
  if (stale.expired) reasons.push(stale.reason || 'stale');

  const specificity = specificityScore(text);
  const source = sourceScore(item);
  const evidence = clamp((evidenceCount || 1) / 3, 0.2, 1);
  const stability = typeStabilityScore(item);
  const recency = stale.ttlDays ? clamp(1 - (stale.ageDays / Math.max(1, stale.ttlDays * 2)), 0, 1) : 0.82;
  const score = clamp(
    confidence * 0.28
    + specificity * 0.24
    + source * 0.16
    + evidence * 0.12
    + stability * 0.12
    + recency * 0.05
    + importance * 0.03,
    0,
    1
  );

  const rejectThreshold = clamp(options.rejectThreshold ?? process.env.MEMORY_QUALITY_REJECT_THRESHOLD ?? 0.26, 0.01, 0.95);
  const candidateThreshold = clamp(options.candidateThreshold ?? process.env.MEMORY_QUALITY_CANDIDATE_THRESHOLD ?? 0.58, rejectThreshold, 0.99);
  const severe = reasons.includes('prompt_pollution')
    || reasons.includes('assistant_self_instruction')
    || reasons.includes('memory_pollution')
    || reasons.includes('empty_text');
  const type = normalizeType(item);
  const stableProfileType = ['summary', 'impression', 'identity', 'like', 'dislike', 'personality', 'hobby'].includes(type);
  const shouldReject = severe || score < rejectThreshold;
  const shouldCandidate = !shouldReject && (
    score < candidateThreshold
    || stale.expired
    || (reasons.includes('volatile_or_hypothetical') && (!stableProfileType || score < candidateThreshold + 0.12))
  );
  const cleanupAction = shouldReject
    ? 'reject'
    : (stale.hardExpired && !explicit ? 'archive' : (shouldCandidate ? 'candidate' : 'keep'));

  return {
    checked: true,
    score,
    grade: score >= 0.78 ? 'high' : (score >= candidateThreshold ? 'medium' : (score >= rejectThreshold ? 'low' : 'reject')),
    reasons: Array.from(new Set(reasons)),
    severe,
    shouldReject,
    shouldCandidate,
    cleanupAction,
    stale,
    components: {
      confidence,
      specificity,
      source,
      evidence,
      stability,
      recency,
      importance
    }
  };
}

function buildMemoryQualityMeta(quality = {}) {
  return {
    checked: true,
    score: Number(Number(quality.score || 0).toFixed(4)),
    grade: normalizeText(quality.grade || ''),
    action: normalizeText(quality.cleanupAction || ''),
    reasons: Array.isArray(quality.reasons) ? quality.reasons.slice(0, 12) : [],
    stale: {
      expired: quality.stale?.expired === true,
      hardExpired: quality.stale?.hardExpired === true,
      ageDays: Number(Number(quality.stale?.ageDays || 0).toFixed(2)),
      ttlDays: quality.stale?.ttlDays === null ? null : Number(Number(quality.stale?.ttlDays || 0).toFixed(2)),
      reason: normalizeText(quality.stale?.reason || '')
    }
  };
}

function buildMemoryQualityReport(items = [], options = {}) {
  const limit = Math.max(1, Number(options.limit || 20) || 20);
  const report = {
    scanned: 0,
    active: 0,
    candidate: 0,
    archived: 0,
    keep: 0,
    candidateSuggested: 0,
    archiveSuggested: 0,
    rejectSuggested: 0,
    stale: 0,
    polluted: 0,
    lowQuality: 0,
    byReason: {},
    samples: []
  };
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    report.scanned += 1;
    const status = normalizeText(item.status || 'active').toLowerCase();
    if (status === 'archived') report.archived += 1;
    else if (status === 'candidate') report.candidate += 1;
    else report.active += 1;
    const quality = evaluateMemoryQuality(item, options);
    if (quality.cleanupAction === 'keep') report.keep += 1;
    if (quality.cleanupAction === 'candidate') report.candidateSuggested += 1;
    if (quality.cleanupAction === 'archive') report.archiveSuggested += 1;
    if (quality.cleanupAction === 'reject') report.rejectSuggested += 1;
    if (quality.stale?.expired) report.stale += 1;
    if (quality.reasons.includes('prompt_pollution') || quality.reasons.includes('assistant_self_instruction')) report.polluted += 1;
    if (quality.grade === 'low' || quality.grade === 'reject') report.lowQuality += 1;
    for (const reason of quality.reasons) {
      report.byReason[reason] = (report.byReason[reason] || 0) + 1;
    }
    if (quality.cleanupAction !== 'keep' && report.samples.length < limit) {
      report.samples.push({
        id: normalizeText(item.id || item.nodeId),
        userId: normalizeText(item.userId),
        type: normalizeType(item),
        status,
        action: quality.cleanupAction,
        score: Number(Number(quality.score || 0).toFixed(4)),
        reasons: quality.reasons,
        text: normalizeText(item.text || item.canonicalText).slice(0, 180)
      });
    }
  }
  return report;
}

module.exports = {
  buildMemoryQualityMeta,
  buildMemoryQualityReport,
  evaluateMemoryQuality,
  evaluateStaleness,
  hasAssistantSelfInstruction,
  hasPromptPollution,
  hasVolatileLanguage
};
