const crypto = require('crypto');
const config = require('../../../config');
const {
  clampText,
  canonicalizeText,
  normalizeText,
  uniqueBy
} = require('../helpers');
const { applyPersonaRecencyDecay } = require('./evidence');

function buildPersonaSupportHash(supports = []) {
  const payload = (Array.isArray(supports) ? supports : [])
    .map((item) => `${item.fieldKey}|${item.canonicalKey}|${item.text}`)
    .sort()
    .join('\n');
  return crypto.createHash('sha1').update(payload).digest('hex');
}

function buildFieldSummary(nodes = [], fieldOrder = []) {
  const fieldMap = new Map();
  for (const fieldKey of fieldOrder) fieldMap.set(fieldKey, []);
  for (const item of Array.isArray(nodes) ? nodes : []) {
    if (!fieldMap.has(item.fieldKey)) continue;
    fieldMap.get(item.fieldKey).push(item.text);
  }
  return fieldOrder
    .map((fieldKey) => {
      const values = uniqueBy((fieldMap.get(fieldKey) || []).filter(Boolean), (item) => canonicalizeText(item));
      if (!values.length) return '';
      return `${fieldKey}: ${values.slice(0, 2).join('；')}`;
    })
    .filter(Boolean)
    .join('\n');
}

function pickStrongestNodesPerField(nodes = [], limitPerField = 1) {
  const byField = new Map();
  for (const item of Array.isArray(nodes) ? nodes : []) {
    const fieldKey = normalizeText(item.fieldKey);
    if (!fieldKey) continue;
    if (!byField.has(fieldKey)) byField.set(fieldKey, []);
    byField.get(fieldKey).push(item);
  }
  const selected = [];
  for (const items of byField.values()) {
    selected.push(
      ...items
        .slice()
        .sort((a, b) => Number(b.decayedStabilityScore || b.stabilityScore || 0) - Number(a.decayedStabilityScore || a.stabilityScore || 0))
        .slice(0, Math.max(1, Number(limitPerField) || 1))
    );
  }
  return selected;
}

