const config = require('../../config');
const memoryStore = require('../memory');
const { getUserProfile, getUserSummary, getUserImpression } = memoryStore;
const { loadProfileProjection } = require('../memory-v3/storage');
const { canonicalizeText } = require('../memory-v3/helpers');
const { createLegacyProfileAudit } = require('./audit');
const { createProfileIssueHelpers } = require('./issues');
const { createLegacyProfileFallback } = require('./legacyFallback');
const {
  buildV3ProfileText,
  collectExpiredRecentTopics,
  collectTraceItems,
  formatLegacyProfile,
  hasStableV3Profile,
  isProfileQuery,
  joinList,
  normalizeStrictItems,
  normalizeWeakItems,
  normalizeWeakItemsForSurface,
  recentTopicTtlMs,
  sanitizeText,
  shouldDisableProfileForQuestion,
  shouldUseFullProfileSurface,
  uniqueStrings
} = require('./surface');

const { buildLegacyFallback } = createLegacyProfileFallback({
  formatLegacyProfile,
  getUserImpression,
  getUserProfile,
  getUserSummary,
  joinList,
  sanitizeText,
  shouldUseFullProfileSurface
});
const { normalizeIssueList } = createProfileIssueHelpers({ sanitizeText });

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
      userId: String(userId || '').trim(),
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

const { auditLegacyProfileProjection } = createLegacyProfileAudit({
  canonicalizeText,
  collectExpiredRecentTopics,
  formatLegacyProfile,
  hasStableV3Profile,
  loadProfileProjection,
  memoryStore,
  normalizeStrictItems,
  normalizeWeakItems,
  recentTopicTtlMs,
  uniqueStrings
});

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
