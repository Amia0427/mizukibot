const config = require('../../config');
const {
  canonicalizeText,
  clampText,
  normalizeText
} = require('./helpers');
const { classifyRecallPollution } = require('../recallPollutionGuard');

const LONG_LIVED_FIELDS = new Set([
  'identity',
  'personality',
  'hobby',
  'preference_like',
  'preference_dislike',
  'boundary',
  'persona_summary_support',
  'persona_impression_support'
]);

const STYLE_FIELDS = new Set([
  'style_pattern',
  'style_avoid',
  'bot_persona_tone',
  'bot_persona_initiative',
  'bot_persona_boundaries',
  'bot_persona_playfulness',
  'bot_persona_guardedness',
  'bot_persona_verbosity',
  'relationship_tone',
  'relationship_distance',
  'relationship_salutation',
  'relationship_reply_style',
  'relationship_engagement',
  'relationship_boundaries'
]);

const SHORT_LIVED_FIELDS = new Set([
  'topic',
  'recent_topic',
  'current_task',
  'temporary_goal'
]);

const GENERIC_TEXT_RE = /^(ok|okay|好的|好|嗯|嗯嗯|哈哈|测试|test|daily|chat|topic|fact|喜欢|不喜欢|爱好|目标|身份|性格)$/i;
const CORRECTION_RE = /(不是|不对|错了|改了|改成|纠正|别记|不要记|别再|不是这样|以后按|以后叫|以后别)/i;
const TEMPORARY_RE = /(今天|刚刚|刚才|这次|这把|这局|今晚|昨天|临时|暂时|一会儿|等下|最近|当前|正在|准备|打算)/i;
const CORRECTION_FROM_TO_RE = /(?:不是|不对|错了|纠正一下|更正一下|改成|应该是)\s*[“"']?([^，。；;,.!?！？]{1,80})[”"']?\s*(?:，|,|。|;|；|\s)*(?:是|而是|应该是|改成|换成)\s*[“"']?([^，。；;,.!?！？]{1,120})/i;
const CORRECTION_FORGET_RE = /(?:别记|不要记|别再记|忘掉|删掉)\s*[“"']?([^，。；;,.!?！？]{1,120})/i;

function nowMs(options = {}) {
  return Math.max(0, Number(options.now || options.nowTs || Date.now()) || Date.now());
}

function daysToMs(days = 0) {
  const value = Math.max(0, Number(days || 0) || 0);
  return value > 0 ? value * 24 * 3600 * 1000 : 0;
}

function configNumber(name = '', fallback = 0) {
  const value = config[name] ?? process.env[name] ?? fallback;
  return Number(value || fallback) || fallback;
}

function normalizeFieldKey(input = {}) {
  const fieldKey = normalizeText(input.fieldKey || input.semanticSlot || input.type || input.memoryKind).toLowerCase();
  if (fieldKey === 'like') return 'preference_like';
  if (fieldKey === 'dislike') return 'preference_dislike';
  return fieldKey || 'fact';
}

function isProfileField(input = {}) {
  const scopeType = normalizeText(input.scopeType || 'personal').toLowerCase();
  if (scopeType === 'group' || scopeType === 'task' || scopeType === 'session') return false;
  const fieldKey = normalizeFieldKey(input);
  const memoryKind = normalizeText(input.memoryKind || input.type).toLowerCase();
  return LONG_LIVED_FIELDS.has(fieldKey)
    || STYLE_FIELDS.has(fieldKey)
    || SHORT_LIVED_FIELDS.has(fieldKey)
    || ['like', 'dislike', 'identity', 'personality', 'hobby', 'goal', 'boundary', 'summary', 'impression'].includes(memoryKind)
    || fieldKey === 'goal';
}

function resolveProfileTtlMs(input = {}, options = {}) {
  const fieldKey = normalizeFieldKey(input);
  const sourceKind = normalizeText(input.sourceKind || input.source).toLowerCase();
  if (sourceKind === 'explicit' && fieldKey !== 'topic') return 0;
  if (SHORT_LIVED_FIELDS.has(fieldKey)) {
    return daysToMs(options.recentTopicTtlDays ?? configNumber('MEMORY_PROFILE_RECENT_TOPIC_TTL_DAYS', 14));
  }
  if (fieldKey === 'goal') {
    return daysToMs(options.goalTtlDays ?? configNumber('MEMORY_PROFILE_GOAL_TTL_DAYS', 180));
  }
  if (STYLE_FIELDS.has(fieldKey)) {
    return daysToMs(options.styleTtlDays ?? configNumber('MEMORY_PROFILE_STYLE_TTL_DAYS', 180));
  }
  if (LONG_LIVED_FIELDS.has(fieldKey)) {
    return daysToMs(options.stableTtlDays ?? configNumber('MEMORY_PROFILE_STABLE_TTL_DAYS', 540));
  }
  return daysToMs(options.defaultTtlDays ?? configNumber('MEMORY_PROFILE_DEFAULT_TTL_DAYS', 120));
}

function computeExpiresAt(input = {}, options = {}) {
  const explicit = Number(input.expiresAt || input.payload?.expiresAt || input.meta?.expiresAt || 0) || 0;
  if (explicit > 0) return explicit;
  const ttlMs = resolveProfileTtlMs(input, options);
  if (!ttlMs) return 0;
  const anchor = Number(input.lastConfirmedAt || input.updatedAt || input.createdAt || input.ts || 0) || 0;
  return anchor > 0 ? anchor + ttlMs : 0;
}

function computeFreshnessScore(input = {}, options = {}) {
  const current = nowMs(options);
  const updatedAt = Number(input.lastConfirmedAt || input.updatedAt || input.createdAt || input.ts || 0) || 0;
  const expiresAt = computeExpiresAt(input, options);
  if (!updatedAt) return 0.45;
  if (expiresAt > 0) {
    if (expiresAt <= current) return 0;
    const total = Math.max(1, expiresAt - updatedAt);
    return Math.max(0.05, Math.min(1, (expiresAt - current) / total));
  }
  const ageDays = Math.max(0, (current - updatedAt) / (24 * 3600 * 1000));
  const halfLife = Math.max(30, configNumber('MEMORY_PROFILE_FRESHNESS_HALFLIFE_DAYS', 180));
  return Math.max(0.1, Math.min(1, 1 / (1 + (ageDays / halfLife))));
}

function textQualityReasons(type = '', value = '', options = {}) {
  const text = normalizeText(value);
  const reasons = [];
  if (!text) reasons.push('empty_text');
  if (text.length < Math.max(2, Number(options.minChars || configNumber('MEMORY_PROFILE_MIN_TEXT_CHARS', 2)) || 2)) reasons.push('too_short');
  if (text.length > Math.max(40, configNumber('MEMORY_PROFILE_MAX_TEXT_CHARS', 220))) reasons.push('too_long');
  if (GENERIC_TEXT_RE.test(text)) reasons.push('generic_text');
  if (/^(用户|我|他|她|ta)?(喜欢|不喜欢|讨厌|爱好|目标|身份|性格)[:：]?$/.test(text)) reasons.push('label_only');
  const pollution = classifyRecallPollution(text, { allowBenignContext: true });
  if (pollution.polluted) reasons.push('memory_pollution', ...pollution.reasons);
  const normalizedType = normalizeText(type).toLowerCase();
  if (normalizedType === 'topic' && text.length < 4) reasons.push('topic_too_short');
  return reasons;
}

function tokenSet(value = '') {
  const canonical = canonicalizeText(value);
  const tokens = canonical.match(/[a-z0-9]+|[\u4e00-\u9fa5]{1,2}/g) || [];
  const out = new Set();
  for (const token of tokens) {
    if (token) out.add(token);
  }
  for (const chunk of canonical.match(/[\u4e00-\u9fa5]+/g) || []) {
    for (let i = 0; i < chunk.length - 1; i += 1) out.add(chunk.slice(i, i + 2));
  }
  return out;
}

function textSimilarity(left = '', right = '') {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / Math.max(a.size, b.size);
}

function detectProfileCorrection(text = '') {
  const value = normalizeText(text);
  if (!value) return { isCorrection: false, correctedFrom: '', correctedTo: '', reason: '' };
  const replacement = value.match(CORRECTION_FROM_TO_RE);
  if (replacement) {
    return {
      isCorrection: true,
      correctedFrom: normalizeText(replacement[1]),
      correctedTo: normalizeText(replacement[2]),
      reason: 'explicit_replacement'
    };
  }
  const forget = value.match(CORRECTION_FORGET_RE);
  if (forget) {
    return {
      isCorrection: true,
      correctedFrom: normalizeText(forget[1]),
      correctedTo: '',
      reason: 'explicit_forget'
    };
  }
  if (CORRECTION_RE.test(value)) {
    return {
      isCorrection: true,
      correctedFrom: '',
      correctedTo: '',
      reason: 'correction_signal'
    };
  }
  return { isCorrection: false, correctedFrom: '', correctedTo: '', reason: '' };
}

function profileCorrectionMatchesNode(correction = {}, incoming = {}, node = {}) {
  if (!correction || correction.isCorrection !== true) return false;
  if (!isProfileField(node)) return false;
  const status = deriveLifecycleStatus(node);
  if (status === 'archived' || status === 'superseded') return false;
  const incomingUser = normalizeText(incoming.userId);
  const nodeUser = normalizeText(node.userId);
  if (incomingUser && nodeUser && incomingUser !== nodeUser) return false;
  const incomingScope = normalizeText(incoming.scopeType || 'personal').toLowerCase();
  const nodeScope = normalizeText(node.scopeType || 'personal').toLowerCase();
  if (incomingScope && nodeScope && incomingScope !== nodeScope) return false;
  const incomingGroup = normalizeText(incoming.groupId);
  const nodeGroup = normalizeText(node.groupId);
  if ((incomingGroup || nodeGroup) && incomingGroup !== nodeGroup) return false;
  const incomingConflict = normalizeText(incoming.conflictKey || incoming.payload?.conflictKey);
  const nodeConflict = normalizeText(node.conflictKey || node.payload?.conflictKey);
  if (incomingConflict && nodeConflict && incomingConflict === nodeConflict) return true;
  const from = canonicalizeText(correction.correctedFrom);
  const nodeText = canonicalizeText(node.text || node.canonicalText);
  if (from && nodeText && (nodeText.includes(from) || from.includes(nodeText))) return true;
  const to = canonicalizeText(correction.correctedTo);
  if (to && nodeText && textSimilarity(to, nodeText) >= 0.72) return true;
  return false;
}

function buildProfileCorrectionEvents(events = [], incoming = {}, options = {}) {
  const correction = options.correction || detectProfileCorrection(incoming.text || incoming.canonicalText || '');
  if (!correction.isCorrection) return [];
  const sourceKind = normalizeText(incoming.sourceKind || incoming.source).toLowerCase();
  if (sourceKind && sourceKind !== 'explicit' && sourceKind !== 'manual') return [];
  const created = [];
  const incomingId = normalizeText(incoming.id);
  const now = Math.max(0, Number(options.now || incoming.ts || Date.now()) || Date.now());
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || event.type === 'memory_archived') continue;
    const node = {
      id: normalizeText(event.id),
      userId: normalizeText(event.userId),
      groupId: normalizeText(event.groupId),
      scopeType: normalizeText(event.scopeType || 'personal').toLowerCase(),
      sourceKind: normalizeText(event.sourceKind || event.source),
      status: normalizeText(event.status || (event.type === 'memory_candidate_extracted' ? 'candidate' : 'active')).toLowerCase(),
      type: normalizeText(event.payload?.type || event.memoryKind || event.semanticSlot),
      memoryKind: normalizeText(event.memoryKind),
      fieldKey: normalizeText(event.payload?.fieldKey || event.semanticSlot || event.memoryKind),
      semanticSlot: normalizeText(event.semanticSlot),
      conflictKey: normalizeText(event.conflictKey || event.payload?.conflictKey),
      text: normalizeText(event.text),
      canonicalKey: normalizeText(event.canonicalKey || canonicalizeText(event.text)),
      lifecycleStatus: normalizeText(event.lifecycleStatus || event.payload?.lifecycleStatus),
      profileQuality: event.payload?.profileQuality || null
    };
    if (!node.id || node.id === incomingId) continue;
    if (!profileCorrectionMatchesNode(correction, incoming, node)) continue;
    created.push({
      id: node.id,
      type: 'memory_archived',
      ts: now,
      userId: node.userId,
      groupId: node.groupId,
      scopeType: node.scopeType || 'personal',
      source: 'profile_correction',
      sourceKind: 'explicit',
      status: 'archived',
      memoryKind: node.memoryKind || node.type || 'fact',
      semanticSlot: node.semanticSlot || node.fieldKey || node.type || 'fact',
      conflictKey: node.conflictKey,
      text: node.text,
      payload: {
        type: node.type || 'fact',
        fieldKey: node.fieldKey || node.semanticSlot || node.type || 'fact',
        archivedId: node.id,
        archivedReason: 'user_correction_superseded',
        supersededBy: incomingId,
        correction
      }
    });
  }
  return created;
}

