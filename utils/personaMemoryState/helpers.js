const DEFAULT_SURFACE = 'direct_chat';

const CONTINUITY_PRIORITY = Object.freeze({
  session_projection: 500,
  short_term_bridge: 400,
  short_term_state: 360,
  same_session_summary: 300,
  same_session_journal: 260,
  task_memory: 180,
  group_memory: 160,
  generic_recall: 120,
  fallback: 0
});

const SURFACE_POLICIES = Object.freeze({
  private_chat: {
    includeContinuity: true,
    includeRelationship: true,
    includeRecentReplyFrame: true,
    includeDeepHistory: true,
    allowJargon: 'off',
    maxMemoryDigestItems: 5,
    privacyMode: 'private',
    chatDiscipline: 'single',
    replyRhythm: '1_to_4_short_messages'
  },
  group_direct_chat: {
    includeContinuity: true,
    includeRelationship: true,
    includeRecentReplyFrame: true,
    includeDeepHistory: false,
    allowJargon: 'group_only',
    maxMemoryDigestItems: 3,
    privacyMode: 'group_visible',
    chatDiscipline: 'group',
    replyRhythm: 'short_interjection'
  },
  direct_chat: {
    includeContinuity: true,
    includeRelationship: true,
    includeRecentReplyFrame: true,
    includeDeepHistory: true,
    allowJargon: 'group_only',
    maxMemoryDigestItems: 5,
    privacyMode: 'legacy_direct',
    chatDiscipline: 'single_or_group_legacy',
    replyRhythm: '1_to_4_short_messages'
  },
  passive_group_reply: {
    includeContinuity: true,
    includeRelationship: true,
    includeRecentReplyFrame: true,
    includeDeepHistory: false,
    allowJargon: 'group_only',
    maxMemoryDigestItems: 3,
    privacyMode: 'group_visible',
    chatDiscipline: 'group',
    replyRhythm: 'one_short_line'
  },
  proactive_touch: {
    includeContinuity: true,
    includeRelationship: true,
    includeRecentReplyFrame: true,
    includeDeepHistory: false,
    allowJargon: 'off',
    maxMemoryDigestItems: 3,
    privacyMode: 'private',
    chatDiscipline: 'single',
    replyRhythm: 'brief_proactive_touch'
  },
  qzone_diary: {
    includeContinuity: true,
    includeRelationship: false,
    includeRecentReplyFrame: false,
    includeDeepHistory: false,
    allowJargon: 'off',
    maxMemoryDigestItems: 3,
    privacyMode: 'public_surface',
    chatDiscipline: 'broadcast',
    replyRhythm: 'diary'
  },
  bot_diary: {
    includeContinuity: true,
    includeRelationship: false,
    includeRecentReplyFrame: false,
    includeDeepHistory: false,
    allowJargon: 'off',
    maxMemoryDigestItems: 3,
    privacyMode: 'internal_diary',
    chatDiscipline: 'diary',
    replyRhythm: 'diary'
  },
  daily_share: {
    includeContinuity: true,
    includeRelationship: false,
    includeRecentReplyFrame: false,
    includeDeepHistory: false,
    allowJargon: 'off',
    maxMemoryDigestItems: 2,
    privacyMode: 'group_visible',
    chatDiscipline: 'broadcast',
    replyRhythm: 'short_share'
  }
});

function normalizeText(value, maxChars = 0) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (!maxChars || text.length <= maxChars) return text;
  return text.slice(0, Math.max(1, Number(maxChars) || 1));
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function uniqueStrings(values = [], limit = 6, maxChars = 180) {
  const out = [];
  const seen = new Set();
  for (const raw of normalizeArray(values)) {
    const text = normalizeText(raw, maxChars);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= Math.max(1, Number(limit) || 1)) break;
  }
  return out;
}

