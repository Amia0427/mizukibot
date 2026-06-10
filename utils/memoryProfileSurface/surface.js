const config = require('../../config');
const { canonicalizeText } = require('../memory-v3/helpers');
const {
  formatPromptProfileSurface
} = require('../memory-v3/profileLifecycle');
const { isPollutedMemoryText } = require('../recallPollutionGuard');
const { isRecentRecallQuery, classifyRecallFacet } = require('../recallHeuristics');

function sanitizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function uniqueStrings(values = [], limit = 20, maxChars = 180) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const text = sanitizeText(raw).slice(0, Math.max(1, Number(maxChars) || 180));
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= Math.max(1, Number(limit) || 1)) break;
  }
  return out;
}

function isSafeProfileSurfaceText(text = '') {
  return !isPollutedMemoryText(text, { allowBenignContext: true });
}

function safeProfileText(value = '') {
  const text = sanitizeText(value);
  return text && isSafeProfileSurfaceText(text) ? text : '';
}

function safeProfileStrings(values = [], limit = 20, maxChars = 180) {
  return uniqueStrings(values, limit, maxChars).filter((item) => isSafeProfileSurfaceText(item));
}

function nowMs(options = {}) {
  return Math.max(0, Number(options.now || options.nowTs || Date.now()) || Date.now());
}

function recentTopicTtlMs() {
  const days = Math.max(0, Number(config.MEMORY_PROFILE_RECENT_TOPIC_TTL_DAYS || 14) || 0);
  return days > 0 ? days * 24 * 3600 * 1000 : 0;
}

function getMetaForText(profile = {}, tier = '', field = '', text = '') {
  const key = canonicalizeText(text);
  if (!key) return null;
  return profile?.profileMeta?.[tier]?.[field]?.[key]
    || profile?.profileMeta?.[field]?.[key]
    || null;
}

function isRecentTopicExpired(profile = {}, text = '', options = {}) {
  const meta = getMetaForText(profile, 'weakProfile', 'recent_topics', text);
  const ttlMs = recentTopicTtlMs();
  if (!ttlMs) return false;
  const expiresAt = Number(meta?.expiresAt || 0) || 0;
  if (expiresAt) return expiresAt <= nowMs(options);
  const lastSeenAt = Number(meta?.lastSeenAt || 0) || 0;
  return lastSeenAt > 0 && nowMs(options) - lastSeenAt > ttlMs;
}

function buildTraceItem(profile = {}, tier = '', field = '', text = '', options = {}) {
  const meta = getMetaForText(profile, tier, field, text) || {};
  return {
    tier: tier === 'strictProfile' ? 'strict' : 'weak',
    field,
    text: sanitizeText(text),
    sourceEventIds: Array.isArray(meta.sourceEventIds) ? meta.sourceEventIds.slice(0, 12) : [],
    evidenceCount: Math.max(0, Number(meta.evidenceCount || 0) || 0),
    confidence: Math.max(0, Math.min(1, Number(meta.confidence || 0) || 0)),
    firstSeenAt: Number(meta.firstSeenAt || 0) || 0,
    lastSeenAt: Number(meta.lastSeenAt || 0) || 0,
    sourceKinds: Array.isArray(meta.sourceKinds) ? meta.sourceKinds.slice(0, 8) : [],
    conflictKey: sanitizeText(meta.conflictKey || ''),
    expiresAt: Number(meta.expiresAt || 0) || 0,
    expired: field === 'recent_topics' && isRecentTopicExpired(profile, text, options),
    extractionClass: sanitizeText(meta.extractionClass || '')
  };
}

function joinList(values = [], fallback = '') {
  const list = safeProfileStrings(values);
  return list.length ? list.join('、') : fallback;
}

function formatLegacyProfile(profile = {}) {
  if (!profile || typeof profile !== 'object') return '';
  return [
    profile.relation_stage ? `关系阶段：${sanitizeText(profile.relation_stage)}` : '',
    joinList(profile.identities) ? `身份信息：${joinList(profile.identities)}` : '',
    joinList(profile.personality_traits) ? `性格特征：${joinList(profile.personality_traits)}` : '',
    joinList(profile.hobbies) ? `爱好：${joinList(profile.hobbies)}` : '',
    joinList(profile.likes) ? `喜欢：${joinList(profile.likes)}` : '',
    joinList(profile.dislikes) ? `不喜欢：${joinList(profile.dislikes)}` : '',
    joinList(profile.goals) ? `目标：${joinList(profile.goals)}` : ''
  ].filter(Boolean).join('\n');
}

function normalizeStrictItems(profile = {}) {
  const strict = profile.strictProfile && typeof profile.strictProfile === 'object'
    ? profile.strictProfile
    : {};
  return {
    identities: safeProfileStrings(strict.identities, 20),
    personality_traits: safeProfileStrings(strict.personality_traits, 20),
    hobbies: safeProfileStrings(strict.hobbies, 20),
    likes: safeProfileStrings(strict.likes, 20),
    dislikes: safeProfileStrings(strict.dislikes, 20),
    goals: safeProfileStrings(strict.goals, 20),
    boundaries: safeProfileStrings(strict.boundaries, 20)
  };
}

