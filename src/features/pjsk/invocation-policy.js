const { normalizeDifficulty, normalizeSongTitle } = require('./chart-analysis');
const { isPjskEnabled } = require('./feature-flags');
const { classifyPjskIntent } = require('./planner-routing');
const { pjskReferenceStore } = require('./reference-store');

function isDifficultyGrounded(difficulty, currentText) {
  const normalized = normalizeDifficulty(difficulty);
  if (!normalized) return true;
  const signals = {
    easy: /(?:easy|[绿綠]谱)/i,
    normal: /(?:normal|[蓝藍]谱)/i,
    hard: /(?:hard|[黄黃]谱)/i,
    expert: /(?:expert|[红紅]谱)/i,
    master: /(?:master|紫谱)/i,
    append: /(?:append|apd)/i
  };
  return signals[normalized].test(currentText);
}

function validatePjskToolInvocation(toolName, args = {}, context = {}, options = {}) {
  const enabled = options.enabled === undefined ? isPjskEnabled() : options.enabled === true;
  if (!enabled) return { allowed: false, reason: 'pjsk_feature_disabled' };
  const currentText = String(context.cleanText || context.question || context.rawText || '').trim();
  const referenceToken = String(context.routeMeta?.pjskReferenceToken || '').trim();
  const decision = classifyPjskIntent(currentText, { referenceToken });
  if (!decision.matched || decision.tool !== toolName) return { allowed: false, reason: 'pjsk_route_mismatch', decision };

  if (toolName !== 'pjsk_chart_analyze') return { allowed: true, reason: 'allowed', decision };
  if (referenceToken) {
    const reference = pjskReferenceStore.consume(referenceToken, context);
    return reference
      ? { allowed: true, reason: 'allowed', decision, reference }
      : { allowed: false, reason: 'pjsk_reference_invalid', decision };
  }
  const title = String(args.title || '').trim();
  if (!title) return { allowed: false, reason: 'pjsk_title_required', decision };
  const normalizedTitle = normalizeSongTitle(title);
  if (!normalizedTitle || !normalizeSongTitle(currentText).includes(normalizedTitle)) {
    return { allowed: false, reason: 'pjsk_title_not_grounded', decision };
  }
  if (args.difficulty && !isDifficultyGrounded(args.difficulty, currentText)) {
    return { allowed: false, reason: 'pjsk_difficulty_not_grounded', decision };
  }
  return { allowed: true, reason: 'allowed', decision };
}

module.exports = { isDifficultyGrounded, validatePjskToolInvocation };
