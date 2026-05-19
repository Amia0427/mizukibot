const {
  normalizeShortTermState,
  resolveShortTermSessionKey
} = require('./shortTermMemory');
const {
  normalizeRecentTurns,
  normalizeStringList,
  trimLine
} = require('./continuityState/helpers');
const { getContinuityEvidenceBundle } = require('./continuityState/evidence');
const {
  formatContinuityStateMessage,
  hasSufficientLocalContinuityEvidence
} = require('./continuityState/format');

function buildContinuityState(options = {}) {
  const request = options.request && typeof options.request === 'object' ? options.request : {};
  const routeMeta = request.routeMeta && typeof request.routeMeta === 'object' ? request.routeMeta : {};
  const evidence = getContinuityEvidenceBundle(request.userId, request.question || '', options);
  const sessionKey = String(
    options.sessionKey
    || request.sessionKey
    || options.thread?.sessionKey
    || resolveShortTermSessionKey(request.userId, routeMeta)
    || evidence.payload?.sessionKey
    || ''
  ).trim();
  const shortTermState = normalizeShortTermState(evidence.payload?.shortTermState);
  const bridgeState = normalizeShortTermState(evidence.payload?.bridgeState);
  const bridgeRecentMessages = normalizeRecentTurns(evidence.payload?.bridgeRecentMessages, 4);
  const recentMessages = normalizeRecentTurns(evidence.payload?.recentMessages, 4);
  const continuityProbeDigest = normalizeStringList(evidence.payload?.continuityProbeDigest, options.probeDigestLimit || 3, 180);
  const sourceFlags = normalizeStringList(evidence.sourceFlags, 10, 80);
  const includeRecentTurns = recentMessages.length === 0 && bridgeRecentMessages.length > 0;

  const payload = {
    active_topic: trimLine(shortTermState.activeTopic || bridgeState.activeTopic, 180),
    open_loops: normalizeStringList(
      shortTermState.openLoops.length > 0 ? shortTermState.openLoops : bridgeState.openLoops,
      4,
      180
    ),
    assistant_commitments: normalizeStringList(
      shortTermState.assistantCommitments.length > 0 ? shortTermState.assistantCommitments : bridgeState.assistantCommitments,
      4,
      180
    ),
    user_constraints: normalizeStringList(
      shortTermState.userConstraints.length > 0 ? shortTermState.userConstraints : bridgeState.userConstraints,
      4,
      180
    ),
    carry_over_user_turn: trimLine(shortTermState.carryOverUserTurn || bridgeState.carryOverUserTurn, 220),
    recent_turns: includeRecentTurns ? bridgeRecentMessages : [],
    include_recent_turns: includeRecentTurns,
    continuity_probe_digest: continuityProbeDigest,
    source_flags: sourceFlags,
    summary: trimLine(shortTermState.summary || bridgeState.summary, 480),
    session_key: sessionKey,
    evidence_digest: normalizeStringList(evidence.digestLines, 3, 140),
    evidence_source: String(evidence.source || '').trim(),
    evidence_confidence: Number(evidence.confidence || 0) || 0
  };

  return {
    payload,
    text: formatContinuityStateMessage(payload, options.maxChars),
    hasSufficientEvidence: hasSufficientLocalContinuityEvidence(payload)
  };
}

module.exports = {
  buildContinuityState,
  formatContinuityStateMessage,
  getContinuityEvidenceBundle,
  hasSufficientLocalContinuityEvidence
};