function assessProfileWriteQuality(type = '', value = '', confidence = 0, options = {}) {
  const text = normalizeText(value);
  const sourceKind = normalizeText(options.sourceKind || '').toLowerCase();
  const rawConfidence = Number(confidence || 0) || 0;
  const effectiveConfidence = rawConfidence > 0
    ? rawConfidence
    : (sourceKind === 'explicit' ? 1 : 0.8);
  const minConfidence = sourceKind === 'explicit'
    ? Math.max(0, configNumber('MEMORY_PROFILE_EXPLICIT_MIN_CONFIDENCE', 0.2))
    : Math.max(0, configNumber('MEMORY_PROFILE_MIN_CONFIDENCE', config.MEMORY_EXTRACT_MIN_CONFIDENCE || 0.72));
  const reasons = textQualityReasons(type, text, options);
  if (effectiveConfidence < minConfidence) reasons.push('low_confidence');
  if (sourceKind !== 'explicit' && CORRECTION_RE.test(text)) reasons.push('correction_needs_explicit_handling');
  const stableType = ['identity', 'personality', 'hobby', 'like', 'dislike', 'goal', 'summary', 'impression'].includes(normalizeText(type).toLowerCase());
  if (sourceKind !== 'explicit' && stableType && TEMPORARY_RE.test(text)) reasons.push('temporary_language');
  return {
    ok: reasons.length === 0,
    reasons,
    confidence: effectiveConfidence,
    sourceKind,
    text: clampText(text, configNumber('MEMORY_PROFILE_MAX_TEXT_CHARS', 220))
  };
}

