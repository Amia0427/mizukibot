const DEFAULT_MIN_CONFIDENCE = 0.7;
const DEFAULT_COOLDOWN_MS = 120000;

function normalizeEmotionAnalysis(analysis = {}) {
  return {
    emotion: String(analysis.emotion || '').trim().toLowerCase(),
    intensity: String(analysis.intensity || '').trim().toLowerCase(),
    confidence: Number(analysis.confidence)
  };
}

function resolveEmotionCooldownKey({ chatType, userId, groupId } = {}) {
  const normalizedChatType = String(chatType || '').trim().toLowerCase();
  if (normalizedChatType === 'private') return `private:${String(userId || '').trim()}`;
  if (normalizedChatType === 'group') return `group:${String(groupId || '').trim()}`;
  return '';
}

function evaluateEmotionGate(analysis = {}, options = {}) {
  const normalized = normalizeEmotionAnalysis(analysis);
  const minConfidence = Number.isFinite(Number(options.minConfidence))
    ? Number(options.minConfidence)
    : DEFAULT_MIN_CONFIDENCE;
  if (!normalized.emotion || normalized.emotion === 'neutral') return { allowed: false, reason: 'neutral' };
  if (normalized.intensity !== 'high') return { allowed: false, reason: 'intensity_below_high' };
  if (!Number.isFinite(normalized.confidence) || normalized.confidence < minConfidence) {
    return { allowed: false, reason: 'confidence_below_minimum' };
  }
  return { allowed: true, reason: 'eligible', ...normalized };
}

function createEmotionGate(options = {}) {
  const minConfidence = Number.isFinite(Number(options.minConfidence))
    ? Number(options.minConfidence)
    : DEFAULT_MIN_CONFIDENCE;
  const cooldownMs = Math.max(0, Number(options.cooldownMs) || DEFAULT_COOLDOWN_MS);
  const lastSentAtByKey = new Map();

  function check(key, analysis, now = Date.now()) {
    const eligibility = evaluateEmotionGate(analysis, { minConfidence });
    if (!eligibility.allowed) return eligibility;
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) return { allowed: false, reason: 'missing_target_key' };
    const lastSentAt = Number(lastSentAtByKey.get(normalizedKey) || 0);
    const remainingMs = lastSentAt > 0
      ? Math.max(0, lastSentAt + cooldownMs - Number(now || Date.now()))
      : 0;
    if (remainingMs > 0) {
      return { ...eligibility, allowed: false, reason: 'cooldown', remainingMs };
    }
    return { ...eligibility, key: normalizedKey, remainingMs: 0 };
  }

  function markSent(key, now = Date.now()) {
    const normalizedKey = String(key || '').trim();
    if (normalizedKey) lastSentAtByKey.set(normalizedKey, Number(now || Date.now()));
  }

  return { check, markSent };
}

module.exports = {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MIN_CONFIDENCE,
  createEmotionGate,
  evaluateEmotionGate,
  normalizeEmotionAnalysis,
  resolveEmotionCooldownKey
};
