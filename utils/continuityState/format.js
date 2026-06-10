const config = require('../../config');
const {
  normalizeArray,
  normalizeRecentTurns,
  normalizeStringList,
  trimLine
} = require('./helpers');

function hasSufficientLocalContinuityEvidence(payload = {}) {
  const normalized = payload && typeof payload === 'object' ? payload : {};
  const sourceFlags = normalizeStringList(normalized.source_flags, 12, 80);
  if (sourceFlags.includes('recap_query')) {
    return Boolean(
      sourceFlags.includes('journal_active_raw')
      || sourceFlags.includes('journal_same_session')
      || normalizeArray(normalized.recent_turns).length >= 2
      || String(normalized.carry_over_user_turn || '').trim()
      || normalizeArray(normalized.open_loops).length > 0
      || normalizeArray(normalized.assistant_commitments).length > 0
    );
  }
  return Boolean(
    String(normalized.summary || '').trim()
    || normalizeArray(normalized.open_loops).length > 0
    || normalizeArray(normalized.assistant_commitments).length > 0
    || normalizeArray(normalized.recent_turns).length >= 2
    || String(normalized.carry_over_user_turn || '').trim()
  );
}

function formatContinuityStateMessage(continuityState = {}, maxChars = config.MAIN_PROMPT_CONTINUITY_MAX_CHARS || 800) {
  const state = continuityState && typeof continuityState === 'object' ? continuityState : {};
  const lines = ['[ContinuityState]'];
  const sourceFlags = normalizeStringList(state.source_flags, 10, 80);
  const recapQuery = sourceFlags.includes('recap_query');
  const evidenceDigest = normalizeStringList(state.evidence_digest, 4, 180);
  if (recapQuery && evidenceDigest.length > 0) lines.push(`[EvidenceDigest] ${evidenceDigest.join(' | ')}`);

  const activeTopic = trimLine(state.active_topic, 180);
  if (activeTopic) lines.push(`[ActiveTopic] ${activeTopic}`);

  const carryOverUserTurn = trimLine(state.carry_over_user_turn, 220);
  if (carryOverUserTurn) lines.push(`[CarryOverUserTurn] ${carryOverUserTurn}`);

  const openLoops = normalizeStringList(state.open_loops, 4, 180);
  if (openLoops.length > 0) lines.push(`[OpenLoops] ${openLoops.join(' | ')}`);

  const assistantCommitments = normalizeStringList(state.assistant_commitments, 4, 180);
  if (assistantCommitments.length > 0) lines.push(`[AssistantCommitments] ${assistantCommitments.join(' | ')}`);

  const userConstraints = normalizeStringList(state.user_constraints, 4, 180);
  if (userConstraints.length > 0) lines.push(`[UserConstraints] ${userConstraints.join(' | ')}`);

  const probeDigest = normalizeStringList(state.continuity_probe_digest, 3, 180);
  if (probeDigest.length > 0) lines.push(`[ContinuityProbeDigest] ${probeDigest.join(' | ')}`);

  if (!recapQuery && evidenceDigest.length > 0) lines.push(`[EvidenceDigest] ${evidenceDigest.join(' | ')}`);

  const includeRecentTurns = Boolean(state.include_recent_turns);
  const recentTurns = includeRecentTurns ? normalizeRecentTurns(state.recent_turns, 4) : [];
  if (recentTurns.length > 0) {
    lines.push('[RecentTurns]');
    for (const turn of recentTurns) {
      lines.push(`${turn.role === 'assistant' ? 'Assistant' : 'User'}: ${turn.content}`);
    }
  }

  if (sourceFlags.length > 0 && lines.length > 1) lines.push(`[SourceFlags] ${sourceFlags.join(', ')}`);

  const text = lines.join('\n').trim();
  if (!text || text === '[ContinuityState]') return '';
  return trimLine(text, Math.max(240, Number(maxChars) || 1200));
}

module.exports = {
  formatContinuityStateMessage,
  hasSufficientLocalContinuityEvidence
};
