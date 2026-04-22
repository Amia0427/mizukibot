const fs = require('fs');
const path = require('path');
const config = require('../config');
const { estimateTokens, trimTextByTokenBudget } = require('./contextBudget');
const { getStyleProfile } = require('./styleProfileRuntime');
const { getGroupSocialContext } = require('./socialContextRuntime');
const {
  resolveShortTermSessionKey,
  resolveShortTermSceneKey,
  normalizeShortTermState,
  normalizeInteractionState,
  normalizeSceneState,
  normalizeExpressionState,
  normalizeModuleState,
  buildSharedShortTermContextMessages
} = require('./shortTermMemory');
const { loadBridgeStore } = require('./shortTermBridgeMemory');
const { getRecentSessionContextSummaries } = require('./sessionContextSummaryStore');
const { getDailyJournalRetrievalBundle } = require('./dailyJournal');
const { buildMemoryContextAsync, buildMemoryContext } = require('./memoryContext');
const { getUserAffinityState, getUserProfile } = require('./memory');
const {
  restoreSessionState,
  appendMemoryEvent,
  materializeMemoryViews
} = require('./memory-v3');
const { sanitizeUntrustedContent, shouldBlockMemoryLearning } = require('./promptSecurity');

const STATE_VERSION = 2;
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
  direct_chat: {
    includeContinuity: true,
    includeRelationship: true,
    includeRecentReplyFrame: true,
    includeDeepHistory: true,
    allowJargon: 'group_only',
    maxMemoryDigestItems: 5
  },
  passive_group_reply: {
    includeContinuity: true,
    includeRelationship: true,
    includeRecentReplyFrame: true,
    includeDeepHistory: false,
    allowJargon: 'group_only',
    maxMemoryDigestItems: 3
  },
  proactive_touch: {
    includeContinuity: true,
    includeRelationship: true,
    includeRecentReplyFrame: true,
    includeDeepHistory: false,
    allowJargon: 'off',
    maxMemoryDigestItems: 3
  },
  qzone_diary: {
    includeContinuity: true,
    includeRelationship: false,
    includeRecentReplyFrame: false,
    includeDeepHistory: false,
    allowJargon: 'off',
    maxMemoryDigestItems: 3
  },
  bot_diary: {
    includeContinuity: true,
    includeRelationship: false,
    includeRecentReplyFrame: false,
    includeDeepHistory: false,
    allowJargon: 'off',
    maxMemoryDigestItems: 3
  },
  daily_share: {
    includeContinuity: true,
    includeRelationship: false,
    includeRecentReplyFrame: false,
    includeDeepHistory: false,
    allowJargon: 'off',
    maxMemoryDigestItems: 2
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

function clampMessageText(text = '', tokenBudget = 0, fallbackChars = 220) {
  const value = normalizeText(text);
  if (!value) return '';
  if (tokenBudget > 0) return trimTextByTokenBudget(value, tokenBudget, 'tail');
  return normalizeText(value, fallbackChars);
}

function getSurfacePolicy(surface = '') {
  const key = normalizeText(surface).toLowerCase() || DEFAULT_SURFACE;
  return SURFACE_POLICIES[key] || SURFACE_POLICIES[DEFAULT_SURFACE];
}

function readPromptManifest() {
  try {
    if (!fs.existsSync(config.PROMPT_MANIFEST_PATH)) return null;
    return JSON.parse(fs.readFileSync(config.PROMPT_MANIFEST_PATH, 'utf8'));
  } catch (_) {
    return null;
  }
}

function safeReadText(filePath = '') {
  try {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return '';
  }
}

function loadPersonaCoreText() {
  const manifest = readPromptManifest();
  const sections = Array.isArray(manifest?.system_prompt?.sections)
    ? manifest.system_prompt.sections
    : [];
  const selected = sections.filter((section) => [
    'persona_core',
    'persona_style',
    'persona_policy',
    'persona_behavior',
    'persona_modulation'
  ].includes(String(section?.kind || '').trim()));
  const parts = selected
    .map((section) => safeReadText(path.join(config.PROMPTS_DIR, String(section.path || '').trim())))
    .map((text) => String(text || '').trim())
    .filter(Boolean);
  return parts.join('\n\n').trim() || String(config.SYSTEM_PROMPT || '').trim();
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
  if (normalizedSurface === 'passive_group_reply' || normalizedSurface === 'proactive_touch') return 'terse';
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
  if (normalizedSurface === 'passive_group_reply' || normalizedSurface === 'direct_chat') {
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

function buildExpressionState({ surface, relationshipState, styleProfile, socialContext, memoryContext }) {
  const persona = normalizeObject(memoryContext.persona, {});
  const relationshipStyle = normalizeText(persona.relationshipStyle || persona.userAdaptationPersona, 320);
  const botBasePersona = normalizeText(persona.botBasePersona, 320);
  const warmth = parsePersonaPreference(relationshipStyle, 'relationship_tone')
    || parsePersonaPreference(botBasePersona, 'bot_persona_tone')
    || inferWarmth(relationshipState.relationship, relationshipState.attitude, surface);
  const playfulness = parsePersonaPreference(botBasePersona, 'bot_persona_playfulness')
    || inferPlayfulness(styleProfile, socialContext, surface);
  const initiative = parsePersonaPreference(botBasePersona, 'bot_persona_initiative')
    || parsePersonaPreference(relationshipStyle, 'relationship_engagement')
    || inferInitiative(surface);
  const guardedness = parsePersonaPreference(relationshipStyle, 'relationship_distance')
    || parsePersonaPreference(botBasePersona, 'bot_persona_guardedness')
    || inferGuardedness(surface, relationshipState.relationship);
  const verbosity = parsePersonaPreference(botBasePersona, 'bot_persona_verbosity')
    || inferVerbosity(surface, styleProfile);
  return {
    warmth: buildExpressionValue(warmth, parsePersonaPreference(relationshipStyle, 'relationship_tone') ? 'relationship_memory' : (parsePersonaPreference(botBasePersona, 'bot_persona_tone') ? 'persona_memory' : 'runtime_inference')),
    playfulness: buildExpressionValue(playfulness, parsePersonaPreference(botBasePersona, 'bot_persona_playfulness') ? 'persona_memory' : 'runtime_inference'),
    tease: buildExpressionValue(inferTease(styleProfile, socialContext, surface), 'runtime_inference'),
    initiative: buildExpressionValue(initiative, parsePersonaPreference(botBasePersona, 'bot_persona_initiative') ? 'persona_memory' : (parsePersonaPreference(relationshipStyle, 'relationship_engagement') ? 'relationship_memory' : 'surface_policy')),
    jargon: buildExpressionValue(inferJargon(surface, relationshipState.groupId, memoryContext?.styleSignalText), 'surface_policy'),
    verbosity: buildExpressionValue(verbosity, parsePersonaPreference(botBasePersona, 'bot_persona_verbosity') ? 'persona_memory' : 'runtime_inference'),
    guardedness: buildExpressionValue(guardedness, parsePersonaPreference(relationshipStyle, 'relationship_distance') ? 'relationship_memory' : (parsePersonaPreference(botBasePersona, 'bot_persona_guardedness') ? 'persona_memory' : 'surface_policy'))
  };
}

function buildRelationshipState({ userId, groupId, memoryContext, affinityState, profile }) {
  const persona = normalizeObject(memoryContext.persona, {});
  const relationshipStyle = normalizeText(persona.relationshipStyle || persona.userAdaptationPersona, 320);
  const relation = normalizeText(
    profile?.relation_stage
    || memoryContext?.profile?.relation_stage
    || affinityState?.relationship
    || affinityState?.level
    || '陌生人',
    48
  ) || '陌生人';
  const attitude = normalizeText(
    affinityState?.attitude
    || memoryContext?.impressionText
    || '中立、保持距离',
    160
  ) || '中立、保持距离';
  const inferredDistance = relation === '亲密伙伴' ? 'close' : (relation === '普通朋友' ? 'friendly' : 'reserved');
  return {
    userId: normalizeText(userId),
    groupId: normalizeText(groupId),
    relationship: relation,
    attitude,
    replyStylePolicy: normalizeText(
      parsePersonaPreference(relationshipStyle, 'relationship_reply_style')
      || persona.replyStyle
      || memoryContext?.affinityState?.replyStylePolicy
      || '',
      220
    ),
    salutationPolicy: relation === '亲密伙伴' ? 'close' : (relation === '普通朋友' ? 'friendly' : 'reserved'),
    distanceMode: normalizeText(
      parsePersonaPreference(relationshipStyle, 'relationship_distance')
      || inferredDistance,
      64
    ),
    salutationStyle: normalizeText(parsePersonaPreference(relationshipStyle, 'relationship_salutation') || '', 120)
  };
}

function buildMemoryDigest(memoryContext = {}, options = {}) {
  const surfacePolicy = getSurfacePolicy(options.surface);
  const items = [];
  const push = (source, label, text, confidence = 0.5) => {
    const normalized = normalizeEvidenceItem({ source, label, text, confidence }, source);
    if (normalized) items.push(normalized);
  };

  push('generic_recall', 'retrieved', memoryContext.promptRetrievedMemoryText || memoryContext.retrievedMemoryForPrompt, 0.72);
  push('task_memory', 'task', memoryContext.taskMemoryText, 0.66);
  push('group_memory', 'group', memoryContext.groupMemoryText, 0.62);
  push('generic_recall', 'profile', memoryContext.promptLongTermProfileText || memoryContext.longTermProfileText, 0.7);
  push('bot_persona', 'bot_persona', memoryContext.persona?.botBasePersona, 0.82);
  push('relationship_style', 'relationship_style', memoryContext.persona?.relationshipStyle || memoryContext.persona?.userAdaptationPersona, 0.84);
  push('same_session_journal', 'journal', memoryContext.promptDailyJournalText || memoryContext.dailyJournalText, 0.58);

  const selected = uniqueBy(
    items.sort((a, b) => {
      const priorityBoost = (source) => {
        if (source === 'relationship_style') return 3;
        if (source === 'bot_persona') return 2;
        return 0;
      };
      const boostDiff = priorityBoost(b.source) - priorityBoost(a.source);
      if (boostDiff !== 0) return boostDiff;
      return Number(b.confidence || 0) - Number(a.confidence || 0);
    }),
    (item) => `${item.source}:${item.text}`
  ).slice(0, Math.max(1, Number(surfacePolicy.maxMemoryDigestItems) || 1));

  return {
    items: selected,
    text: selected.map((item) => `[${item.source}] ${item.text}`).join('\n'),
    bySource: selected.reduce((acc, item) => {
      acc[item.source] = acc[item.source] || [];
      acc[item.source].push(item.text);
      return acc;
    }, {})
  };
}

function buildPromptBlock(label, text, tokenBudget) {
  const value = clampMessageText(text, tokenBudget, 480);
  if (!value) return null;
  return {
    label,
    text: value,
    message: { role: 'system', content: `[${label}]\n${value}` }
  };
}

function sanitizePromptBlocks(blocks = [], totalBudget = 2400) {
  const selected = normalizeArray(blocks).filter(Boolean);
  const messages = [];
  let used = 0;
  for (const block of selected) {
    const msg = block?.message;
    if (!msg) continue;
    const cost = estimateTokens(String(msg.content || ''));
    if (used > 0 && used + cost > totalBudget && block.label !== 'PersonaCore' && block.label !== 'SurfacePolicy') {
      continue;
    }
    messages.push(msg);
    used += cost;
  }
  return messages;
}

function formatRelationshipStateText(state = {}) {
  const lines = [];
  if (state.relationship) lines.push(`relationship=${state.relationship}`);
  if (state.distanceMode) lines.push(`distance=${state.distanceMode}`);
  if (state.attitude) lines.push(`tone=${normalizeText(state.attitude, 72)}`);
  if (state.replyStylePolicy) lines.push(`reply=${normalizeText(state.replyStylePolicy, 72)}`);
  if (state.salutationStyle || state.salutationPolicy) lines.push(`salutation=${normalizeText(state.salutationStyle || state.salutationPolicy, 48)}`);
  return lines.join('\n');
}

function formatContinuityStateText(state = {}, options = {}) {
  const lines = [];
  if (state.activeTopic) lines.push(`active_topic=${state.activeTopic}`);
  if (state.carryOverUserTurn) lines.push(`carry_over_user_turn=${state.carryOverUserTurn}`);
  if (normalizeArray(state.openLoops).length) lines.push(`open_loops=${state.openLoops.join(' | ')}`);
  if (normalizeArray(state.assistantCommitments).length) lines.push(`assistant_commitments=${state.assistantCommitments.join(' | ')}`);
  if (normalizeArray(state.userConstraints).length) lines.push(`user_constraints=${state.userConstraints.join(' | ')}`);
  if (state.phaseHint) lines.push(`phase_hint=${state.phaseHint}`);
  if (state.replyPosture) lines.push(`reply_posture=${state.replyPosture}`);
  if (normalizeArray(state.activePersonaModules).length) lines.push(`active_persona_modules=${state.activePersonaModules.join(' | ')}`);
  if (normalizeArray(state.styleAnchors).length) lines.push(`style_anchors=${state.styleAnchors.join(' | ')}`);
  if (state.sceneTopic) lines.push(`scene_topic=${state.sceneTopic}`);
  if (state.sceneAtmosphere) lines.push(`scene_atmosphere=${state.sceneAtmosphere}`);
  if (state.recentReplyFrame && options.includeRecentReplyFrame !== false) lines.push(`recent_reply_frame=${state.recentReplyFrame}`);
  if (state.summary) lines.push(`summary=${state.summary}`);
  if (normalizeObject(state.sources) && Object.keys(state.sources).length > 0) {
    const sourceLines = [];
    if (state.sources.activeTopic) sourceLines.push(`active_topic:${state.sources.activeTopic}`);
    if (state.sources.carryOverUserTurn) sourceLines.push(`carry_over:${state.sources.carryOverUserTurn}`);
    if (state.sources.summary) sourceLines.push(`summary:${state.sources.summary}`);
    if (sourceLines.length) lines.push(`sources=${sourceLines.join(', ')}`);
  }
  return lines.join('\n');
}

function formatExpressionStateText(state = {}) {
  const compact = (entry, fallback = '') => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      return normalizeText(entry.value || fallback, 24);
    }
    return normalizeText(entry || fallback, 24);
  };
  return [
    `reply_posture=${compact(state.replyPosture, 'light')}`,
    `warmth=${compact(state.warmth, 'mid')}`,
    `play=${compact(state.playfulness, 'low')}`,
    `tease=${compact(state.tease, 'off')}`,
    `initiative=${compact(state.initiative, 'reply')}`,
    `jargon=${compact(state.jargon, 'off')}`,
    `verbosity=${compact(state.verbosity, 'normal')}`,
    `guarded=${compact(state.guardedness, 'guarded')}`
  ].join('\n');
}

function formatMemoryDigestText(digest = {}) {
  return normalizeArray(digest.items)
    .map((item) => `[${item.source}${item.label ? `|${item.label}` : ''}] ${item.text}`)
    .join('\n');
}

function formatSurfacePolicyText(surface = '', policy = {}) {
  return [
    `surface=${surface || DEFAULT_SURFACE}`,
    `include_continuity=${policy.includeContinuity !== false}`,
    `include_relationship=${policy.includeRelationship !== false}`,
    `include_recent_reply_frame=${policy.includeRecentReplyFrame !== false}`,
    `include_deep_history=${policy.includeDeepHistory !== false}`,
    `allow_jargon=${policy.allowJargon || 'off'}`,
    `max_memory_digest_items=${Number(policy.maxMemoryDigestItems || 0) || 0}`
  ].join('\n');
}

function resolveContinuitySlots(candidates = {}, policy = {}) {
  const normalized = normalizeObject(candidates);
  const activeTopic = chooseBestScalar(normalized.activeTopic);
  const carryOver = chooseBestScalar(normalized.carryOver);
  const summary = chooseBestScalar(normalized.summary);
  const recentReplyFrame = chooseBestScalar(normalized.recentReplyFrame);
  const phaseHint = chooseBestScalar(normalized.phaseHint);
  const replyPosture = chooseBestScalar(normalized.replyPosture);
  const sceneTopic = chooseBestScalar(normalized.sceneTopic);
  const sceneAtmosphere = chooseBestScalar(normalized.sceneAtmosphere);
  const openLoops = mergeListCandidates(normalized.openLoops, 4);
  const assistantCommitments = mergeListCandidates(normalized.assistantCommitments, 4);
  const userConstraints = mergeListCandidates(normalized.userConstraints, 4);
  const styleAnchors = mergeListCandidates(normalized.styleAnchors, 4);
  const activePersonaModules = mergeListCandidates(normalized.activePersonaModules, 2);

  return {
    activeTopic: activeTopic?.text || '',
    openLoops,
    assistantCommitments,
    userConstraints,
    carryOverUserTurn: carryOver?.text || '',
    summary: summary?.text || '',
    recentReplyFrame: recentReplyFrame?.text || '',
    phaseHint: phaseHint?.text || '',
    replyPosture: replyPosture?.text || '',
    sceneTopic: sceneTopic?.text || '',
    sceneAtmosphere: sceneAtmosphere?.text || '',
    styleAnchors,
    activePersonaModules,
    confidence: Math.max(
      Number(activeTopic?.confidence || 0) || 0,
      Number(summary?.confidence || 0) || 0,
      Number(replyPosture?.confidence || 0) || 0,
      Number(sceneTopic?.confidence || 0) || 0
    ),
    sources: {
      activeTopic: activeTopic?.source || '',
      carryOverUserTurn: carryOver?.source || '',
      summary: summary?.source || '',
      phaseHint: phaseHint?.source || '',
      replyPosture: replyPosture?.source || '',
      sceneTopic: sceneTopic?.source || '',
      sceneAtmosphere: sceneAtmosphere?.source || '',
      openLoops: normalizeArray(normalized.openLoops).map((item) => item?.source).filter(Boolean),
      assistantCommitments: normalizeArray(normalized.assistantCommitments).map((item) => item?.source).filter(Boolean),
      userConstraints: normalizeArray(normalized.userConstraints).map((item) => item?.source).filter(Boolean),
      recentReplyFrame: recentReplyFrame?.source || '',
      styleAnchors: normalizeArray(normalized.styleAnchors).map((item) => item?.source).filter(Boolean),
      activePersonaModules: normalizeArray(normalized.activePersonaModules).map((item) => item?.source).filter(Boolean)
    },
    conflicts: {
      activeTopic: normalizeArray(normalized.activeTopic).length > 1,
      carryOverUserTurn: normalizeArray(normalized.carryOver).length > 1,
      summary: normalizeArray(normalized.summary).length > 1,
      replyPosture: normalizeArray(normalized.replyPosture).length > 1
    },
    policy: normalizeObject(policy)
  };
}

async function readSessionProjectionState(userId = '', sessionKey = '', request = {}) {
  if (!config.MEMORY_V3_ENABLED) return { restored: false, mode: 'none', session: null };
  return restoreSessionState(sessionKey, {
    userId,
    groupId: request.groupId || request.routeMeta?.groupId || request.routeMeta?.group_id || '',
    query: request.question || ''
  });
}

function buildContinuityCandidates({
  sessionProjection = {},
  shortTermState = {},
  shortTermRecentMessages = [],
  bridgeState = {},
  bridgeRecentMessages = [],
  sessionSummaries = [],
  journalBundle = {},
  memoryContext = {}
}) {
  const activeTopic = [];
  const openLoops = [];
  const assistantCommitments = [];
  const userConstraints = [];
  const carryOver = [];
  const summary = [];
  const recentReplyFrame = [];
  const phaseHint = [];
  const replyPosture = [];
  const sceneTopic = [];
  const sceneAtmosphere = [];
  const styleAnchors = [];
  const activePersonaModules = [];

  const pushScalar = (bucket, source, value, extras = {}) => {
    const candidate = buildCandidate(source, value, extras);
    if (candidate) bucket.push(candidate);
  };
  const pushList = (bucket, source, values, extras = {}) => {
    for (const value of normalizeArray(values)) {
      const candidate = buildCandidate(source, value, extras);
      if (candidate) bucket.push(candidate);
    }
  };

  const projection = normalizeObject(sessionProjection.session);
  pushScalar(activeTopic, 'session_projection', projection.activeTopic, { confidence: 0.98 });
  pushScalar(carryOver, 'session_projection', projection.carryOverUserTurn, { confidence: 0.98 });
  pushScalar(summary, 'session_projection', projection.summary, { confidence: 0.96 });
  pushScalar(phaseHint, 'session_projection', projection.phaseHint, { confidence: 0.92 });
  pushScalar(replyPosture, 'session_projection', projection.expressionState?.replyPosture, { confidence: 0.94 });
  pushScalar(sceneTopic, 'session_projection', projection.sceneState?.activeTopic, { confidence: 0.92 });
  pushScalar(sceneAtmosphere, 'session_projection', projection.sceneState?.atmosphere, { confidence: 0.9 });
  pushList(styleAnchors, 'session_projection', projection.expressionState?.styleAnchors, { confidence: 0.9 });
  pushList(activePersonaModules, 'session_projection', projection.moduleState?.activePersonaModules, { confidence: 0.92 });
  pushList(openLoops, 'session_projection', projection.openLoops, { confidence: 0.96 });
  pushList(assistantCommitments, 'session_projection', projection.assistantCommitments, { confidence: 0.96 });
  pushList(userConstraints, 'session_projection', projection.userConstraints, { confidence: 0.94 });
  if (normalizeArray(projection.recentMessages).length > 0) {
    pushScalar(recentReplyFrame, 'session_projection', createRecentReplyFrameFromMessages(projection.recentMessages)?.summary, { confidence: 0.94 });
  }

  const normalizedBridgeState = normalizeShortTermState(bridgeState);
  pushScalar(activeTopic, 'short_term_bridge', normalizedBridgeState.activeTopic, { confidence: 0.88 });
  pushScalar(carryOver, 'short_term_bridge', normalizedBridgeState.carryOverUserTurn, { confidence: 0.92 });
  pushScalar(summary, 'short_term_bridge', normalizedBridgeState.summary, { confidence: 0.84 });
  pushScalar(phaseHint, 'short_term_bridge', normalizedBridgeState.phaseHint, { confidence: 0.84 });
  pushScalar(replyPosture, 'short_term_bridge', normalizedBridgeState.expression?.replyPosture, { confidence: 0.88 });
  pushScalar(sceneTopic, 'short_term_bridge', normalizedBridgeState.scene?.activeTopic, { confidence: 0.82 });
  pushScalar(sceneAtmosphere, 'short_term_bridge', normalizedBridgeState.scene?.atmosphere, { confidence: 0.8 });
  pushList(styleAnchors, 'short_term_bridge', normalizedBridgeState.expression?.styleAnchors, { confidence: 0.82 });
  pushList(activePersonaModules, 'short_term_bridge', normalizedBridgeState.moduleState?.activePersonaModules, { confidence: 0.86 });
  pushList(openLoops, 'short_term_bridge', normalizedBridgeState.openLoops, { confidence: 0.86 });
  pushList(assistantCommitments, 'short_term_bridge', normalizedBridgeState.assistantCommitments, { confidence: 0.86 });
  pushList(userConstraints, 'short_term_bridge', normalizedBridgeState.userConstraints, { confidence: 0.84 });
  if (normalizeArray(bridgeRecentMessages).length > 0) {
    pushScalar(recentReplyFrame, 'short_term_bridge', createRecentReplyFrameFromMessages(bridgeRecentMessages)?.summary, { confidence: 0.84 });
  }

  const normalizedShortTerm = normalizeShortTermState(shortTermState);
  pushScalar(activeTopic, 'short_term_state', normalizedShortTerm.activeTopic, { confidence: 0.82 });
  pushScalar(carryOver, 'short_term_state', normalizedShortTerm.carryOverUserTurn, { confidence: 0.82 });
  pushScalar(summary, 'short_term_state', normalizedShortTerm.summary, { confidence: 0.78 });
  pushScalar(phaseHint, 'short_term_state', normalizedShortTerm.phaseHint, { confidence: 0.76 });
  pushScalar(replyPosture, 'short_term_state', normalizedShortTerm.expression?.replyPosture, { confidence: 0.76 });
  pushScalar(sceneTopic, 'short_term_state', normalizedShortTerm.scene?.activeTopic, { confidence: 0.72 });
  pushScalar(sceneAtmosphere, 'short_term_state', normalizedShortTerm.scene?.atmosphere, { confidence: 0.7 });
  pushList(styleAnchors, 'short_term_state', normalizedShortTerm.expression?.styleAnchors, { confidence: 0.74 });
  pushList(activePersonaModules, 'short_term_state', normalizedShortTerm.moduleState?.activePersonaModules, { confidence: 0.76 });
  pushList(openLoops, 'short_term_state', normalizedShortTerm.openLoops, { confidence: 0.78 });
  pushList(assistantCommitments, 'short_term_state', normalizedShortTerm.assistantCommitments, { confidence: 0.78 });
  pushList(userConstraints, 'short_term_state', normalizedShortTerm.userConstraints, { confidence: 0.76 });
  if (normalizeArray(shortTermRecentMessages).length > 0) {
    pushScalar(recentReplyFrame, 'short_term_state', createRecentReplyFrameFromMessages(shortTermRecentMessages)?.summary, { confidence: 0.76 });
  }

  const latestSessionSummary = normalizeArray(sessionSummaries)[0];
  pushScalar(summary, 'same_session_summary', latestSessionSummary?.summary, { confidence: 0.72 });
  pushScalar(activeTopic, 'same_session_summary', latestSessionSummary?.structured?.activeTopic, { confidence: 0.72 });
  pushScalar(carryOver, 'same_session_summary', latestSessionSummary?.structured?.carryOverUserTurn, { confidence: 0.72 });
  pushScalar(replyPosture, 'same_session_summary', latestSessionSummary?.structured?.expression?.replyPosture, { confidence: 0.68 });
  pushList(styleAnchors, 'same_session_summary', latestSessionSummary?.structured?.expression?.styleAnchors, { confidence: 0.66 });
  pushList(activePersonaModules, 'same_session_summary', latestSessionSummary?.structured?.moduleState?.activePersonaModules, { confidence: 0.66 });

  const sameSessionJournal = normalizeArray(journalBundle?.continuity?.sameSession);
  const journalEntry = sameSessionJournal[0] || normalizeArray(journalBundle?.continuity?.sameTopic)[0];
  if (journalEntry?.continuitySnapshot) {
    const snapshot = normalizeObject(journalEntry.continuitySnapshot);
    pushScalar(activeTopic, 'same_session_journal', snapshot.activeTopic, { confidence: 0.68 });
    pushScalar(carryOver, 'same_session_journal', snapshot.carryOverUserTurn, { confidence: 0.68 });
    pushList(openLoops, 'same_session_journal', snapshot.openLoops, { confidence: 0.68 });
    pushList(assistantCommitments, 'same_session_journal', snapshot.assistantCommitments, { confidence: 0.66 });
    pushList(userConstraints, 'same_session_journal', snapshot.userConstraints, { confidence: 0.64 });
  }

  pushScalar(summary, 'generic_recall', memoryContext.promptSummaryText || memoryContext.summary, { confidence: 0.48 });
  pushScalar(activeTopic, 'task_memory', memoryContext.taskMemoryText, { confidence: 0.44 });
  pushScalar(activeTopic, 'group_memory', memoryContext.groupMemoryText, { confidence: 0.42 });

  return {
    activeTopic,
    openLoops,
    assistantCommitments,
    userConstraints,
    carryOver,
    summary,
    recentReplyFrame,
    phaseHint,
    replyPosture,
    sceneTopic,
    sceneAtmosphere,
    styleAnchors,
    activePersonaModules
  };
}

async function composePersonaMemoryState(request = {}, options = {}) {
  const normalizedRequest = normalizeObject(request);
  const routeMeta = normalizeObject(normalizedRequest.routeMeta);
  const userId = normalizeText(normalizedRequest.userId || options.userId);
  const surface = normalizeText(options.surface || normalizedRequest.surface || DEFAULT_SURFACE).toLowerCase() || DEFAULT_SURFACE;
  const groupId = normalizeText(options.groupId || normalizedRequest.groupId || routeMeta.groupId || routeMeta.group_id);
  const sceneKey = normalizeText(
    options.sceneKey
    || normalizedRequest.sceneKey
    || routeMeta.sceneKey
    || resolveShortTermSceneKey(routeMeta)
  );
  const sessionKey = normalizeText(
    options.sessionKey
    || normalizedRequest.sessionKey
    || routeMeta.sessionKey
    || resolveShortTermSessionKey(userId, routeMeta)
  );
  const question = normalizeText(normalizedRequest.question || normalizedRequest.text || options.question, 1000);
  const shortTermStore = normalizeObject(options.shortTermMemory || options.shortTermStore);
  const chatHistory = normalizeObject(options.chatHistory || options.historyStore);
  const sharedShortTermContext = options.sharedShortTermContext && typeof options.sharedShortTermContext === 'object'
    ? options.sharedShortTermContext
    : buildSharedShortTermContextMessages(userId, normalizeObject(options.userInfo), {
      chatHistory,
      shortTermMemory: shortTermStore,
      routeMeta,
      sessionKey
    });
  const shortTermState = normalizeShortTermState(sharedShortTermContext.shortTermState);
  const shortTermRecentMessages = normalizeArray(sharedShortTermContext.recentHistory);
  const bridgeStore = loadBridgeStore();
  const bridgeEntry = normalizeObject(bridgeStore.sessions?.[sessionKey]);
  const bridgeState = normalizeShortTermState(bridgeEntry.shortTermState);
  const bridgeRecentMessages = normalizeArray(bridgeEntry.recentMessages);
  const sceneEntry = sceneKey ? normalizeShortTermState(shortTermStore?.[sceneKey]) : normalizeShortTermState({});
  const sessionProjection = await readSessionProjectionState(userId, sessionKey, {
    ...normalizedRequest,
    groupId
  });
  const sessionSummaries = getRecentSessionContextSummaries(sessionKey, { limit: 3 });
  const journalBundle = getDailyJournalRetrievalBundle(userId, {
    sessionKey,
    question,
    topic: shortTermState.activeTopic || bridgeState.activeTopic || question,
    lookbackDays: options.lookbackDays
  });
  const memoryContext = options.memoryContext && typeof options.memoryContext === 'object'
    ? options.memoryContext
    : await (options.useSyncMemoryContext ? buildMemoryContext : buildMemoryContextAsync)(userId, question, {
      routePolicyKey: normalizeText(normalizedRequest.routePolicyKey || options.routePolicyKey),
      topRouteType: normalizeText(normalizedRequest.topRouteType || options.topRouteType),
      groupId,
      sessionId: normalizeText(routeMeta.sessionId || routeMeta.session_id || normalizedRequest.sessionId),
      sessionKey,
      channelId: normalizeText(routeMeta.channelId || routeMeta.channel_id || normalizedRequest.channelId),
      taskType: normalizeText(routeMeta.taskType || routeMeta.task_type || normalizedRequest.taskType),
      agentName: normalizeText(routeMeta.agentName || routeMeta.agent_name),
      toolName: normalizeText(routeMeta.toolName || routeMeta.tool_name),
      sharedShortTermSignature: sharedShortTermContext.sharedShortTermSignature
    });
  const styleProfile = getStyleProfile(groupId);
  const socialContext = groupId ? getGroupSocialContext(groupId) : {};
  const affinityState = normalizeObject(memoryContext.affinityState) && Object.keys(normalizeObject(memoryContext.affinityState)).length
    ? memoryContext.affinityState
    : getUserAffinityState(userId);
  const profile = getUserProfile(userId) || {};
  const relationshipState = buildRelationshipState({
    userId,
    groupId,
    memoryContext,
    affinityState,
    profile
  });
  const continuityCandidates = buildContinuityCandidates({
    sessionProjection,
    shortTermState,
    shortTermRecentMessages,
    bridgeState,
    bridgeRecentMessages,
    sessionSummaries,
    journalBundle,
    memoryContext
  });
  const continuityState = resolveContinuitySlots(continuityCandidates, getSurfacePolicy(surface));
  if (!continuityState.sceneTopic && sceneEntry?.scene?.activeTopic) {
    continuityState.sceneTopic = sceneEntry.scene.activeTopic;
    continuityState.sources.sceneTopic = continuityState.sources.sceneTopic || 'scene_state';
  }
  if (!continuityState.sceneAtmosphere && sceneEntry?.scene?.atmosphere) {
    continuityState.sceneAtmosphere = sceneEntry.scene.atmosphere;
    continuityState.sources.sceneAtmosphere = continuityState.sources.sceneAtmosphere || 'scene_state';
  }
  if (normalizeArray(continuityState.styleAnchors).length === 0 && normalizeArray(sceneEntry?.expression?.styleAnchors).length > 0) {
    continuityState.styleAnchors = uniqueStrings(sceneEntry.expression.styleAnchors, 4, 96);
    continuityState.sources.styleAnchors = continuityState.sources.styleAnchors || ['scene_state'];
  }
  if (normalizeArray(continuityState.activePersonaModules).length === 0 && normalizeArray(shortTermState?.moduleState?.activePersonaModules).length > 0) {
    continuityState.activePersonaModules = uniqueStrings(shortTermState.moduleState.activePersonaModules, 2, 64);
    continuityState.sources.activePersonaModules = continuityState.sources.activePersonaModules || ['short_term_state'];
  }
  const recentReplyFrame = createRecentReplyFrameFromMessages(
    normalizeArray(sessionProjection.session?.recentMessages).length
      ? sessionProjection.session.recentMessages
      : (normalizeArray(bridgeRecentMessages).length ? bridgeRecentMessages : shortTermRecentMessages)
  );
  if (recentReplyFrame?.summary && !continuityState.recentReplyFrame) {
    continuityState.recentReplyFrame = recentReplyFrame.summary;
    continuityState.sources.recentReplyFrame = continuityState.sources.recentReplyFrame || 'recent_messages';
  }
  const expressionState = buildExpressionState({
    surface,
    relationshipState,
    styleProfile,
    socialContext,
    memoryContext
  });
  const inheritedReplyPosture = normalizeReplyPosture(
    shortTermState.expression?.replyPosture
    || bridgeState.expression?.replyPosture
    || continuityState.replyPosture
  );
  expressionState.replyPosture = buildExpressionValue(
    inheritedReplyPosture || inferReplyPostureFromSignals({
      surface,
      expressionState: shortTermState.expression || {},
      continuityState,
      question
    }),
    inheritedReplyPosture ? 'short_term_state' : 'runtime_inference'
  );
  if (normalizeArray(continuityState.styleAnchors).length > 0) {
    expressionState.styleAnchors = {
      value: continuityState.styleAnchors.join(' | '),
      source: normalizeArray(continuityState.sources?.styleAnchors).length > 0
        ? continuityState.sources.styleAnchors[0]
        : 'continuity_state'
    };
  }

  const currentModuleState = normalizeModuleState(shortTermState.moduleState || bridgeState.moduleState || {});
  const requestedModuleIds = normalizeArray(options.personaModules || normalizedRequest.personaModules).map((item) => normalizeText(item)).filter(Boolean);
  const candidateModuleIds = requestedModuleIds.length > 0 ? requestedModuleIds : normalizeArray(continuityState.activePersonaModules);
  let nextModuleState = normalizeModuleState({
    ...currentModuleState,
    activePersonaModules: candidateModuleIds.length > 0 ? candidateModuleIds : currentModuleState.activePersonaModules,
    lastSurface: surface,
    lastTopicFingerprint: computeTopicFingerprint([continuityState.activeTopic, continuityState.sceneTopic, question]),
    lastUpdatedAt: Date.now()
  });
  const previousTopicFingerprint = normalizeText(currentModuleState.lastTopicFingerprint);
  const currentTopicFingerprint = normalizeText(nextModuleState.lastTopicFingerprint);
  const explicitFeedback = detectExplicitPersonaFeedback(question);
  const sameSurface = normalizeText(currentModuleState.lastSurface) === surface;
  const topicStable = previousTopicFingerprint && previousTopicFingerprint === currentTopicFingerprint;
  const currentModules = uniqueStrings(currentModuleState.activePersonaModules, 2, 64);
  const requestedModules = uniqueStrings(candidateModuleIds, 2, 64);
  const requestedChanged = JSON.stringify(currentModules) !== JSON.stringify(requestedModules);
  if (currentModules.length > 0 && sameSurface && topicStable && !explicitFeedback.isFeedback && !requestedChanged && Number(continuityState.confidence || 0) >= 0.55) {
    nextModuleState = normalizeModuleState({
      ...nextModuleState,
      activePersonaModules: currentModules,
      stickyTurnsRemaining: Math.max(0, Math.min(5, Number(currentModuleState.stickyTurnsRemaining || 3) || 3)),
      switchReason: currentModuleState.switchReason || 'sticky_continue'
    });
  } else if (currentModules.length > 0 && requestedChanged) {
    nextModuleState = normalizeModuleState({
      ...nextModuleState,
      activePersonaModules: requestedModules,
      stickyTurnsRemaining: 3,
      switchReason: 'requested_switch'
    });
  } else if (currentModules.length > 0 && !sameSurface) {
    nextModuleState = normalizeModuleState({
      ...nextModuleState,
      stickyTurnsRemaining: 3,
      switchReason: 'surface_changed'
    });
  } else if (currentModules.length > 0 && previousTopicFingerprint && previousTopicFingerprint !== currentTopicFingerprint) {
    nextModuleState = normalizeModuleState({
      ...nextModuleState,
      activePersonaModules: requestedModules.length > 0 ? requestedModules : currentModules,
      stickyTurnsRemaining: 3,
      switchReason: 'topic_shift'
    });
  } else if (explicitFeedback.isFeedback) {
    nextModuleState = normalizeModuleState({
      ...nextModuleState,
      stickyTurnsRemaining: 3,
      switchReason: explicitFeedback.polarity === 'negative' ? 'explicit_negative_feedback' : 'explicit_positive_feedback'
    });
  } else if (currentModules.length === 0 && requestedModules.length > 0) {
    nextModuleState = normalizeModuleState({
      ...nextModuleState,
      activePersonaModules: requestedModules,
      stickyTurnsRemaining: 3,
      switchReason: 'new_activation'
    });
  }

  continuityState.phaseHint = continuityState.phaseHint || shortTermState.phaseHint || shortTermState.interaction?.phaseHint || '';
  continuityState.replyPosture = expressionState.replyPosture.value || continuityState.replyPosture;
  continuityState.activePersonaModules = uniqueStrings(
    nextModuleState.activePersonaModules.length > 0 ? nextModuleState.activePersonaModules : continuityState.activePersonaModules,
    2,
    64
  );
  continuityState.styleAnchors = uniqueStrings(
    normalizeArray(continuityState.styleAnchors).length > 0
      ? continuityState.styleAnchors
      : normalizeArray(shortTermState.expression?.styleAnchors),
    4,
    96
  );

  const memoryDigest = buildMemoryDigest(memoryContext, { surface });
  const personaCore = {
    text: loadPersonaCoreText(),
    source: 'static_persona_manifest'
  };
  const evidence = {
    continuityCandidates,
    sessionProjection: normalizeObject(sessionProjection.session),
    shortTermBridge: bridgeEntry,
    shortTermState,
    sessionSummaries,
    journal: normalizeObject(journalBundle.continuity),
    memoryContext: {
      promptRetrievedMemoryText: memoryContext.promptRetrievedMemoryText || '',
      styleSignalText: memoryContext.styleSignalText || '',
      taskMemoryText: memoryContext.taskMemoryText || '',
      groupMemoryText: memoryContext.groupMemoryText || '',
      dailyJournalText: memoryContext.promptDailyJournalText || memoryContext.dailyJournalText || '',
      persona: normalizeObject(memoryContext.persona)
    },
    styleProfile,
    socialContext,
    affinityState
  };

  return {
    version: STATE_VERSION,
    surface,
    sceneKey,
    sessionKey,
    userId,
    groupId,
    personaCore,
    relationshipState,
    continuityState,
    expressionState,
    moduleState: nextModuleState,
    memoryDigest,
    evidence
  };
}

function renderPersonaMemoryPrompt(state = {}, surface = '') {
  const normalizedState = normalizeObject(state);
  const surfaceName = normalizeText(surface || normalizedState.surface || DEFAULT_SURFACE).toLowerCase() || DEFAULT_SURFACE;
  const surfacePolicy = getSurfacePolicy(surfaceName);
  const promptBudget = Math.max(1000, Number(config.MAIN_PROMPT_PERSONA_MEMORY_MAX_TOKENS || 2200) || 2200);
  const promptBlocks = [
    buildPromptBlock('PersonaCore', normalizedState.personaCore?.text, Math.min(promptBudget * 0.3, 900)),
    surfacePolicy.includeRelationship !== false
      ? buildPromptBlock('RelationshipState', formatRelationshipStateText(normalizedState.relationshipState), 220)
      : null,
    surfacePolicy.includeContinuity !== false
      ? buildPromptBlock('ContinuityState', formatContinuityStateText(normalizedState.continuityState, {
          includeRecentReplyFrame: surfacePolicy.includeRecentReplyFrame !== false
        }), 360)
      : null,
    buildPromptBlock('ExpressionPolicy', formatExpressionStateText(normalizedState.expressionState), 140),
    buildPromptBlock('RelevantMemoryDigest', formatMemoryDigestText(normalizedState.memoryDigest), 360),
    buildPromptBlock('SurfacePolicy', formatSurfacePolicyText(surfaceName, surfacePolicy), 140)
  ].filter(Boolean);

  return {
    systemMessages: sanitizePromptBlocks(promptBlocks, promptBudget),
    promptBlocks,
    policy: surfacePolicy
  };
}

function deriveSessionCheckpointPayload(state = {}, payload = {}) {
  const continuity = normalizeObject(state.continuityState);
  const expression = normalizeObject(state.expressionState);
  const moduleState = normalizeObject(state.moduleState);
  const recentReplyFrame = normalizeText(payload.recentReplyFrame || continuity.recentReplyFrame, 320);
  const recentMessages = normalizeArray(payload.recentMessages)
    .map((item) => ({
      role: normalizeText(item?.role || '', 16).toLowerCase(),
      content: normalizeText(item?.content || item?.text || '', 320)
    }))
    .filter((item) => (item.role === 'user' || item.role === 'assistant') && item.content)
    .slice(-Math.max(1, Number(config.MEMORY_V3_SESSION_RECENT_MESSAGES || 6)));

  if (!recentMessages.length && recentReplyFrame) {
    recentMessages.push({ role: 'assistant', content: recentReplyFrame });
  }

  return {
    snapshotType: normalizeText(payload.snapshotType || 'post_reply'),
    activeTopic: normalizeText(payload.activeTopic || continuity.activeTopic, 180),
    carryOverUserTurn: normalizeText(payload.carryOverUserTurn || continuity.carryOverUserTurn, 220),
    summary: normalizeText(payload.summary || continuity.summary, 2400),
    openLoops: uniqueStrings(payload.openLoops || continuity.openLoops, 4, 120),
    assistantCommitments: uniqueStrings(payload.assistantCommitments || continuity.assistantCommitments, 4, 120),
    userConstraints: uniqueStrings(payload.userConstraints || continuity.userConstraints, 4, 120),
    recentMessages,
    phaseHint: normalizeText(payload.phaseHint || continuity.phaseHint, 48),
    interactionState: {
      activeTopic: normalizeText(payload.activeTopic || continuity.activeTopic, 180),
      carryOverUserTurn: normalizeText(payload.carryOverUserTurn || continuity.carryOverUserTurn, 220),
      openLoops: uniqueStrings(payload.openLoops || continuity.openLoops, 4, 120),
      assistantCommitments: uniqueStrings(payload.assistantCommitments || continuity.assistantCommitments, 4, 120),
      userConstraints: uniqueStrings(payload.userConstraints || continuity.userConstraints, 4, 120),
      recentTurns: recentMessages,
      phaseHint: normalizeText(payload.phaseHint || continuity.phaseHint, 48),
      sourceFlags: uniqueStrings(continuity.sources?.activePersonaModules || continuity.sources?.styleAnchors || [], 8, 80),
      confidence: Math.max(0, Math.min(1, Number(continuity.confidence || 0) || 0))
    },
    sceneState: {
      sceneKey: normalizeText(payload.sceneKey || state.sceneKey, 96),
      activeTopic: normalizeText(payload.sceneTopic || continuity.sceneTopic, 180),
      atmosphere: normalizeText(payload.sceneAtmosphere || continuity.sceneAtmosphere, 120),
      activePair: normalizeText(payload.activePair || '', 120),
      quoteAnchor: normalizeText(payload.quoteAnchor || '', 180),
      jargonHints: uniqueStrings(payload.jargonHints || [], 4, 80),
      recentTurns: recentMessages.slice(-4),
      confidence: Math.max(0, Math.min(1, Number(payload.sceneConfidence || continuity.confidence || 0) || 0))
    },
    expressionState: {
      replyPosture: normalizeText(payload.replyPosture || continuity.replyPosture || expression.replyPosture?.value || expression.replyPosture, 24),
      warmth: normalizeText(payload.warmth || expression.warmth?.value || expression.warmth, 24),
      guardedness: normalizeText(payload.guardedness || expression.guardedness?.value || expression.guardedness, 24),
      initiative: normalizeText(payload.initiative || expression.initiative?.value || expression.initiative, 24),
      jargonMode: normalizeText(payload.jargonMode || expression.jargon?.value || expression.jargon, 24),
      cadenceHint: normalizeText(payload.cadenceHint || '', 48),
      styleAnchors: uniqueStrings(payload.styleAnchors || continuity.styleAnchors || [], 4, 96),
      confidence: Math.max(0, Math.min(1, Number(payload.expressionConfidence || continuity.confidence || 0) || 0))
    },
    moduleState: {
      activePersonaModules: uniqueStrings(payload.activePersonaModules || moduleState.activePersonaModules || continuity.activePersonaModules || [], 2, 64),
      stickyTurnsRemaining: Math.max(0, Math.min(5, Number(payload.stickyTurnsRemaining || moduleState.stickyTurnsRemaining || 0) || 0)),
      switchReason: normalizeText(payload.switchReason || moduleState.switchReason, 160),
      lastSurface: normalizeText(payload.lastSurface || state.surface, 32),
      lastTopicFingerprint: normalizeText(payload.lastTopicFingerprint || computeTopicFingerprint([continuity.activeTopic, continuity.sceneTopic]), 96),
      lastUpdatedAt: Date.now()
    }
  };
}

function flattenExpressionState(expression = {}) {
  const normalized = normalizeObject(expression);
  return Object.entries(normalized).reduce((acc, [key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      acc[key] = normalizeText(value.value || '', 32);
      acc[`${key}Source`] = normalizeText(value.source || '', 32);
      return acc;
    }
    acc[key] = normalizeText(value, 32);
    return acc;
  }, {});
}

function detectExplicitPersonaFeedback(text = '') {
  const normalized = normalizeText(text, 800);
  if (!normalized) return { isFeedback: false, polarity: '', text: '' };
  if (/(你这样说更好|你这样就对了|这样说挺好|保持这样|就按这个风格|这样回复我喜欢)/i.test(normalized)) {
    return { isFeedback: true, polarity: 'positive', text: normalized };
  }
  if (/(别这么说|不要这么说|你太.*了|你别.*语气|别那么.*|不要这么回复|你这样说我不喜欢)/i.test(normalized)) {
    return { isFeedback: true, polarity: 'negative', text: normalized };
  }
  return { isFeedback: false, polarity: '', text: normalized };
}

function buildBotPersonaSlots(state = {}, payload = {}) {
  const expression = flattenExpressionState(state.expressionState);
  const personaText = normalizeText(state.evidence?.memoryContext?.persona?.botBasePersona || '', 320);
  const out = [];
  const push = (fieldKey, value, confidence = 0.78, sourceKind = 'runtime') => {
    const normalized = normalizeText(value, 140);
    if (!normalized) return;
    out.push({ fieldKey, value: normalized, confidence, sourceKind });
  };

  if (expression.warmth) push('bot_persona_tone', `基础语气偏${expression.warmth}`, 0.78);
  if (expression.initiative) push('bot_persona_initiative', `互动主动性=${expression.initiative}`, 0.8);
  if (expression.guardedness) push('bot_persona_guardedness', `边界感=${expression.guardedness}`, 0.8);
  if (expression.playfulness) push('bot_persona_playfulness', `玩笑感=${expression.playfulness}`, 0.78);
  if (expression.verbosity) push('bot_persona_verbosity', `回复详细度=${expression.verbosity}`, 0.78);
  if (personaText) push('bot_persona_boundaries', personaText, 0.84);

  const feedback = detectExplicitPersonaFeedback(
    `${normalizeText(payload.question || payload.userText || '', 320)} ${normalizeText(payload.finalReply || payload.reply || '', 320)}`
  );
  if (feedback.isFeedback) {
    push('bot_persona_tone', `用户对基础语气的${feedback.polarity === 'positive' ? '正向' : '负向'}反馈：${feedback.text}`, 0.9, 'explicit_feedback');
  }
  return out;
}

function buildRelationshipStyleSlots(state = {}, payload = {}) {
  const relationship = normalizeObject(state.relationshipState);
  const expression = flattenExpressionState(state.expressionState);
  const relationshipText = normalizeText(state.evidence?.memoryContext?.persona?.relationshipStyle || state.evidence?.memoryContext?.persona?.userAdaptationPersona || '', 320);
  const out = [];
  const push = (fieldKey, value, confidence = 0.8, sourceKind = 'runtime') => {
    const normalized = normalizeText(value, 160);
    if (!normalized) return;
    out.push({ fieldKey, value: normalized, confidence, sourceKind });
  };

  if (relationshipText) push('relationship_reply_style', relationshipText.replace(/relationship_[a-z_]+:\s*/gi, ''), 0.84);
  if (relationship.attitude) push('relationship_tone', relationship.attitude, 0.8);
  if (relationship.distanceMode) push('relationship_distance', relationship.distanceMode, 0.82);
  if (relationship.salutationStyle || relationship.salutationPolicy) push('relationship_salutation', relationship.salutationStyle || relationship.salutationPolicy, 0.8);
  if (relationship.replyStylePolicy) push('relationship_reply_style', relationship.replyStylePolicy, 0.82);
  if (expression.initiative) push('relationship_engagement', `互动积极度=${expression.initiative}`, 0.76);
  if (expression.guardedness) push('relationship_boundaries', `关系边界=${expression.guardedness}`, 0.76);

  const feedback = detectExplicitPersonaFeedback(normalizeText(payload.question || payload.userText || '', 320));
  if (feedback.isFeedback) {
    push('relationship_reply_style', `用户对相处语气的${feedback.polarity === 'positive' ? '正向' : '负向'}反馈：${feedback.text}`, 0.92, 'explicit_feedback');
  }
  return out;
}

async function recordPersonaMemoryOutcome(surface = '', payload = {}) {
  const normalizedPayload = normalizeObject(payload);
  const state = normalizeObject(normalizedPayload.state);
  const request = normalizeObject(normalizedPayload.request);
  const routeMeta = normalizeObject(request.routeMeta || normalizedPayload.routeMeta);
  const userId = normalizeText(normalizedPayload.userId || request.userId || state.userId);
  const sessionKey = normalizeText(
    normalizedPayload.sessionKey
    || request.sessionKey
    || state.sessionKey
    || resolveShortTermSessionKey(userId, routeMeta)
  );
  if (!config.MEMORY_V3_ENABLED || !userId || !sessionKey) {
    return { updatedSlots: {}, persisted: false };
  }

  const continuity = normalizeObject(state.continuityState);
  const expression = normalizeObject(state.expressionState);
  const groupId = normalizeText(normalizedPayload.groupId || request.groupId || routeMeta.groupId || routeMeta.group_id || state.groupId);
  const channelId = normalizeText(routeMeta.channelId || routeMeta.channel_id || request.channelId);
  const sessionId = normalizeText(routeMeta.sessionId || routeMeta.session_id || request.sessionId);
  const routePolicyKey = normalizeText(request.routePolicyKey || normalizedPayload.routePolicyKey);
  const topRouteType = normalizeText(request.topRouteType || normalizedPayload.topRouteType);
  const flattenedExpression = flattenExpressionState(expression);
  const expressionFingerprint = Object.entries(flattenedExpression)
    .map(([key, value]) => `${key}=${normalizeText(value, 32)}`)
    .filter(Boolean)
    .join(', ');
  const expressionGate = shouldBlockMemoryLearning(expressionFingerprint, 'style_pattern', {
    routePolicyKey,
    topRouteType
  });
  const checkpointPayload = deriveSessionCheckpointPayload(state, normalizedPayload);

  await appendMemoryEvent({
    type: 'session_checkpoint',
    userId,
    sessionKey,
    groupId,
    channelId,
    sessionId,
    routePolicyKey,
    topRouteType,
    scopeType: 'session',
    source: normalizeText(surface || state.surface || DEFAULT_SURFACE),
    sourceKind: 'runtime',
    payload: checkpointPayload
  });

  const botPersonaSlots = buildBotPersonaSlots(state, {
    ...normalizedPayload,
    question: request.question || normalizedPayload.question || '',
    finalReply: normalizedPayload.finalReply || normalizedPayload.reply || ''
  });
  const relationshipSlots = buildRelationshipStyleSlots(state, {
    ...normalizedPayload,
    question: request.question || normalizedPayload.question || '',
    finalReply: normalizedPayload.finalReply || normalizedPayload.reply || ''
  });

  const sourceName = normalizeText(surface || state.surface || DEFAULT_SURFACE);
  const writePersonaSlot = async (memoryKind, fieldKey, value, options = {}) => {
    const sanitizedValue = sanitizeUntrustedContent(value, 'memory');
    if (!sanitizedValue) return false;
    await appendMemoryEvent({
      type: 'memory_confirmed',
      userId,
      sessionKey,
      groupId,
      channelId,
      sessionId,
      routePolicyKey,
      topRouteType,
      scopeType: 'personal',
      source: sourceName,
      sourceKind: options.sourceKind || 'runtime',
      status: 'active',
      memoryKind,
      semanticSlot: fieldKey,
      text: sanitizedValue,
      payload: {
        fieldKey,
        type: 'fact'
      },
      confidence: Number(options.confidence || 0.8) || 0.8,
      importance: Number(options.importance || 0.72) || 0.72,
      evidenceCount: Math.max(2, Number(options.evidenceCount || 2) || 2)
    });
    return true;
  };

  if (expressionFingerprint && !expressionGate.blocked) {
    await appendMemoryEvent({
      type: 'memory_confirmed',
      userId,
      sessionKey,
      groupId,
      channelId,
      sessionId,
      routePolicyKey,
      topRouteType,
      scopeType: 'personal',
      source: sourceName,
      sourceKind: 'runtime',
      status: 'active',
      memoryKind: 'style',
      semanticSlot: 'style_pattern',
      text: `style: ${sanitizeUntrustedContent(expressionFingerprint, 'memory')}`,
      payload: {
        fieldKey: 'style_pattern',
        type: 'fact'
      },
      confidence: 0.7,
      importance: 0.6,
      evidenceCount: 1
    });
  }

  const personaSlotsUpdated = [];
  for (const slot of botPersonaSlots) {
    const wrote = await writePersonaSlot('bot_persona', slot.fieldKey, slot.value, {
      confidence: slot.confidence,
      importance: slot.sourceKind === 'explicit_feedback' ? 0.88 : 0.72,
      sourceKind: slot.sourceKind,
      evidenceCount: slot.sourceKind === 'explicit_feedback' ? 3 : 2
    });
    if (wrote) personaSlotsUpdated.push(slot.fieldKey);
  }

  const relationshipSlotsUpdated = [];
  for (const slot of relationshipSlots) {
    const wrote = await writePersonaSlot('relationship_style', slot.fieldKey, slot.value, {
      confidence: slot.confidence,
      importance: slot.sourceKind === 'explicit_feedback' ? 0.9 : 0.76,
      sourceKind: slot.sourceKind,
      evidenceCount: slot.sourceKind === 'explicit_feedback' ? 3 : 2
    });
    if (wrote) relationshipSlotsUpdated.push(slot.fieldKey);
  }

  materializeMemoryViews();
  return {
    updatedSlots: {
      activeTopic: checkpointPayload.activeTopic,
      openLoops: checkpointPayload.openLoops,
      assistantCommitments: checkpointPayload.assistantCommitments,
      userConstraints: checkpointPayload.userConstraints,
      carryOverUserTurn: checkpointPayload.carryOverUserTurn,
      replyPosture: checkpointPayload.expressionState?.replyPosture || '',
      activePersonaModules: uniqueStrings(checkpointPayload.moduleState?.activePersonaModules || [], 2, 64),
      recentReplyFrame: continuity.recentReplyFrame || '',
      personaSlotsUpdated: uniqueStrings(personaSlotsUpdated, 12, 80),
      relationshipSlotsUpdated: uniqueStrings(relationshipSlotsUpdated, 12, 80)
    },
    persisted: true
  };
}

module.exports = {
  CONTINUITY_PRIORITY,
  STATE_VERSION,
  composePersonaMemoryState,
  getSurfacePolicy,
  recordPersonaMemoryOutcome,
  renderPersonaMemoryPrompt,
  resolveContinuitySlots
};
