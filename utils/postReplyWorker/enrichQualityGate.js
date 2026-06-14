const config = require('../../config');

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function clamp01(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function defaultMinConfidence(fieldKey = '') {
  const key = normalizeText(fieldKey).toLowerCase();
  if (key === 'affinity') return 0.45;
  if (key === 'task') return 0.55;
  if (key === 'group_fact' || key === 'group_goal' || key === 'group_topic') return 0.62;
  if (key === 'style_pattern' || key === 'style_avoid') return 0.72;
  if (key === 'group_jargon') return 0.72;
  if (key === 'self_improvement') return 0.6;
  return Math.max(0.55, Number(config.MEMORY_EXTRACT_MIN_CONFIDENCE || 0.72) - 0.08);
}

function canonicalText(fieldKey = '', text = '') {
  return normalizeText(text)
    .toLowerCase()
    .replace(/^(style|group jargon|group goal|group topic)\s*[:：]\s*/i, '')
    .replace(/[^\u4e00-\u9fa5a-z0-9]+/gi, ' ')
    .trim()
    || normalizeText(fieldKey).toLowerCase();
}

function hasSensitiveText(text = '') {
  return /(api[_-]?key|token|password|secret|身份证|手机号|住址|隐私|doxx)/i.test(normalizeText(text));
}

function isStructuredStateSnapshot(fieldKey = '', text = '') {
  const key = normalizeText(fieldKey).toLowerCase();
  const value = normalizeText(text);
  if (!value) return false;
  if (!['style_pattern', 'style_avoid'].includes(key) && !key.startsWith('relationship_')) return false;
  const schemaLabels = value.match(/\b(?:relationship|bot_persona|style)_[a-z_]+\s*[:=]/gi) || [];
  const sourceLabels = value.match(/\b(?:warmth|playfulness|tease|initiative|jargon|verbosity|guardedness|replyPosture)Source\s*=/g) || [];
  if (sourceLabels.length > 0) return true;
  if (schemaLabels.length >= 2) return true;
  if (/用户修正[:：]/.test(value) && schemaLabels.length > 0) return true;
  const sourceTokens = value.match(/\b(?:runtime_inference|surface_policy|short_term_state|relationship_memory|persona_memory|continuity_state)\b/gi) || [];
  return sourceTokens.length >= 2;
}

function buildGateResult(candidate = {}, allow = false, reason = '') {
  return {
    allow: Boolean(allow),
    reason: normalizeText(reason) || (allow ? 'allowed' : 'dropped'),
    fieldKey: normalizeText(candidate.fieldKey),
    confidence: clamp01(candidate.confidence, 0),
    textPreview: normalizeText(candidate.text).slice(0, 120)
  };
}

function createEnrichQualityGate(context = {}) {
  const seen = new Set();
  let acceptedWrites = 0;
  const maxWrites = Math.max(0, Number(context.maxWrites ?? config.POST_REPLY_ENRICH_MAX_WRITES) || 0);

  function assess(candidate = {}) {
    const fieldKey = normalizeText(candidate.fieldKey || candidate.type);
    const text = normalizeText(candidate.text);
    const confidence = clamp01(candidate.confidence, 0);
    const evidence = normalizeArray(candidate.evidence || context.evidence);
    const requireEvidence = candidate.requireEvidence !== false;
    const minConfidence = clamp01(candidate.minConfidence, defaultMinConfidence(fieldKey));
    const groupId = normalizeText(candidate.groupId || context.groupId);
    const userId = normalizeText(candidate.userId || context.userId);

    if (!fieldKey) return buildGateResult(candidate, false, 'missing_field');
    if (!text) return buildGateResult(candidate, false, 'empty_text');
    if (text.length < Math.max(2, Number(candidate.minTextLength || 2) || 2)) {
      return buildGateResult(candidate, false, 'too_short');
    }
    if (confidence < minConfidence) return buildGateResult(candidate, false, 'low_confidence');
    if (requireEvidence && evidence.length === 0) return buildGateResult(candidate, false, 'missing_evidence');
    if (candidate.requiresGroup === true && !groupId) return buildGateResult(candidate, false, 'missing_group_scope');
    if (candidate.requiresUser === true && !userId) return buildGateResult(candidate, false, 'missing_user_scope');
    if (hasSensitiveText(text)) return buildGateResult(candidate, false, 'sensitive_text');
    if (isStructuredStateSnapshot(fieldKey, text)) return buildGateResult(candidate, false, 'structured_state_snapshot');
    const dedupeKey = `${fieldKey}|${groupId || userId || 'global'}|${canonicalText(fieldKey, text)}`;
    if (seen.has(dedupeKey)) return buildGateResult(candidate, false, 'duplicate_text');
    if (maxWrites > 0 && acceptedWrites >= maxWrites) return buildGateResult(candidate, false, 'max_writes_exceeded');

    seen.add(dedupeKey);
    acceptedWrites += 1;
    return buildGateResult(candidate, true, 'allowed');
  }

  return {
    assess,
    getStats() {
      return {
        acceptedWrites,
        maxWrites,
        seen: seen.size
      };
    }
  };
}

module.exports = {
  canonicalText,
  createEnrichQualityGate,
  defaultMinConfidence,
  isStructuredStateSnapshot
};