function deriveLifecycleStatus(input = {}, options = {}) {
  const current = nowMs(options);
  const rawStatus = normalizeText(input.lifecycleStatus || input.status || 'active').toLowerCase();
  if (rawStatus === 'archived' || rawStatus === 'deleted') return 'archived';
  if (rawStatus === 'superseded') return 'superseded';
  if (rawStatus === 'stale' || rawStatus === 'suspect') return rawStatus;
  if (!isProfileField(input)) return rawStatus || 'active';
  const expiresAt = computeExpiresAt(input, options);
  const quality = input.profileQuality && typeof input.profileQuality === 'object'
    ? input.profileQuality
    : null;
  const reasons = Array.isArray(quality?.reasons) ? quality.reasons : [];
  if (expiresAt > 0 && expiresAt <= current) return 'stale';
  if (quality && quality.ok === false) return 'suspect';
  if (reasons.some((reason) => ['generic_text', 'label_only', 'too_short', 'temporary_language'].includes(reason))) return 'suspect';
  return rawStatus || 'active';
}

function lifecycleHiddenReason(input = {}, options = {}) {
  const status = deriveLifecycleStatus(input, options);
  if (status === 'stale') return 'profile_lifecycle_stale';
  if (status === 'suspect') return 'profile_lifecycle_suspect';
  if (status === 'superseded') return 'profile_lifecycle_superseded';
  if (status === 'archived') return 'archived';
  return '';
}

