const config = require('../config');
const memoryStore = require('./memory');
const { getUserProfile, getUserSummary, getUserImpression } = memoryStore;
const { loadProfileProjection } = require('./memory-v3/storage');
const { canonicalizeText } = require('./memory-v3/helpers');
const { isRecentRecallQuery, classifyRecallFacet } = require('./recallHeuristics');

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
  const list = uniqueStrings(values);
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
    identities: uniqueStrings(strict.identities, 20),
    personality_traits: uniqueStrings(strict.personality_traits, 20),
    hobbies: uniqueStrings(strict.hobbies, 20),
    likes: uniqueStrings(strict.likes, 20),
    dislikes: uniqueStrings(strict.dislikes, 20),
    goals: uniqueStrings(strict.goals, 20),
    boundaries: uniqueStrings(strict.boundaries, 20)
  };
}

function normalizeWeakItems(profile = {}) {
  const weak = profile.weakProfile && typeof profile.weakProfile === 'object'
    ? profile.weakProfile
    : {};
  return {
    single_hit_preferences: uniqueStrings(weak.single_hit_preferences, 12),
    single_hit_traits: uniqueStrings(weak.single_hit_traits, 12),
    recent_topics: uniqueStrings(weak.recent_topics, 12)
  };
}

function normalizeWeakItemsForSurface(profile = {}, options = {}) {
  const weak = normalizeWeakItems(profile);
  return {
    ...weak,
    recent_topics: weak.recent_topics.filter((item) => !isRecentTopicExpired(profile, item, options))
  };
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
    || sanitizeText(persona.summary)
    || sanitizeText(persona.impression)
    || sanitizeText(persona.botBasePersona)
    || sanitizeText(persona.userAdaptationPersona)
    || sanitizeText(persona.relationshipStyle)
    || sanitizeText(persona.replyStyle)
    || sanitizeText(persona.relationshipTone)
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
  const includeWeak = options.includeWeak === true || config.MEMORY_PROFILE_INJECT_WEAK_ITEMS === true;
  const fullSurface = shouldUseFullProfileSurface(options);
  const lines = [
    sanitizeText(profile.relation_stage) ? `关系阶段：${sanitizeText(profile.relation_stage)}` : '',
    fullSurface && sanitizeText(persona.summary) ? `总结：${sanitizeText(persona.summary)}` : '',
    fullSurface && sanitizeText(persona.impression) ? `印象：${sanitizeText(persona.impression)}` : '',
    fullSurface && sanitizeText(persona.botBasePersona) ? `基础人格：${sanitizeText(persona.botBasePersona)}` : '',
    fullSurface && sanitizeText(persona.userAdaptationPersona) ? `用户修正：${sanitizeText(persona.userAdaptationPersona)}` : '',
    fullSurface && sanitizeText(persona.relationshipStyle) ? `关系风格：${sanitizeText(persona.relationshipStyle)}` : '',
    fullSurface && sanitizeText(persona.replyStyle) ? `表达风格：${sanitizeText(persona.replyStyle)}` : '',
    fullSurface && sanitizeText(persona.relationshipTone) ? `关系语气：${sanitizeText(persona.relationshipTone)}` : '',
    strict.identities.length ? `身份信息：${strict.identities.join('、')}` : '',
    fullSurface && strict.personality_traits.length ? `性格特征：${strict.personality_traits.join('、')}` : '',
    fullSurface && strict.hobbies.length ? `爱好：${strict.hobbies.join('、')}` : '',
    fullSurface && strict.likes.length ? `喜欢：${strict.likes.join('、')}` : '',
    fullSurface && strict.dislikes.length ? `不喜欢：${strict.dislikes.join('、')}` : '',
    strict.goals.length ? `目标：${strict.goals.join('、')}` : '',
    strict.boundaries.length ? `边界：${strict.boundaries.join('、')}` : '',
    includeWeak && weak.single_hit_preferences.length ? `低置信偏好：${weak.single_hit_preferences.join('、')}` : '',
    includeWeak && weak.single_hit_traits.length ? `低置信特征：${weak.single_hit_traits.join('、')}` : '',
    includeWeak && weak.recent_topics.length ? `近期弱话题：${weak.recent_topics.join('、')}` : ''
  ].filter(Boolean);
  return lines.join('\n');
}