function normalizeWeakItems(profile = {}) {
  const weak = profile.weakProfile && typeof profile.weakProfile === 'object'
    ? profile.weakProfile
    : {};
  return {
    single_hit_preferences: safeProfileStrings(weak.single_hit_preferences, 12),
    single_hit_traits: safeProfileStrings(weak.single_hit_traits, 12),
    recent_topics: safeProfileStrings(weak.recent_topics, 12)
  };
}

function normalizeWeakItemsForSurface(profile = {}, options = {}) {
  const weak = normalizeWeakItems(profile);
  return {
    ...weak,
    recent_topics: weak.recent_topics.filter((item) => !isRecentTopicExpired(profile, item, options))
  };
}

function isExplicitStrictProfileItem(profile = {}, field = '', text = '') {
  const meta = getMetaForText(profile, 'strictProfile', field, text) || {};
  const sourceKinds = Array.isArray(meta.sourceKinds) ? meta.sourceKinds.map((item) => sanitizeText(item).toLowerCase()) : [];
  return sourceKinds.includes('explicit');
}

function filterBasicSurfaceLikes(profile = {}, likes = []) {
  return uniqueStrings(likes).filter((item) => isExplicitStrictProfileItem(profile, 'likes', item));
}

function hasStableV3Profile(profile = {}) {
  if (!profile || typeof profile !== 'object') return false;
  const strict = normalizeStrictItems(profile);
  const persona = profile.personaCore && typeof profile.personaCore === 'object'
    ? profile.personaCore
    : {};
  return Boolean(
    sanitizeText(profile.relation_stage)
    || Object.values(strict).some((items) => Array.isArray(items) && items.length > 0)
    || safeProfileText(persona.summary)
    || safeProfileText(persona.impression)
    || safeProfileText(persona.botBasePersona)
    || safeProfileText(persona.userAdaptationPersona)
    || safeProfileText(persona.relationshipStyle)
    || safeProfileText(persona.replyStyle)
    || safeProfileText(persona.relationshipTone)
  );
}

function isProfileQuery(text = '') {
  const q = sanitizeText(text).toLowerCase();
  if (!q) return false;
  if (isRecentRecallQuery(q)) return false;
  if (classifyRecallFacet(q) === 'identity') return true;
  return /(你怎么看我|你觉得我|我的画像|人物画像|我是什么样的人|我是怎样的人|你对我的印象|总结一下我|who am i|my profile|what am i like)/i.test(q);
}

function hasStableProfileNeed(text = '') {
  const q = sanitizeText(text).toLowerCase();
  if (!q) return false;
  return /(你怎么看我|你觉得我|我的画像|人物画像|我是什么样的人|我是怎样的人|你对我的印象|我是谁|身份|偏好|爱好|喜欢什么样|喜欢怎样|喜欢哪种|回答方式|回复方式|表达风格|说话风格|who am i|my profile|what am i like|preference|reply style)/i.test(q);
}

function hasPersonaStyleNeed(text = '') {
  const q = sanitizeText(text).toLowerCase();
  if (!q) return false;
  return /(回答方式|回复方式|表达风格|说话风格|怎么说话|怎样说话|关系风格|关系语气|关系距离|保持距离|熟人感|熟人聊天|自然接话|突然客套|客套|reply style|relationship style|relationship tone)/i.test(q);
}

function resolveProfileSurfaceMode(options = {}) {
  const raw = sanitizeText(options.profileSurfaceMode || config.MEMORY_PROFILE_SURFACE_MODE || 'basic').toLowerCase();
  if (raw === 'full' || raw === 'legacy_full' || raw === 'all') return 'full';
  if (raw === 'minimal' || raw === 'basic' || raw === 'thin') return 'basic';
  return 'basic';
}

function shouldUseFullProfileSurface(options = {}) {
  if (options.forceFullProfileSurface === true) return true;
  if (options.basicProfileOnly === true) return false;
  return resolveProfileSurfaceMode(options) === 'full';
}

function shouldDisableProfileForQuestion(question = '', options = {}) {
  if (options.disableStableProfile === true || options.disableLongTermProfile === true) return true;
  if (options.forceStableProfile === true || options.forceLongTermProfile === true) return false;
  return config.MEMORY_PROFILE_DISABLE_FOR_RECAP !== false
    && isRecentRecallQuery(question)
    && !hasStableProfileNeed(question);
}