function applyProfileLifecycle(node = {}, options = {}) {
  if (!node || typeof node !== 'object') return node;
  if (!isProfileField(node)) return node;
  const quality = node.profileQuality && typeof node.profileQuality === 'object'
    ? node.profileQuality
    : assessProfileWriteQuality(node.type || node.memoryKind || node.fieldKey, node.text, node.confidence, {
      ...options,
      sourceKind: node.sourceKind || node.source
    });
  const expiresAt = computeExpiresAt(node, options);
  const freshnessScore = computeFreshnessScore({ ...node, expiresAt }, options);
  const lifecycleStatus = deriveLifecycleStatus({
    ...node,
    expiresAt,
    profileQuality: quality
  }, options);
  const hiddenReason = lifecycleHiddenReason({ ...node, expiresAt, lifecycleStatus, profileQuality: quality }, options);
  return {
    ...node,
    expiresAt,
    freshnessScore,
    lifecycleStatus,
    profileQuality: quality,
    notRecallable: node.notRecallable === true || Boolean(hiddenReason && hiddenReason !== 'archived'),
    recallHiddenReason: hiddenReason || normalizeText(node.recallHiddenReason)
  };
}

function rankLifecycleWinner(node = {}) {
  const status = deriveLifecycleStatus(node);
  const statusRank = status === 'active' ? 4 : status === 'candidate' ? 3 : status === 'suspect' ? 1 : 0;
  const explicit = normalizeText(node.sourceKind).toLowerCase() === 'explicit' ? 4 : 0;
  const strict = normalizeText(node.evidenceTier).toLowerCase() === 'strict' ? 2 : 0;
  return (statusRank * 1000)
    + (explicit * 100)
    + (strict * 50)
    + (Number(node.stabilityScore || 0) * 20)
    + (Number(node.freshnessScore || 0) * 10)
    + Number(node.confidence || 0)
    + (Number(node.updatedAt || 0) / 10000000000000);
}

