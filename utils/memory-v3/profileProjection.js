const {
  BOT_PERSONA_FIELDS,
  PERSONA_SUPPORT_FIELDS,
  RELATIONSHIP_STYLE_FIELDS,
  STRICT_PROFILE_FIELD_MAP,
  WEAK_PROFILE_FIELD_MAP
} = require('./profileProjection/fields');
const {
  createEmptyProfileProjection,
  pushProfileItem
} = require('./profileProjection/shape');
const {
  buildProfileConflictKey,
  resolveProfileNodeConflicts
} = require('./profileProjection/conflicts');
const {
  computeStabilityScore,
  getRecentTopicTtlMs,
  isExpiredRecentTopic,
  isExpiringSoonRecentTopic,
  isProfileProjectionBlockedByExtractionClass,
  resolveEvidenceTier
} = require('./profileProjection/evidence');
const { buildPersonaCore } = require('./profileProjection/personaCore');

module.exports = {
  BOT_PERSONA_FIELDS,
  PERSONA_SUPPORT_FIELDS,
  RELATIONSHIP_STYLE_FIELDS,
  STRICT_PROFILE_FIELD_MAP,
  WEAK_PROFILE_FIELD_MAP,
  buildPersonaCore,
  buildProfileConflictKey,
  computeStabilityScore,
  createEmptyProfileProjection,
  getRecentTopicTtlMs,
  isExpiredRecentTopic,
  isExpiringSoonRecentTopic,
  isProfileProjectionBlockedByExtractionClass,
  pushProfileItem,
  resolveEvidenceTier,
  resolveProfileNodeConflicts
};
