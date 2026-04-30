const { normalizeText } = require('./helpers');
const { loadSessionProjection } = require('./storage');
const { diagnoseProjectionFreshness } = require('./diagnostics');

async function restoreSessionState(sessionKey = '', options = {}) {
  const key = normalizeText(sessionKey);
  const projection = loadSessionProjection();
  const direct = projection.sessions?.[key] || null;
  const projectionFreshness = diagnoseProjectionFreshness({
    ...options,
    sessionKey: key
  });
  if (direct) {
    return {
      restored: true,
      mode: direct.snapshotType === 'pre_reply' ? 'pending' : 'checkpoint',
      session: direct,
      diagnostics: {
        projectionFreshness
      }
    };
  }
  return {
    restored: false,
    mode: 'none',
    session: null,
    queryHint: {
      userId: normalizeText(options.userId),
      groupId: normalizeText(options.groupId),
      query: normalizeText(options.query || 'where did we leave off')
    },
    diagnostics: {
      projectionFreshness
    }
  };
}

module.exports = {
  restoreSessionState
};