function applySupersession(nodes = []) {
  const list = Array.isArray(nodes) ? nodes : [];
  const winners = new Map();
  for (const node of list.slice().sort((a, b) => rankLifecycleWinner(b) - rankLifecycleWinner(a))) {
    const conflictKey = normalizeText(node.conflictKey).toLowerCase();
    if (!conflictKey || !isProfileField(node)) continue;
    if (!winners.has(conflictKey) && deriveLifecycleStatus(node) !== 'stale' && deriveLifecycleStatus(node) !== 'suspect') {
      winners.set(conflictKey, node);
    }
  }
  return list.map((node) => {
    const conflictKey = normalizeText(node.conflictKey).toLowerCase();
    const winner = conflictKey ? winners.get(conflictKey) : null;
    if (!winner || String(winner.id || '') === String(node.id || '')) return node;
    if (!isProfileField(node)) return node;
    return {
      ...node,
      lifecycleStatus: 'superseded',
      status: node.status === 'archived' ? 'archived' : node.status,
      supersededBy: String(winner.id || ''),
      suppressedBy: String(winner.id || ''),
      notRecallable: true,
      recallHiddenReason: 'profile_lifecycle_superseded'
    };
  });
}

function buildNearDuplicateProfileKey(node = {}) {
  if (!isProfileField(node)) return '';
  const userId = normalizeText(node.userId);
  const scopeType = normalizeText(node.scopeType || 'personal').toLowerCase() || 'personal';
  const groupId = normalizeText(node.groupId);
  const fieldKey = normalizeFieldKey(node);
  const canonical = canonicalizeText(node.canonicalKey || node.text);
  if (!userId || !canonical) return '';
  const compact = canonical.replace(/\s+/g, '');
  const prefixLength = compact.length >= 12 ? 12 : compact.length >= 8 ? 8 : 0;
  if (!prefixLength) return '';
  return [userId, scopeType, groupId, fieldKey, compact.slice(0, prefixLength)].join('|');
}

