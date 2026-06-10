const config = require('../../config');
const { loadBridgeStore } = require('../shortTermBridgeMemory');
const {
  buildStructuredSummaryText,
  normalizeShortTermState,
  resolveShortTermSessionKey
} = require('../shortTermMemory');
const {
  classifyRecallFacet,
  shouldBiasToContinuity
} = require('../recallHeuristics');
const { sanitizeText } = require('./commandParser');
const {
  sanitizePreviewText,
  scoreTextMatch
} = require('./text');

function buildRecentSessionCandidates(userId, context = {}) {
  if (!config.MEMORY_CLI_RECENT_ENABLED) return [];

  const store = loadBridgeStore();
  const sessions = store && store.sessions && typeof store.sessions === 'object' ? store.sessions : {};
  const now = Date.now();
  const ttlMs = Math.max(1, Number(config.MEMORY_CLI_RECENT_TTL_HOURS || 72)) * 60 * 60 * 1000;
  const recentSessionMax = Math.max(1, Number(config.MEMORY_CLI_RECENT_SESSION_MAX || 3));
  const currentSessionKey = sanitizeText(resolveShortTermSessionKey(userId, context.routeMeta || {}));

  return Object.entries(sessions)
    .map(([sessionKey, entry]) => {
      const scope = entry?.scope && typeof entry.scope === 'object' ? entry.scope : {};
      if (String(scope.userId || entry?.userId || '').trim() !== String(userId || '').trim()) return null;

      const updatedAt = Number(entry?.updatedAt || 0) || 0;
      if (!updatedAt || (now - updatedAt) > ttlMs) return null;

      const state = normalizeShortTermState(entry?.shortTermState || {});
      const summary = buildStructuredSummaryText(state, Math.max(96, Number(config.SHORT_TERM_MEMORY_SUMMARY_MAX_TOKENS || 320)));
      const recentMessages = Array.isArray(entry?.recentMessages) ? entry.recentMessages : [];
      const recentMessageLimit = Math.max(1, Math.floor(Number(config.SHORT_TERM_BRIDGE_RECENT_MESSAGES || 64) || 64));
      const messagePreview = recentMessages
        .slice(-recentMessageLimit)
        .map((msg) => `${String(msg.role || '').trim()}: ${sanitizePreviewText(msg.content, 90)}`)
        .filter(Boolean)
        .join(' | ');
      const preview = [
        state.carryOverUserTurn ? `carry: ${state.carryOverUserTurn}` : '',
        state.activeTopic ? `topic: ${state.activeTopic}` : '',
        summary,
        messagePreview
      ].filter(Boolean).join(' | ');

      return {
        ref: `mc_ref:recent:${sessionKey}`,
        source: 'recent',
        type: 'recent_session',
        id: sessionKey,
        logicalId: sessionKey,
        title: sessionKey === currentSessionKey ? 'Current recent session' : `Recent session ${sessionKey}`,
        preview: sanitizePreviewText(preview, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
        text: sanitizeText([
          summary,
          state.carryOverUserTurn,
          state.activeTopic,
          state.openLoops.join(' | '),
          state.assistantCommitments.join(' | '),
          state.userConstraints.join(' | '),
          state.recentToolResults.join(' | '),
          messagePreview
        ].filter(Boolean).join('\n')),
        shortTermSummary: summary,
        shortTermState: state,
        recentMessages: recentMessages.slice(-recentMessageLimit),
        updatedAt,
        expiresAt: Number(entry?.expiresAt || 0) || 0,
        confidence: 0.86,
        tier: 'A',
        matchMode: 'lexical',
        snapshotType: String(entry?.snapshotType || 'post_reply').trim() || 'post_reply',
        scope
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.id === currentSessionKey && b.id !== currentSessionKey) return -1;
      if (b.id === currentSessionKey && a.id !== currentSessionKey) return 1;
      return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    })
    .slice(0, recentSessionMax);
}

function searchRecentCandidates(userId, query, context = {}) {
  const queryFacet = classifyRecallFacet(query);
  const continuityBias = shouldBiasToContinuity(queryFacet);
  return buildRecentSessionCandidates(userId, context)
    .map((item) => ({
      ...item,
      score: scoreTextMatch(query, item.text) + (continuityBias ? 0.62 : 0.42)
    }));
}

module.exports = {
  buildRecentSessionCandidates,
  searchRecentCandidates
};
