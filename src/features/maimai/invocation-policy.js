const { normalizeSongTitle } = require('./chart-analysis');
const { isMaimaiEnabled } = require('./feature-flags');
const { classifyMaimaiIntent } = require('./planner-routing');

function validateMaimaiToolInvocation(toolName, args = {}, context = {}, options = {}) {
  const enabled = options.enabled === undefined ? isMaimaiEnabled() : options.enabled === true;
  if (!enabled) return { allowed: false, reason: 'maimai_feature_disabled' };

  const currentText = String(context.cleanText || context.question || context.rawText || '').trim();
  const decision = classifyMaimaiIntent(currentText);
  if (!decision.matched || decision.tool !== toolName) {
    return { allowed: false, reason: 'maimai_route_mismatch', decision };
  }

  if (toolName === 'maimai_chart_analyze') {
    const title = String(args.title || '').trim();
    if (!title) return { allowed: false, reason: 'maimai_title_required', decision };
    const normalizedTitle = normalizeSongTitle(title);
    if (!normalizedTitle || !normalizeSongTitle(currentText).includes(normalizedTitle)) {
      return { allowed: false, reason: 'maimai_title_not_grounded', decision };
    }
  }

  return { allowed: true, reason: 'allowed', decision };
}

module.exports = { validateMaimaiToolInvocation };