function applyNearDuplicateMerges(nodes = [], options = {}) {
  const threshold = Math.max(0.5, Math.min(0.98, Number(options.threshold || configNumber('MEMORY_PROFILE_NEAR_DUPLICATE_THRESHOLD', 0.82)) || 0.82));
  const list = Array.isArray(nodes) ? nodes : [];
  const buckets = new Map();
  for (const node of list) {
    if (!isProfileField(node)) continue;
    const key = buildNearDuplicateProfileKey(node);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(node);
  }
  const winners = new Map();
  for (const group of buckets.values()) {
    if (group.length <= 1) continue;
    const ranked = group.slice().sort((a, b) => rankLifecycleWinner(b) - rankLifecycleWinner(a));
    const winner = ranked[0];
    for (const node of ranked.slice(1)) {
      if (textSimilarity(winner.text || winner.canonicalKey, node.text || node.canonicalKey) >= threshold) {
        winners.set(normalizeText(node.id), winner);
      }
    }
  }
  if (!winners.size) return list;
  return list.map((node) => {
    const winner = winners.get(normalizeText(node.id));
    if (!winner) return node;
    return {
      ...node,
      lifecycleStatus: 'superseded',
      supersededBy: String(winner.id || ''),
      suppressedBy: String(winner.id || ''),
      notRecallable: true,
      recallHiddenReason: 'profile_near_duplicate_superseded'
    };
  });
}

function findProfileCleanupCandidates(nodes = [], options = {}) {
  const now = nowMs(options);
  const hardDeleteGraceMs = daysToMs(options.hardDeleteGraceDays ?? configNumber('MEMORY_PROFILE_CLEANUP_GRACE_DAYS', 30));
  return (Array.isArray(nodes) ? nodes : [])
    .filter((node) => isProfileField(node))
    .map((node) => {
      const status = deriveLifecycleStatus(node, { now });
      const expiresAt = computeExpiresAt(node, { now });
      const updatedAt = Number(node.updatedAt || node.createdAt || 0) || 0;
      const reason = lifecycleHiddenReason({ ...node, lifecycleStatus: status, expiresAt }, { now });
      const hardDeleteEligible = Boolean(
        hardDeleteGraceMs > 0
        && (status === 'stale' || status === 'superseded' || status === 'archived')
        && Math.max(expiresAt, updatedAt) > 0
        && Math.max(expiresAt, updatedAt) + hardDeleteGraceMs <= now
      );
      return {
        id: normalizeText(node.id || node.nodeId),
        userId: normalizeText(node.userId),
        fieldKey: normalizeFieldKey(node),
        text: normalizeText(node.text).slice(0, 220),
        lifecycleStatus: status,
        reason,
        expiresAt,
        supersededBy: normalizeText(node.supersededBy || node.suppressedBy),
        hardDeleteEligible
      };
    })
    .filter((item) => item.id && (item.reason || item.hardDeleteEligible));
}

