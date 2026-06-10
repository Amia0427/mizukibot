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

function countReasoningTraceCues(text = '') {
  const matches = String(text || '').match(/\b(?:maybe|what if|wait|let(?:'|’)s see|i need to|i should|the user (?:asks|wants|means)|they (?:ask|want|mean)|addressing the (?:question|message|song|user)|final answer|draft reply)\b/gi);
  return Array.isArray(matches) ? matches.length : 0;
}

function isReasoningTraceLeak(text = '') {
  const raw = String(text || '');
  const compact = normalizeReplyGuardText(raw);
  if (!compact) return false;
  if (/<think(?:ing)?\b|<\/think(?:ing)?\s*>/i.test(raw)) return true;
  if (/\b(?:reasoning_content|internal_check|chain[-\s]*of[-\s]*thought)\b/i.test(compact)) return true;
  if (/(?:思维链|思考过程|推理过程|内部推理|内部思考|隐藏推理|草稿).{0,40}(?:如下|内容|是|为|[:：=])/i.test(compact)) return true;
  if (/\*\s*\*(?:Addressing|Response|Final|Draft|Answer)\b[^*：:]{0,80}[:：]\s*\*?/i.test(raw)) return true;
  if (/\bAddressing the (?:question|message|song|user)\s*:/i.test(compact)) return true;

  const cueCount = countReasoningTraceCues(compact);
  if (cueCount >= 3) return true;
  if (cueCount >= 2 && /(?:\?|\bNo,\b|["“”]).{0,160}(?:\?|\bNo,\b|["“”])/i.test(compact)) return true;
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
    || isReasoningTraceLeak(text)
    || isPollutedMemoryText(compact, { allowBenignContext: false });
}

module.exports = {
  containsInternalContextMarker,
  isHiddenToolNarration,
  isInternalContextLeak,
  isReasoningTraceLeak,
  isUnsafeUserFacingReply,
  normalizeReplyGuardText
};