function buildV3ProfileText(profile = {}, options = {}) {
  if (!hasStableV3Profile(profile)) return '';
  const strict = normalizeStrictItems(profile);
  const weak = normalizeWeakItemsForSurface(profile, options);
  const persona = profile.personaCore && typeof profile.personaCore === 'object'
    ? profile.personaCore
    : {};
  const safePersona = {
    summary: safeProfileText(persona.summary),
    impression: safeProfileText(persona.impression),
    botBasePersona: safeProfileText(persona.botBasePersona),
    userAdaptationPersona: safeProfileText(persona.userAdaptationPersona),
    relationshipStyle: safeProfileText(persona.relationshipStyle),
    replyStyle: safeProfileText(persona.replyStyle),
    relationshipTone: safeProfileText(persona.relationshipTone)
  };
  const includeWeak = options.includeWeak === true || config.MEMORY_PROFILE_INJECT_WEAK_ITEMS === true;
  const fullSurface = shouldUseFullProfileSurface(options);
  const styleSurface = fullSurface || options.forcePersonaStyleSurface === true || hasPersonaStyleNeed(options.question || options.query || '');
  const basicLikes = fullSurface ? strict.likes : filterBasicSurfaceLikes(profile, strict.likes);
  const anchorLines = [];
  if (config.MEMORY_PROFILE_CURRENT_USER_ANCHOR !== false) {
    const userId = sanitizeText(options.userId || options.currentUserId || '');
    const nickname = sanitizeText(options.userNickname || options.senderName || options.card || options.nickname || '');
    if (userId) anchorLines.push(`当前用户ID：${userId}`);
    if (nickname) anchorLines.push(`当前用户昵称：${nickname}`);
  }
  const lines = [
    ...anchorLines,
    sanitizeText(profile.relation_stage) ? `关系阶段：${sanitizeText(profile.relation_stage)}` : '',
    fullSurface && safePersona.summary ? `总结：${safePersona.summary}` : '',
    fullSurface && safePersona.impression ? `印象：${safePersona.impression}` : '',
    styleSurface && safePersona.botBasePersona ? `基础人格：${safePersona.botBasePersona}` : '',
    styleSurface && safePersona.userAdaptationPersona ? `用户修正：${safePersona.userAdaptationPersona}` : '',
    styleSurface && safePersona.relationshipStyle ? `关系风格：${safePersona.relationshipStyle}` : '',
    styleSurface && safePersona.replyStyle ? `表达风格：${safePersona.replyStyle}` : '',
    styleSurface && safePersona.relationshipTone ? `关系语气：${safePersona.relationshipTone}` : '',
    strict.identities.length ? `身份信息：${strict.identities.join('、')}` : '',
    fullSurface && strict.personality_traits.length ? `性格特征：${strict.personality_traits.join('、')}` : '',
    fullSurface && strict.hobbies.length ? `爱好：${strict.hobbies.join('、')}` : '',
    basicLikes.length ? `喜欢：${basicLikes.join('、')}` : '',
    strict.dislikes.length ? `不喜欢：${strict.dislikes.join('、')}` : '',
    strict.goals.length ? `目标：${strict.goals.join('、')}` : '',
    strict.boundaries.length ? `边界：${strict.boundaries.join('、')}` : '',
    includeWeak && weak.single_hit_preferences.length ? `低置信偏好：${weak.single_hit_preferences.join('、')}` : '',
    includeWeak && weak.single_hit_traits.length ? `低置信特征：${weak.single_hit_traits.join('、')}` : '',
    includeWeak && weak.recent_topics.length ? `近期弱话题：${weak.recent_topics.join('、')}` : ''
  ].filter(Boolean);
  return formatPromptProfileSurface(lines.join('\n'));
}

function collectTraceItems(profile = {}, options = {}) {
  if (config.MEMORY_PROFILE_TRACE_ITEMS_ENABLED === false && options.includeTraceItems !== true) return [];
  const strict = normalizeStrictItems(profile);
  const weak = normalizeWeakItemsForSurface(profile, options);
  const includeWeak = options.includeWeak === true || config.MEMORY_PROFILE_INJECT_WEAK_ITEMS === true;
  const items = [];
  for (const [field, values] of Object.entries(strict)) {
    for (const value of values) items.push(buildTraceItem(profile, 'strictProfile', field, value, options));
  }
  if (includeWeak) {
    for (const [field, values] of Object.entries(weak)) {
      for (const value of values) items.push(buildTraceItem(profile, 'weakProfile', field, value, options));
    }
  }
  return items;
}

function collectExpiredRecentTopics(profile = {}, options = {}) {
  const weak = normalizeWeakItems(profile);
  return weak.recent_topics
    .filter((item) => isRecentTopicExpired(profile, item, options))
    .map((item) => buildTraceItem(profile, 'weakProfile', 'recent_topics', item, options));
}

module.exports = {
  buildTraceItem,
  buildV3ProfileText,
  collectExpiredRecentTopics,
  collectTraceItems,
  formatLegacyProfile,
  hasStableV3Profile,
  isProfileQuery,
  isSafeProfileSurfaceText,
  joinList,
  normalizeStrictItems,
  normalizeWeakItems,
  normalizeWeakItemsForSurface,
  recentTopicTtlMs,
  sanitizeText,
  shouldDisableProfileForQuestion,
  shouldUseFullProfileSurface,
  uniqueStrings
};
