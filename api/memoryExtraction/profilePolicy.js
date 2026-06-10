const config = require('../../config');
const { normalizeTier } = require('../../utils/memoryTier');
const {
  assessProfileWriteQuality,
  buildQualityPayload
} = require('../../utils/memory-v3/profileLifecycle');

function shouldPersistMemoryCandidate(type, value, confidence) {
  const text = String(value || '').trim();
  if (!text) return false;

  const quality = assessProfileWriteQuality(type, text, confidence);
  const hardRejectReasons = new Set(['empty_text', 'too_short', 'topic_too_short', 'generic_text', 'label_only', 'too_long', 'low_confidence']);
  if (quality.reasons.some((reason) => hardRejectReasons.has(reason))) return false;

  const minConfidence = Number(config.MEMORY_EXTRACT_MIN_CONFIDENCE) || 0.72;
  if (Number(confidence || 0) < minConfidence) return false;
  if (text.length < 2) return false;
  if (type === 'topic' && text.length < 4) return false;
  if (type === 'topic' && /^(weather|music|hot_topics|chat|daily)$/i.test(text)) return false;
  return true;
}

function inferExtractorTier(type, confidence = 0.8) {
  const conf = Math.max(0, Math.min(1, Number(confidence || 0)));
  const t = String(type || '').trim().toLowerCase();

  if (t === 'identity' || t === 'summary') {
    if (conf >= 0.9) return 'S';
    if (conf >= 0.8) return 'A';
    return 'B';
  }

  if (t === 'impression') {
    if (conf >= 0.9) return 'S';
    if (conf >= 0.8) return 'A';
    return 'B';
  }

  if (t === 'goal') {
    if (conf >= 0.9) return 'S';
    if (conf >= 0.8) return 'A';
    return 'B';
  }

  if (t === 'fact' || t === 'like' || t === 'dislike' || t === 'personality' || t === 'hobby') {
    if (conf >= 0.9) return 'A';
    if (conf >= 0.78) return 'B';
    return 'C';
  }

  if (t === 'topic') {
    if (conf >= 0.9) return 'B';
    return 'C';
  }

  return 'B';
}

function extractParticipantsFromText(userText = '', botReply = '', options = {}) {
  const participants = [];
  if (String(options.userId || '').trim()) participants.push(String(options.userId || '').trim());
  if (String(options.groupId || '').trim()) participants.push(`group:${String(options.groupId || '').trim()}`);

  const source = `${String(userText || '')}\n${String(botReply || '')}`;
  const mentions = source.match(/@([A-Za-z0-9_\-\u4e00-\u9fa5]{2,24})/g) || [];
  for (const mention of mentions) {
    participants.push(String(mention).replace(/^@/, ''));
  }

  return Array.from(new Set(participants.filter(Boolean))).slice(0, 8);
}

function extractEntitiesFromConversation(userText = '', botReply = '') {
  const text = `${String(userText || '')}\n${String(botReply || '')}`;
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const token = String(value || '').trim();
    if (!token) return;
    const key = token.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(token);
  };

  for (const token of text.match(/\b[A-Za-z][A-Za-z0-9_-]{2,}\b/g) || []) push(token);
  for (const chunk of text.match(/[\u4e00-\u9fa5]{2,8}/g) || []) push(chunk);
  return out.slice(0, 8);
}

function inferRelations(entities = [], participants = []) {
  const nodes = Array.from(new Set([...(participants || []), ...(entities || [])])).slice(0, 6);
  const relations = [];
  for (let i = 0; i < nodes.length - 1; i += 1) {
    relations.push(`${nodes[i]}->${nodes[i + 1]}`);
  }
  return relations.slice(0, 8);
}

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeStringArray(value = [], limit = 16) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const text = normalizeText(raw);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= Math.max(1, Number(limit) || 1)) break;
  }
  return out;
}

