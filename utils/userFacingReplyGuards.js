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

const { isPollutedMemoryText } = require('./recallPollutionGuard');

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
  if (/(?:刚才|刚刚)?偷偷(?:瞄|看)了一眼/i.test(compact)) return true;
  if (/(?:我|这边|刚才|刚刚).{0,6}(?:去)?(?:网上|网络|联网|网页).{0,6}(?:搜|搜索|查|查询|看|瞄)(?:了|过|完|了一下|了一眼|了一遍)/i.test(compact)) return true;
  if (/(?:查也查过了|搜也搜过了|搜索过了|联网看过了|网上看了一眼|去网上看了一眼)/i.test(compact)) return true;
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
    || isPollutedMemoryText(compact, { allowBenignContext: false });
}

module.exports = {
  containsInternalContextMarker,
  isHiddenToolNarration,
  isInternalContextLeak,
  isUnsafeUserFacingReply,
  normalizeReplyGuardText
};