function buildLegacyFallback(userId, options = {}) {
  const profile = getUserProfile(userId);
  const summary = sanitizeText(getUserSummary(userId));
  const impression = sanitizeText(getUserImpression(userId));
  const profileText = shouldUseFullProfileSurface(options)
    ? formatLegacyProfile(profile)
    : [
        profile?.relation_stage ? `关系阶段：${sanitizeText(profile.relation_stage)}` : '',
        joinList(profile?.identities) ? `身份信息：${joinList(profile.identities)}` : '',
        joinList(profile?.goals) ? `目标：${joinList(profile.goals)}` : ''
      ].filter(Boolean).join('\n');
  const includeSummary = options.includeLegacySummary === true;
  const lines = [
    profileText,
    includeSummary && summary ? `总体总结：${summary}` : '',
    includeSummary && impression ? `总体印象：${impression}` : ''
  ].filter(Boolean);
  return {
    text: lines.join('\n'),
    profile,
    summary,
    impression
  };
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

function normalizeIssueList(values = []) {
  return (Array.isArray(values) ? values : [])
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      return {
        userId: sanitizeText(item.userId || ''),
        fieldKey: sanitizeText(item.fieldKey || ''),
        canonicalKey: sanitizeText(item.canonicalKey || ''),
        conflictKey: sanitizeText(item.conflictKey || ''),
        id: sanitizeText(item.id || ''),
        text: sanitizeText(item.text || ''),
        suppressedBy: sanitizeText(item.suppressedBy || ''),
        winnerText: sanitizeText(item.winnerText || ''),
        winnerId: sanitizeText(item.winnerId || ''),
        reason: sanitizeText(item.reason || '')
      };
    })
    .filter((item) => item && (item.text || item.conflictKey || item.reason));
}

function buildStableProfileText(userId, options = {}) {
  const question = sanitizeText(options.question || options.query || '');
  const disabled = shouldDisableProfileForQuestion(question, options);
  const includeWeak = options.includeWeak === true || (options.includeWeakForProfileQuery !== false && isProfileQuery(question));
  const fullSurface = shouldUseFullProfileSurface(options) || isProfileQuery(question);
  const canonicalSource = sanitizeText(options.canonicalSource || config.MEMORY_PROFILE_CANONICAL_SOURCE || 'v3').toLowerCase();
  const profileProjection = options.profileProjection && typeof options.profileProjection === 'object'
    ? options.profileProjection
    : loadProfileProjection();
  const v3Profile = profileProjection.users?.[String(userId || '').trim()] || null;
  const strictItems = normalizeStrictItems(v3Profile || {});
  const weakItems = normalizeWeakItemsForSurface(v3Profile || {}, options);
  const traceItems = collectTraceItems(v3Profile || {}, {
    ...options,
    includeWeak
  });
  const conflicts = normalizeIssueList((v3Profile || {}).conflicts || []);
  const suppressed = [
    ...normalizeIssueList((v3Profile || {}).suppressed || []),
    ...collectExpiredRecentTopics(v3Profile || {}, options).map((item) => ({
      userId: String(userId || ''),
      fieldKey: 'topic',
      canonicalKey: canonicalizeText(item.text),
      id: Array.isArray(item.sourceEventIds) ? String(item.sourceEventIds[0] || '') : '',
      text: item.text,
      suppressedBy: '',
      reason: 'recent_topic_expired'
    }))
  ];
  const expiresSoon = Array.isArray((v3Profile || {}).expiresSoon)
    ? (v3Profile || {}).expiresSoon.slice(0, 12)
    : [];
  const hasV3 = hasStableV3Profile(v3Profile || {});
  const shouldUseV3 = canonicalSource !== 'legacy' && hasV3;
  const legacyFallbackAllowed = options.legacyFallbackEnabled !== false
    && config.MEMORY_PROFILE_LEGACY_FALLBACK_ENABLED !== false;

  if (disabled) {
    return {
      text: '',
      source: 'disabled',
      disabled: true,
      reason: 'recap_query',
      strictItems,
      weakItems,
      traceItems: [],
      conflicts,
      suppressed,
      expiresSoon,
      legacyFallbackUsed: false,
      profile: v3Profile || {}
    };
  }

  if (shouldUseV3) {
    const text = buildV3ProfileText(v3Profile, {
      ...options,
      includeWeak,
      forceFullProfileSurface: fullSurface
    });
    return {
      text,
      source: 'v3',
      disabled: false,
      reason: '',
      strictItems,
      weakItems,
      traceItems,
      conflicts,
      suppressed,
      expiresSoon,
      legacyFallbackUsed: false,
      profile: v3Profile,
      persona: v3Profile.personaCore || {}
    };
  }

  if (legacyFallbackAllowed) {
    const legacy = buildLegacyFallback(userId, {
      includeLegacySummary: options.includeLegacySummary === true,
      forceFullProfileSurface: fullSurface
    });
    if (legacy.text) {
      return {
        text: legacy.text,
        source: 'legacy_fallback',
        disabled: false,
        reason: '',
        strictItems,
        weakItems,
        traceItems: [],
        conflicts,
        suppressed,
        expiresSoon,
        legacyFallbackUsed: true,
        legacy_fallback_used: true,
        profile: legacy.profile,
        summary: legacy.summary,
        impression: legacy.impression
      };
    }
  }

  return {
    text: '',
    source: hasV3 ? 'v3_empty' : 'none',
    disabled: false,
    reason: '',
    strictItems,
    weakItems,
    traceItems,
    conflicts,
    suppressed,
    expiresSoon,
    legacyFallbackUsed: false,
    profile: v3Profile || {}
  };
}