function normalizeEvidenceItems(value = []) {
  const list = Array.isArray(value) ? value : (value && typeof value === 'object' ? [value] : []);
  return list
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const userText = normalizeText(item.userText || item.question).slice(0, 500);
      const assistantText = normalizeText(item.assistantText || item.finalReply).slice(0, 500);
      if (!userText && !assistantText) return null;
      return {
        turnId: normalizeText(item.turnId || item.turn_id),
        createdAt: normalizeText(item.createdAt),
        userText,
        assistantText,
        sourceSessionId: normalizeText(item.sourceSessionId || item.source_session_id),
        index: Math.max(0, Number(item.index || 0) || 0)
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function buildLearningDecisionMeta(type = '', confidence = 0, options = {}) {
  const turnIds = normalizeStringArray(options.turnIds || options.turn_ids, 16);
  const turnId = normalizeText(options.turnId || options.turn_id || turnIds[turnIds.length - 1]);
  const evidence = normalizeEvidenceItems(options.evidence);
  const status = normalizeText(options.status).toLowerCase();
  const sourceKind = normalizeText(options.sourceKind || 'extractor').toLowerCase() || 'extractor';
  const fieldKey = normalizeText(options.fieldKey || type).toLowerCase();
  const postReplyJobId = normalizeText(options.postReplyJobId || options.jobId);
  return {
    status: status || 'candidate',
    reason: sourceKind === 'explicit' ? 'explicit_user_request' : 'extractor_profile_guard',
    fieldKey,
    extractionClass: normalizeText(options.extractionClass),
    sourceKind,
    confidence: Number(confidence || 0) || 0,
    postReplyJobId,
    jobId: postReplyJobId,
    turnId,
    turnIds,
    sourceSessionId: normalizeText(options.sourceSessionId || options.sessionId || options.sessionKey),
    evidenceCount: evidence.length,
    phase: normalizeText(options.phase || 'post_reply_learning')
  };
}

function getDefaultStatusForType(type = '', memoryKind = '') {
  if (memoryKind === 'style' || memoryKind === 'jargon') return 'active';
  const normalized = String(type || '').trim().toLowerCase();
  if (config.MEMORY_EXTRACT_PROFILE_WRITES_AS_CANDIDATE === true) {
    return 'candidate';
  }
  if (normalized === 'identity' || normalized === 'goal' || normalized === 'summary' || normalized === 'impression') {
    return 'active';
  }
  return 'candidate';
}

function canonicalProfileText(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/^(likes?|dislikes?|identity|personality|hobby|goal|topic|recent topic|喜欢|不喜欢|身份|性格|爱好|目标|最近话题)(?:[:：\s])*/i, '')
    .replace(/[^\u4e00-\u9fa5a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isEpisodicProfileObservation(type = '', value = '') {
  const t = String(type || '').trim().toLowerCase();
  const text = String(value || '').trim();
  if (!text) return false;
  if (t === 'topic') return true;
  if (/(今天|刚刚|刚才|这次|这把|这局|今晚|上午|下午|昨天|临时|一会儿|等下|打算|准备|去打|去听|刷|冲[abcs]|master|expert|fc|ap)/i.test(text)) return true;
  if (/(歌曲|歌|曲|谱面|游戏|音游|maimai|中二|chunithm|ongeki|arcaea|pjsk|邦邦|梗|谐音|段子|表情包|活动|成绩|等级|rank|kitty|移动恋话)/i.test(text)) {
    return t === 'like' || t === 'hobby' || t === 'topic' || t === 'fact';
  }
  return false;
}

function classifyProfileExtraction(type = '', value = '', options = {}) {
  const sourceKind = String(options.sourceKind || '').trim().toLowerCase();
  const status = String(options.status || '').trim().toLowerCase();
  const memoryKind = String(options.memoryKind || '').trim().toLowerCase();
  if (sourceKind === 'explicit' || status === 'active') return 'stable_profile_candidate';
  if (memoryKind === 'style' || type === 'style') return 'style_signal';
  if (memoryKind === 'journal' || memoryKind === 'episode') return 'journal_only';
  if (isEpisodicProfileObservation(type, value)) return type === 'topic' ? 'journal_only' : 'episodic_observation';
  if (['identity', 'personality', 'hobby', 'like', 'dislike', 'goal', 'summary', 'impression'].includes(String(type || '').toLowerCase())) {
    return 'stable_profile_candidate';
  }
  return 'journal_only';
}

function resolveV3ProfileFieldKey(type = '', fallback = '') {
  const key = String(fallback || type || '').trim().toLowerCase();
  if (type === 'like' || key === 'like') return 'preference_like';
  if (type === 'dislike' || key === 'dislike') return 'preference_dislike';
  if (type === 'summary') return 'persona_summary_support';
  if (type === 'impression') return 'persona_impression_support';
  if (type === 'identity') return 'identity';
  if (type === 'personality') return 'personality';
  if (type === 'hobby') return 'hobby';
  if (type === 'goal') return 'goal';
  if (type === 'topic') return 'topic';
  return key || 'fact';
}

function buildProfileConflictKeyForExtraction(userId, type = '', value = '', options = {}) {
  const uid = String(userId || options.userId || '').trim();
  const canonical = canonicalProfileText(value);
  const fieldKey = resolveV3ProfileFieldKey(type, options.fieldKey);
  if (!uid || !canonical) return '';
  if (fieldKey === 'preference_like' || fieldKey === 'preference_dislike') return `${uid}|personal|preference|${canonical}`;
  if (fieldKey === 'identity') return `${uid}|personal|identity|${canonical}`;
  if (fieldKey === 'goal') return `${uid}|personal|goal|${canonical}`;
  if (/^relationship_/.test(fieldKey)) return `${uid}|personal|relationship_style|${fieldKey}`;
  return '';
}

function buildMemoryBaseMeta(type, confidence, options = {}) {
  const importanceTier = normalizeTier(inferExtractorTier(type, confidence)) || 'B';
  const fieldKey = String(options.fieldKey || type || '').trim().toLowerCase();
  const extractionClass = classifyProfileExtraction(type, options.value || options.text || '', options);
  const profileQuality = buildQualityPayload(type, options.value || options.text || '', confidence, options);
  const conflictKey = buildProfileConflictKeyForExtraction(options.userId, type, options.value || options.text || '', {
    ...options,
    fieldKey
  });
  const defaultStatus = extractionClass === 'episodic_observation' || extractionClass === 'journal_only'
    ? 'candidate'
    : getDefaultStatusForType(type, options.memoryKind);
  const status = options.status || defaultStatus;
  const turnIds = normalizeStringArray(options.turnIds || options.turn_ids, 16);
  const turnId = normalizeText(options.turnId || options.turn_id || turnIds[turnIds.length - 1]);
  const evidence = normalizeEvidenceItems(options.evidence);
  const sourceSessionId = normalizeText(options.sourceSessionId || options.sessionId || options.sessionKey);
  const learningDecision = buildLearningDecisionMeta(type, confidence, {
    ...options,
    fieldKey,
    extractionClass,
    status,
    turnId,
    turnIds,
    evidence,
    sourceSessionId
  });
  return {
    source: 'extractor',
    confidence,
    importanceTier,
    sourceKind: options.sourceKind || 'extractor',
    status,
    fieldKey,
    extractionClass,
    conflictKey,
    profileQuality,
    sourceSessionId,
    turnId,
    turnIds,
    evidence,
    learningDecision,
    participants: Array.isArray(options.participants) ? options.participants : [],
    entities: Array.isArray(options.entities) ? options.entities : [],
    relations: Array.isArray(options.relations) ? options.relations : []
  };
}

function parseExplicitRemember(text = '') {
  const source = String(text || '').trim();
  if (!source) return '';
  const match = source.match(/(?:^|\n)(?:Turn\s+\d+\s+User:\s*)?(?:记住|记一下|帮我记住|remember)\s*(?:[:：,-]\s*|\s+)?(.+?)(?:\n|$)/i);
  if (!match) return '';
  return String(match[1] || '').trim();
}

function inferExplicitProfileType(text = '') {
  const value = String(text || '').trim();
  if (!value) return 'fact';
  if (/(不喜欢|讨厌|反感|不要.*(?:风格|称呼|方式)|别再)/.test(value)) return 'dislike';
  if (/(喜欢|偏好|爱吃|爱看|爱听|爱玩)/.test(value)) return 'like';
  if (/(目标|想要|打算|计划|希望以后|正在准备)/.test(value)) return 'goal';
  if (/(我是|我的身份|职业|学生|老师|工程师|开发者|作者|玩家)/.test(value)) return 'identity';
  if (/(爱好|兴趣|经常玩|常玩|长期玩|平时会)/.test(value)) return 'hobby';
  if (/(性格|习惯|说话.*(?:直接|委婉|急|慢)|我这个人)/.test(value)) return 'personality';
  return 'fact';
}

function normalizeLegacyProfileWritePolicy(options = {}) {
  return String(options.legacyProfileWritePolicy || config.MEMORY_LEGACY_PROFILE_WRITE_POLICY || 'explicit_only')
    .trim()
    .toLowerCase();
}

function shouldWriteLegacyProfileField(type = '', meta = {}, options = {}) {
  const policy = normalizeLegacyProfileWritePolicy(options);
  if (options.legacyProfileWriteEnabled === true || policy === 'all') return true;
  const sourceKind = String(meta.sourceKind || options.sourceKind || '').trim().toLowerCase();
  if (policy === 'off' || policy === 'none' || policy === 'disabled') return false;
  if (policy === 'basic') {
    return ['identity', 'goal'].includes(String(type || '').trim().toLowerCase())
      && sourceKind === 'explicit';
  }
  return sourceKind === 'explicit';
}

function countStableProfileSignals(groups = [], confidence = 0) {
  const minConfidence = Math.max(0.78, Number(config.MEMORY_EXTRACT_MIN_CONFIDENCE || 0.72) + 0.06);
  if (Number(confidence || 0) < minConfidence) return 0;
  return groups.reduce((sum, values) => {
    const count = Array.isArray(values)
      ? values.map((item) => String(item || '').trim()).filter(Boolean).length
      : 0;
    return sum + count;
  }, 0);
}

function shouldPersistPersonaSupport(stableSignalCount = 0, options = {}) {
  if (options.forcePersonaSupportWrite === true) return true;
  if (config.MEMORY_EXTRACT_PERSONA_SUPPORT_REQUIRE_EVIDENCE === false) return true;
  return stableSignalCount >= Math.max(1, Number(config.MEMORY_EXTRACT_PERSONA_SUPPORT_MIN_SIGNALS || 2) || 2);
}

function buildPendingMemoryV3Event(userId, type, value, meta = {}, options = {}) {
  const text = String(value || '').trim();
  if (!text) return null;
  const fieldKey = resolveV3ProfileFieldKey(type, meta.fieldKey);
  const status = String(meta.status || '').trim().toLowerCase() || getDefaultStatusForType(type, options.memoryKind);
  const sourceKind = String(meta.sourceKind || 'extractor').trim().toLowerCase() || 'extractor';
  const extractionClass = meta.extractionClass || classifyProfileExtraction(type, text, { ...options, fieldKey, status, sourceKind });
  const conflictKey = meta.conflictKey || buildProfileConflictKeyForExtraction(userId, type, text, { ...options, fieldKey });
  const eventType = status === 'active' || sourceKind === 'explicit'
    ? 'memory_confirmed'
    : 'memory_candidate_extracted';
  return {
    type: eventType,
    userId,
    sessionKey: options.sessionKey,
    groupId: options.groupId,
    channelId: options.channelId,
    sessionId: options.sessionId,
    routePolicyKey: options.routePolicyKey,
    topRouteType: options.topRouteType,
    scopeType: 'personal',
    source: meta.source || 'extractor',
    sourceKind,
    status,
    confidence: meta.confidence,
    importance: meta.importance,
    memoryKind: type === 'summary' || type === 'impression' ? fieldKey : type,
    semanticSlot: fieldKey,
    conflictKey,
    text,
    payload: {
      type: type === 'summary' || type === 'impression' ? 'fact' : type,
      fieldKey,
      memoryKind: type,
      extractionClass,
      conflictKey,
      profileQuality: meta.profileQuality || buildQualityPayload(type, text, meta.confidence, {
        ...options,
        sourceKind
      }),
      turnId: meta.turnId || options.turnId || '',
      turnIds: Array.isArray(meta.turnIds) ? meta.turnIds : normalizeStringArray(options.turnIds || []),
      evidence: Array.isArray(meta.evidence) ? meta.evidence : normalizeEvidenceItems(options.evidence),
      sourceSessionId: meta.sourceSessionId || options.sourceSessionId || options.sessionId || '',
      learningDecision: meta.learningDecision || null
    },
    participants: meta.participants,
    entities: meta.entities,
    relations: meta.relations
  };
}

function attachPendingMemoryV3Event(item = {}, userId, type, value, meta = {}, options = {}) {
  const event = buildPendingMemoryV3Event(userId, type, value, meta, options);
  if (!event) return item;
  return {
    ...item,
    meta: {
      ...(item.meta && typeof item.meta === 'object' ? item.meta : {}),
      pendingMemoryV3Event: event
    }
  };
}

module.exports = {
  shouldPersistMemoryCandidate,
  inferExtractorTier,
  extractParticipantsFromText,
  extractEntitiesFromConversation,
  inferRelations,
  normalizeText,
  normalizeStringArray,
  normalizeEvidenceItems,
  buildLearningDecisionMeta,
  getDefaultStatusForType,
  buildMemoryBaseMeta,
  canonicalProfileText,
  isEpisodicProfileObservation,
  classifyProfileExtraction,
  buildProfileConflictKeyForExtraction,
  resolveV3ProfileFieldKey,
  parseExplicitRemember,
  inferExplicitProfileType,
  normalizeLegacyProfileWritePolicy,
  shouldWriteLegacyProfileField,
  countStableProfileSignals,
  shouldPersistPersonaSupport,
  buildPendingMemoryV3Event,
  attachPendingMemoryV3Event
};
