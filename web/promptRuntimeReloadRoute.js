const { reloadPromptSnapshot } = require('../utils/promptLoader');

function registerPromptRuntimeReloadRoute(app, deps = {}) {
  const reload = typeof deps.reloadPromptSnapshot === 'function'
    ? deps.reloadPromptSnapshot
    : reloadPromptSnapshot;

  app.post('/api/prompt-runtime/reload', (req, res) => {
    const result = reload();
    if (result && result.ok === true) {
      return res.json({ ok: true, version: result.version });
    }
    return res.status(503).json({
      ok: false,
      version: String(result?.version || ''),
      error: String(result?.error || 'Prompt runtime reload failed')
    });
  });
}

module.exports = {
  registerPromptRuntimeReloadRoute
};
