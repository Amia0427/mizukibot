const config = require('../../config');

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

function createLegacyProfileAudit(deps = {}) {
  const {
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
  } = deps;

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

  return {
    auditLegacyProfileProjection,
    compareProfileFields,
    normalizeAuditFieldItems
  };
}

module.exports = {
  LEGACY_TO_V3_FIELDS,
  createLegacyProfileAudit
};
