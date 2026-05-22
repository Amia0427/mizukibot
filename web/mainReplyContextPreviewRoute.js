const { buildMainReplyContextPreview } = require('../utils/mainReplyContextPreview');

function parsePreviewLimit(value) {
  return Math.max(1, Math.min(50, Number(value) || 12));
}

function registerMainReplyContextPreviewRoute(app, deps = {}) {
  const buildPreview = typeof deps.buildMainReplyContextPreview === 'function'
    ? deps.buildMainReplyContextPreview
    : buildMainReplyContextPreview;

  app.get('/api/main-reply-context-preview', (req, res) => {
    const limit = parsePreviewLimit(req.query.limit);
    return res.json({ ok: true, preview: buildPreview({ limit }) });
  });
}

module.exports = {
  parsePreviewLimit,
  registerMainReplyContextPreviewRoute
};