const LEGACY_TO_V3_FIELDS = Object.freeze({
  identities: 'identities',
  personality_traits: 'personality_traits',
  hobbies: 'hobbies',
  likes: 'likes',
  dislikes: 'dislikes',
  goals: 'goals',
  recent_topics: 'recent_topics',
  boundaries: 'boundaries'
});

function normalizeAuditFieldItems(values = []) {
  return uniqueStrings(values, 80, 220).map((text) => ({
    text,
    key: canonicalizeText(text)
  })).filter((item) => item.text && item.key);
}

function compareProfileFields(userId, legacyProfile = {}, v3Profile = {}, options = {}) {
  const legacyOnly = [];
  const v3Only = [];
  const duplicates = [];
  const conflicts = [];
  const suspicious = [];
  const v3Strict = normalizeStrictItems(v3Profile || {});
  const v3Weak = normalizeWeakItems(v3Profile || {});
  const legacyFieldMap = {
    identities: normalizeAuditFieldItems(legacyProfile.identities),
    personality_traits: normalizeAuditFieldItems(legacyProfile.personality_traits),
    hobbies: normalizeAuditFieldItems(legacyProfile.hobbies),
    likes: normalizeAuditFieldItems(legacyProfile.likes),
    dislikes: normalizeAuditFieldItems(legacyProfile.dislikes),
    goals: normalizeAuditFieldItems(legacyProfile.goals),
    recent_topics: normalizeAuditFieldItems(legacyProfile.recent_topics),
    boundaries: normalizeAuditFieldItems(legacyProfile.boundaries)
  };
  const v3FieldMap = {
    identities: normalizeAuditFieldItems(v3Strict.identities),
    personality_traits: normalizeAuditFieldItems(v3Strict.personality_traits),
    hobbies: normalizeAuditFieldItems(v3Strict.hobbies),
    likes: normalizeAuditFieldItems(v3Strict.likes),
    dislikes: normalizeAuditFieldItems(v3Strict.dislikes),
    goals: normalizeAuditFieldItems(v3Strict.goals),
    recent_topics: normalizeAuditFieldItems(v3Weak.recent_topics),
    boundaries: normalizeAuditFieldItems(v3Strict.boundaries)
  };

  for (const [legacyField, v3Field] of Object.entries(LEGACY_TO_V3_FIELDS)) {
    const legacyItems = legacyFieldMap[legacyField] || [];
    const v3Items = v3FieldMap[v3Field] || [];
    const legacyKeys = new Set(legacyItems.map((item) => item.key));
    const v3Keys = new Set(v3Items.map((item) => item.key));
    for (const item of legacyItems) {
      if (v3Keys.has(item.key)) duplicates.push({ userId, field: legacyField, text: item.text, source: 'legacy_and_v3' });
      else legacyOnly.push({ userId, field: legacyField, text: item.text, source: 'legacy' });
    }
    for (const item of v3Items) {
      if (!legacyKeys.has(item.key)) v3Only.push({ userId, field: v3Field, text: item.text, source: 'v3' });
    }
  }

  const legacyLikes = new Map(legacyFieldMap.likes.map((item) => [item.key, item]));
  const legacyDislikes = new Map(legacyFieldMap.dislikes.map((item) => [item.key, item]));
  const v3Likes = new Map(v3FieldMap.likes.map((item) => [item.key, item]));
  const v3Dislikes = new Map(v3FieldMap.dislikes.map((item) => [item.key, item]));
  for (const [key, like] of legacyLikes.entries()) {
    if (legacyDislikes.has(key)) conflicts.push({ userId, conflictKey: `legacy|preference|${key}`, text: like.text, otherText: legacyDislikes.get(key).text, source: 'legacy' });
    if (v3Dislikes.has(key)) conflicts.push({ userId, conflictKey: `legacy_v3|preference|${key}`, text: like.text, otherText: v3Dislikes.get(key).text, source: 'legacy_vs_v3' });
  }
  for (const [key, like] of v3Likes.entries()) {
    if (legacyDislikes.has(key)) conflicts.push({ userId, conflictKey: `v3_legacy|preference|${key}`, text: like.text, otherText: legacyDislikes.get(key).text, source: 'v3_vs_legacy' });
    if (v3Dislikes.has(key)) conflicts.push({ userId, conflictKey: `v3|preference|${key}`, text: like.text, otherText: v3Dislikes.get(key).text, source: 'v3' });
  }

  const ttlMs = recentTopicTtlMs();
  if (ttlMs) {
    for (const item of normalizeAuditFieldItems(legacyProfile.recent_topics)) {
      suspicious.push({ userId, field: 'recent_topics', text: item.text, reason: 'legacy_recent_topic_no_ttl' });
    }
    for (const item of collectExpiredRecentTopics(v3Profile || {}, options)) {
      suspicious.push({ userId, field: 'recent_topics', text: item.text, reason: 'v3_recent_topic_expired' });
    }
  }

  return { legacyOnly, v3Only, duplicates, conflicts, suspicious };
}