function uniqueBy(items = [], selector = (item) => item) {
  const out = [];
  const seen = new Set();
  for (const item of normalizeArray(items)) {
    const key = normalizeText(selector(item));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function getSurfacePolicy(surface = '') {
  const key = normalizeText(surface).toLowerCase() || DEFAULT_SURFACE;
  return SURFACE_POLICIES[key] || SURFACE_POLICIES[DEFAULT_SURFACE];
}

function looksLikePollutedContinuitySummary(text = '') {
  const normalized = normalizeText(text, 2400);
  if (!normalized) return false;
  return /\[(KnownSummary|KnownImpression|Identity|Likes|Dislikes|Goals|KnownFacts|RelevantRecall|RecentTopics)\]/i.test(normalized);
}

function normalizeEvidenceItem(item = {}, fallbackSource = 'fallback') {
  const source = normalizeText(item.source || fallbackSource).toLowerCase() || fallbackSource;
  const text = normalizeText(item.text || item.summary || item.content, 260);
  if (!text) return null;
  return {
    source,
    label: normalizeText(item.label || item.type || item.fieldKey || source, 48),
    text,
    confidence: Math.max(0, Math.min(1, Number(item.confidence || 0) || 0)),
    priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : (CONTINUITY_PRIORITY[source] || 0),
    scope: normalizeText(item.scope || item.scopeType || '', 32),
    metadata: normalizeObject(item.metadata)
  };
}

function chooseBestScalar(entries = []) {
  const ordered = normalizeArray(entries)
    .filter(Boolean)
    .slice()
    .sort((a, b) => {
      const p = Number(b.priority || 0) - Number(a.priority || 0);
      if (p !== 0) return p;
      const c = Number(b.confidence || 0) - Number(a.confidence || 0);
      if (c !== 0) return c;
      return normalizeText(b.text).length - normalizeText(a.text).length;
    });
  return ordered[0] || null;
}

function mergeListCandidates(entries = [], limit = 4) {
  const ordered = normalizeArray(entries)
    .filter(Boolean)
    .slice()
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
  return uniqueStrings(ordered.map((item) => item.text), limit, 180);
}

function buildCandidate(source, text, extras = {}) {
  return normalizeEvidenceItem({
    source,
    text,
    ...extras
  }, source);
}

function createRecentReplyFrameFromMessages(messages = []) {
  const turns = normalizeArray(messages)
    .map((item) => ({
      role: normalizeText(item?.role || '', 16).toLowerCase(),
      content: normalizeText(item?.content || item?.text || '', 240)
    }))
    .filter((item) => (item.role === 'user' || item.role === 'assistant') && item.content)
    .slice(-4);
  if (!turns.length) return null;
  return {
    summary: turns.map((item) => `${item.role === 'assistant' ? 'A' : 'U'}:${item.content}`).join(' | '),
    turns
  };
}

function normalizeReplyPosture(value = '') {
  const posture = normalizeText(value, 24);
  return ['light', 'playful', 'gentle', 'reserved', 'focused', 'comforting'].includes(posture)
    ? posture
    : '';
}

function inferReplyPostureFromSignals({ surface = '', expressionState = {}, continuityState = {}, question = '' } = {}) {
  const explicit = normalizeReplyPosture(expressionState?.replyPosture?.value || expressionState?.replyPosture || continuityState?.replyPosture);
  if (explicit) return explicit;
  const text = normalizeText(question, 240);
  if (/难受|低落|撑不住|安慰|抱抱|陪我/i.test(text)) return 'comforting';
  if (/认真|排查|修|部署|配置|步骤|先给结论/i.test(text)) return 'focused';
  if (/玩笑|搞怪|扮演|可爱|发夹|逛街/i.test(text)) return 'playful';
  if (String(surface || '').trim().toLowerCase() === 'passive_group_reply') return 'light';
  return 'gentle';
}

function computeTopicFingerprint(parts = []) {
  const joined = normalizeArray(parts).map((item) => normalizeText(item, 80)).filter(Boolean).join('|');
  if (!joined) return '';
  let hash = 0;
  for (const ch of joined) {
    hash = ((hash << 5) - hash) + ch.charCodeAt(0);
    hash |= 0;
  }
  return String(hash >>> 0);
}

function inferWarmth(relationship = '', attitude = '', surface = '') {
  const relationshipText = normalizeText(relationship).toLowerCase();
  const attitudeText = normalizeText(attitude).toLowerCase();
  if (['bot_diary', 'qzone_diary', 'daily_share'].includes(normalizeText(surface).toLowerCase())) return 'mid';
  if (/亲密|伙伴|信任|普通朋友/i.test(relationshipText) || /亲近|友好|积极|信任/i.test(attitudeText)) return 'high';
  if (/警惕|疏离|中立/i.test(relationshipText) || /距离|克制|边界/i.test(attitudeText)) return 'low';
  return 'mid';
}

function inferGuardedness(surface = '', relationship = '') {
  const normalizedSurface = normalizeText(surface).toLowerCase();
  if (['qzone_diary', 'bot_diary', 'daily_share'].includes(normalizedSurface)) return 'guarded';
  if (/亲密|伙伴/i.test(normalizeText(relationship))) return 'soft_open';
  return 'guarded';
}

function inferPlayfulness(styleProfile = {}, socialContext = {}, surface = '') {
  const profile = normalizeObject(styleProfile.globalBotBase, {});
  const tags = normalizeArray(profile.toneTags).map((item) => normalizeText(item).toLowerCase());
  if (['qzone_diary', 'bot_diary'].includes(normalizeText(surface).toLowerCase())) return tags.includes('playful') ? 'high' : 'mid';
  if (tags.includes('playful') || tags.includes('cute')) return 'mid';
  if (normalizeText(socialContext.atmosphere).includes('活跃')) return 'mid';
  return 'low';
}

function inferVerbosity(surface = '', styleProfile = {}) {
  const normalizedSurface = normalizeText(surface).toLowerCase();
  if (normalizedSurface === 'passive_group_reply' || normalizedSurface === 'group_direct_chat' || normalizedSurface === 'proactive_touch') return 'terse';
  if (normalizedSurface === 'qzone_diary' || normalizedSurface === 'bot_diary') return 'rich';
  const sentenceLength = normalizeText(styleProfile?.globalBotBase?.sentenceLength || '', 16).toLowerCase();
  if (sentenceLength === 'short') return 'terse';
  if (sentenceLength === 'long') return 'rich';
  return 'normal';
}

function inferTease(styleProfile = {}, socialContext = {}, surface = '') {
  if (['qzone_diary', 'bot_diary'].includes(normalizeText(surface).toLowerCase())) return 'light';
  const profile = normalizeObject(styleProfile.globalBotBase, {});
  if (Number(profile.teaseCueRatio || 0) >= 0.18) return 'light';
  if (normalizeArray(socialContext.topTeasePairs).length > 0) return 'light';
  return 'off';
}

function inferJargon(surface = '', groupId = '', styleSignals = '') {
  const normalizedSurface = normalizeText(surface).toLowerCase();
  if (!groupId) return 'off';
  if (normalizedSurface === 'passive_group_reply' || normalizedSurface === 'group_direct_chat' || normalizedSurface === 'direct_chat') {
    return 'group_only';
  }
  return 'off';
}

function inferInitiative(surface = '') {
  const normalizedSurface = normalizeText(surface).toLowerCase();
  if (normalizedSurface === 'passive_group_reply') return 'reply';
  if (normalizedSurface === 'proactive_touch') return 'proactive';
  return 'reply';
}

function parsePersonaPreference(text = '', key = '') {
  const source = normalizeText(text, 320);
  const normalizedKey = normalizeText(key).toLowerCase();
  if (!source || !normalizedKey) return '';
  const lines = source.split(/\r?\n/).map((line) => normalizeText(line)).filter(Boolean);
  const line = lines.find((item) => item.toLowerCase().startsWith(`${normalizedKey}:`));
  if (!line) return '';
  return normalizeText(line.slice(normalizedKey.length + 1), 120);
}

function buildExpressionValue(value = '', source = 'runtime_inference') {
  return {
    value: normalizeText(value, 48),
    source: normalizeText(source, 32) || 'runtime_inference'
  };
}

module.exports = {
  CONTINUITY_PRIORITY,
  DEFAULT_SURFACE,
  SURFACE_POLICIES,
  buildCandidate,
  buildExpressionValue,
  chooseBestScalar,
  computeTopicFingerprint,
  createRecentReplyFrameFromMessages,
  getSurfacePolicy,
  inferGuardedness,
  inferInitiative,
  inferJargon,
  inferPlayfulness,
  inferReplyPostureFromSignals,
  inferTease,
  inferVerbosity,
  inferWarmth,
  looksLikePollutedContinuitySummary,
  mergeListCandidates,
  normalizeArray,
  normalizeEvidenceItem,
  normalizeObject,
  normalizeReplyPosture,
  normalizeText,
  parsePersonaPreference,
  uniqueBy,
  uniqueStrings
};