function buildPersonaCore(profileProjection, supportNodes = [], styleNodes = [], affinityState = {}, previousPersonaCore = {}, botPersonaNodes = [], relationshipNodes = []) {
  const supports = (Array.isArray(supportNodes) ? supportNodes : [])
    .filter((item) => item.evidenceTier === 'strict')
    .sort((a, b) => Number(b.stabilityScore || 0) - Number(a.stabilityScore || 0))
    .slice(0, 6);
  const botPersonaStrict = (Array.isArray(botPersonaNodes) ? botPersonaNodes : [])
    .filter((item) => item.evidenceTier === 'strict')
    .map((item) => ({ ...item, decayedStabilityScore: Number(item.stabilityScore || 0) * applyPersonaRecencyDecay(item) }))
    .sort((a, b) => Number(b.decayedStabilityScore || 0) - Number(a.decayedStabilityScore || 0));
  const relationshipStrict = (Array.isArray(relationshipNodes) ? relationshipNodes : [])
    .filter((item) => item.evidenceTier === 'strict')
    .map((item) => ({ ...item, decayedStabilityScore: Number(item.stabilityScore || 0) * applyPersonaRecencyDecay(item) }))
    .sort((a, b) => Number(b.decayedStabilityScore || 0) - Number(a.decayedStabilityScore || 0));
  const supportHash = buildPersonaSupportHash(supports);
  const personaSupportHash = buildPersonaSupportHash(botPersonaStrict);
  const relationshipSupportHash = buildPersonaSupportHash(relationshipStrict);
  const next = {
    summary: '',
    impression: '',
    replyStyle: '',
    relationshipTone: '',
    botBasePersona: '',
    userAdaptationPersona: '',
    relationshipStyle: '',
    supportHash,
    personaSupportHash,
    relationshipSupportHash,
    personaVersion: 2,
    updatedAt: Date.now()
  };

  const hasLegacyPersonaSupport = supports.length >= Math.max(1, Number(config.MEMORY_V3_PERSONA_SUPPORT_MIN_ITEMS || 3));
  const hasDerivedPersonaSupport = botPersonaStrict.length > 0 || relationshipStrict.length > 0;

  if (!hasLegacyPersonaSupport && !hasDerivedPersonaSupport) {
    return {
      ...next,
      summary: String(previousPersonaCore.summary || ''),
      impression: String(previousPersonaCore.impression || ''),
      replyStyle: String(previousPersonaCore.replyStyle || ''),
      relationshipTone: String(previousPersonaCore.relationshipTone || ''),
      botBasePersona: String(previousPersonaCore.botBasePersona || ''),
      userAdaptationPersona: String(previousPersonaCore.userAdaptationPersona || ''),
      relationshipStyle: String(previousPersonaCore.relationshipStyle || ''),
      supportHash: String(previousPersonaCore.supportHash || supportHash || ''),
      personaSupportHash: String(previousPersonaCore.personaSupportHash || personaSupportHash || ''),
      relationshipSupportHash: String(previousPersonaCore.relationshipSupportHash || relationshipSupportHash || '')
    };
  }

  const summarySupports = supports
    .filter((item) => item.fieldKey === 'persona_summary_support')
    .map((item) => item.text)
    .filter(Boolean)
    .slice(0, 2);
  const impressionSupports = supports
    .filter((item) => item.fieldKey === 'persona_impression_support')
    .map((item) => item.text)
    .filter(Boolean)
    .slice(0, 2);

  if (
    supportHash === String(previousPersonaCore.supportHash || '').trim()
    && personaSupportHash === String(previousPersonaCore.personaSupportHash || '').trim()
    && relationshipSupportHash === String(previousPersonaCore.relationshipSupportHash || '').trim()
  ) {
    return {
      ...next,
      summary: String(previousPersonaCore.summary || ''),
      impression: String(previousPersonaCore.impression || ''),
      replyStyle: String(previousPersonaCore.replyStyle || ''),
      relationshipTone: String(previousPersonaCore.relationshipTone || ''),
      botBasePersona: String(previousPersonaCore.botBasePersona || ''),
      userAdaptationPersona: String(previousPersonaCore.userAdaptationPersona || ''),
      relationshipStyle: String(previousPersonaCore.relationshipStyle || ''),
      personaSupportHash: String(previousPersonaCore.personaSupportHash || personaSupportHash || ''),
      relationshipSupportHash: String(previousPersonaCore.relationshipSupportHash || relationshipSupportHash || '')
    };
  }

  next.summary = hasLegacyPersonaSupport
    ? clampText(summarySupports.join('；'), 220)
    : String(previousPersonaCore.summary || '');
  next.impression = hasLegacyPersonaSupport
    ? clampText(impressionSupports.join('；'), 180)
    : String(previousPersonaCore.impression || '');

  const stylePatterns = (Array.isArray(styleNodes) ? styleNodes : [])
    .filter((item) => item.fieldKey === 'style_pattern' && item.evidenceTier === 'strict')
    .map((item) => item.text.replace(/^style:\s*/i, '').trim())
    .filter(Boolean)
    .slice(0, 2);
  const styleAvoids = (Array.isArray(styleNodes) ? styleNodes : [])
    .filter((item) => item.fieldKey === 'style_avoid' && item.evidenceTier === 'strict')
    .map((item) => item.text.replace(/^style:\s*/i, '').trim())
    .filter(Boolean)
    .slice(0, 1);

  const botBasePersona = clampText(buildFieldSummary(pickStrongestNodesPerField(botPersonaStrict, 1), [
    'bot_persona_tone',
    'bot_persona_initiative',
    'bot_persona_boundaries',
    'bot_persona_playfulness',
    'bot_persona_guardedness',
    'bot_persona_verbosity'
  ]), 320);

  const relationshipStyle = clampText(buildFieldSummary(pickStrongestNodesPerField(relationshipStrict, 1), [
    'relationship_tone',
    'relationship_distance',
    'relationship_salutation',
    'relationship_reply_style',
    'relationship_engagement',
    'relationship_boundaries'
  ]), 320);

  const userAdaptationPersona = clampText([
    relationshipStyle,
    normalizeText(affinityState.attitude || '')
  ].filter(Boolean).join('\n'), 260);

  next.replyStyle = clampText([
    botBasePersona ? `基础人格：${botBasePersona}` : '',
    userAdaptationPersona ? `用户修正：${userAdaptationPersona}` : '',
    stylePatterns.length ? `偏好：${stylePatterns.join('；')}` : '',
    styleAvoids.length ? `避免：${styleAvoids.join('；')}` : ''
  ].filter(Boolean).join(' | '), 180);

  next.botBasePersona = botBasePersona;
  next.relationshipStyle = relationshipStyle;
  next.userAdaptationPersona = userAdaptationPersona;
  next.relationshipTone = clampText([
    relationshipStyle,
    normalizeText(affinityState.relationship || ''),
    normalizeText(affinityState.attitude || '')
  ].filter(Boolean).join(' | '), 220);

  void profileProjection;
  return next;
}

module.exports = {
  buildFieldSummary,
  buildPersonaCore,
  buildPersonaSupportHash,
  pickStrongestNodesPerField
};