function lifecycleScoreAdjustment(candidate = {}, options = {}) {
  if (!isProfileField(candidate)) return { multiplier: 1, penalty: 0, boost: 0, reason: '' };
  const status = deriveLifecycleStatus(candidate, options);
  if (status === 'stale' || status === 'suspect' || status === 'superseded') {
    return { multiplier: 0.1, penalty: 0.4, boost: 0, reason: `profile_${status}` };
  }
  const freshness = Number(candidate.freshnessScore || computeFreshnessScore(candidate, options)) || 0;
  const stability = Number(candidate.stabilityScore || 0) || 0;
  const evidence = Math.min(0.12, Math.max(0, Number(candidate.evidenceCount || 1) - 1) * 0.03);
  const boost = (freshness * 0.06) + (stability * 0.04) + evidence;
  const weakPenalty = normalizeText(candidate.evidenceTier).toLowerCase() === 'strict' ? 0 : Math.max(0, (0.55 - freshness) * 0.08);
  return { multiplier: 1, penalty: weakPenalty, boost, reason: weakPenalty > 0 ? 'profile_weak_freshness_penalty' : 'profile_lifecycle_boost' };
}

function applyLifecycleScore(candidate = {}, options = {}) {
  const adjustment = lifecycleScoreAdjustment(candidate, options);
  const baseScore = Number(candidate.score || 0) || 0;
  const nextScore = Math.max(0, (baseScore * adjustment.multiplier) + adjustment.boost - adjustment.penalty);
  return {
    ...candidate,
    score: nextScore,
    scoreParts: {
      ...(candidate.scoreParts || {}),
      profileLifecycleBoost: adjustment.boost,
      profileLifecyclePenalty: adjustment.penalty,
      profileLifecycleMultiplier: adjustment.multiplier
    },
    selectionReason: adjustment.reason
      ? [normalizeText(candidate.selectionReason), adjustment.reason].filter(Boolean).join('|')
      : normalizeText(candidate.selectionReason)
  };
}

function formatPromptProfileSurface(text = '', options = {}) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => normalizeText(line))
    .filter(Boolean);
  if (!lines.length) return '';
  const stable = [];
  const reply = [];
  const cautious = [];
  const avoid = [];
  for (const line of lines) {
    if (/^(基础人格|用户修正|关系风格|表达风格|关系语气|关系阶段)/.test(line)) {
      reply.push(line);
    } else if (/^(低置信|近期弱)/.test(line)) {
      cautious.push(line);
    } else if (/^(不喜欢|边界)/.test(line)) {
      avoid.push(line);
    } else {
      stable.push(line);
    }
  }
  const sections = [
    stable.length ? `稳定画像：${stable.join('；')}` : '',
    reply.length ? `回复偏好：${reply.join('；')}` : '',
    avoid.length ? `避免触碰：${avoid.join('；')}` : '',
    cautious.length ? `谨慎参考：${cautious.join('；')}` : ''
  ].filter(Boolean);
  if (!sections.length) return '';
  const suffix = options.includePromptGuard === false
    ? ''
    : '\n使用规则：只在当前问题相关时使用；低置信和近期弱话题只作参考，不要当成确定事实。';
  return `${sections.join('\n')}${suffix}`;
}

function buildQualityPayload(type = '', value = '', confidence = 0, options = {}) {
  const quality = assessProfileWriteQuality(type, value, confidence, options);
  return {
    ok: quality.ok,
    reasons: quality.reasons,
    confidence: quality.confidence,
    sourceKind: quality.sourceKind,
    canonicalKey: canonicalizeText(value)
  };
}

module.exports = {
  applyLifecycleScore,
  applyNearDuplicateMerges,
  applyProfileLifecycle,
  applySupersession,
  assessProfileWriteQuality,
  buildNearDuplicateProfileKey,
  buildProfileCorrectionEvents,
  buildQualityPayload,
  computeExpiresAt,
  computeFreshnessScore,
  deriveLifecycleStatus,
  detectProfileCorrection,
  findProfileCleanupCandidates,
  formatPromptProfileSurface,
  isProfileField,
  lifecycleHiddenReason,
  lifecycleScoreAdjustment,
  normalizeFieldKey,
  resolveProfileTtlMs,
  textQualityReasons
};