function auditLegacyProfileProjection(targetUserId = 'all', options = {}) {
  if (config.MEMORY_PROFILE_LEGACY_AUDIT_ENABLED === false && options.force !== true) {
    return {
      enabled: false,
      reason: 'MEMORY_PROFILE_LEGACY_AUDIT_ENABLED=false',
      users: {},
      totals: { users: 0, legacyOnly: 0, v3Only: 0, duplicates: 0, conflicts: 0, suspicious: 0 },
      shadowMigrationEvents: []
    };
  }
  const profileProjection = options.profileProjection && typeof options.profileProjection === 'object'
    ? options.profileProjection
    : loadProfileProjection();
  const legacyMemories = options.legacyMemories && typeof options.legacyMemories === 'object'
    ? options.legacyMemories
    : (memoryStore.memories || {});
  const requested = String(targetUserId || 'all').trim();
  const userIds = requested && requested !== 'all'
    ? [requested]
    : Array.from(new Set([
      ...Object.keys(legacyMemories || {}),
      ...Object.keys(profileProjection.users || {})
    ])).sort();
  const users = {};
  const totals = { users: 0, legacyOnly: 0, v3Only: 0, duplicates: 0, conflicts: 0, suspicious: 0 };
  for (const userId of userIds) {
    const legacyProfile = legacyMemories?.[userId]?.profile || {};
    const v3Profile = profileProjection.users?.[userId] || {};
    const report = compareProfileFields(userId, legacyProfile, v3Profile, options);
    users[userId] = {
      ...report,
      legacyFallbackWouldApply: !hasStableV3Profile(v3Profile) && Boolean(formatLegacyProfile(legacyProfile)),
      legacyProfilePresent: Boolean(formatLegacyProfile(legacyProfile)),
      v3ProfilePresent: hasStableV3Profile(v3Profile)
    };
    totals.users += 1;
    totals.legacyOnly += report.legacyOnly.length;
    totals.v3Only += report.v3Only.length;
    totals.duplicates += report.duplicates.length;
    totals.conflicts += report.conflicts.length;
    totals.suspicious += report.suspicious.length;
  }
  const shadowMigrationEvents = config.MEMORY_PROFILE_SHADOW_MIGRATION_ENABLED === true || options.shadowMigration === true
    ? Object.entries(users).flatMap(([userId, report]) => report.legacyOnly.map((item) => ({
      type: 'migration_bootstrap',
      userId,
      source: 'legacy_profile_audit',
      sourceKind: 'migration_bootstrap',
      status: 'candidate',
      memoryKind: item.field,
      semanticSlot: item.field,
      text: item.text,
      payload: { fieldKey: item.field, migrationSource: 'legacy_profile_audit' }
    })))
    : [];
  return {
    enabled: true,
    users,
    totals,
    shadowMigrationEvents,
    shadowMigrationWritten: false
  };
}

function explainStableProfile(userId, options = {}) {
  const result = buildStableProfileText(userId, {
    ...options,
    includeTraceItems: true,
    includeWeak: options.includeWeak === true || options.includeWeakEvidence === true || isProfileQuery(options.question || options.query || '')
  });
  return {
    userId: String(userId || '').trim(),
    text: result.text,
    source: result.source,
    profile_source: result.source,
    disabled: Boolean(result.disabled),
    reason: result.reason || '',
    strictItems: result.strictItems || {},
    weakItems: result.weakItems || {},
    traceItems: result.traceItems || [],
    conflicts: result.conflicts || [],
    suppressed: result.suppressed || [],
    expiresSoon: result.expiresSoon || [],
    legacyFallbackUsed: Boolean(result.legacyFallbackUsed),
    legacy_fallback_used: Boolean(result.legacyFallbackUsed)
  };
}

module.exports = {
  auditLegacyProfileProjection,
  buildStableProfileText,
  explainStableProfile,
  formatLegacyProfile,
  isProfileQuery,
  shouldDisableProfileForQuestion
};
