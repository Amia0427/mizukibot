const INTERNAL_CONTEXT_MARKERS = [
  '[Context for assistant only]',
  '[ContinuityState]',
  '[ActiveTopic]',
  '[EvidenceDigest]',
  '[SourceFlags]',
  '[CarryOverUserTurn]',
  '[OpenLoops]',
  '[AssistantCommitments]',
  '[ContinuityProbePolicy]',
  '[GlobalToolEvidence]',
  '[RetrievedMemoryLite]',
  '[ShortTermContinuity]',
  '[DailyJournal]',
  '[MemoryCLI]',
  '[RoleplayInnerProtocol]',
  '[InternalCheck]',
  '[内部检查]'
];

const { isBadRoleplayRefusalText } = require('./recallPollutionGuard');

function normalizeReplyGuardText(text = '') {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function containsInternalContextMarker(text = '') {
  const raw = String(text || '');
  return INTERNAL_CONTEXT_MARKERS.some((marker) => raw.includes(marker));
}

function isHiddenToolNarration(text = '') {
  const compact = normalizeReplyGuardText(text);
  if (!compact) return false;
  if (/^i['’]?ll\s+(?:search|look up|check|browse)\s+(?:for\s+)?["'`]/i.test(compact)) return true;
  if (/^i\s+will\s+(?:search|look up|check|browse)\s+(?:for\s+)?["'`]/i.test(compact)) return true;
  if (/^(?:searching|looking up|checking|browsing)\s+(?:for\s+)?["'`]/i.test(compact)) return true;
  if (/^(?:let me|i(?:'|’)m going to)\s+(?:search|look up|check|browse)\b/i.test(compact)) return true;
  return false;
}

function isInternalContextLeak(text = '') {
  return containsInternalContextMarker(normalizeReplyGuardText(text));
}

function isUnsafeUserFacingReply(text = '') {
  const compact = normalizeReplyGuardText(text);
  if (!compact) return false;
  return isInternalContextLeak(compact)
    || isHiddenToolNarration(compact)
    || isBadRoleplayRefusalText(compact, { allowBenignContext: false });
}

module.exports = {
  containsInternalContextMarker,
  isHiddenToolNarration,
  isInternalContextLeak,
  isUnsafeUserFacingReply,
  normalizeReplyGuardText
};
