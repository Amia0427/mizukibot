const {
  createReplyVisualRuntime,
  getReplyVisualIneligibilityReason,
  isReplyVisualEligible
} = require('./runtime');
const {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MIN_CONFIDENCE,
  createEmotionGate,
  evaluateEmotionGate,
  normalizeEmotionAnalysis,
  resolveEmotionCooldownKey
} = require('./emotionGate');
const {
  SUPPORTED_EMOTIONS,
  createLive2dCatalog,
  readEmotionManifest,
  resolveConfiguredPath
} = require('./catalog');

module.exports = {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MIN_CONFIDENCE,
  SUPPORTED_EMOTIONS,
  createEmotionGate,
  createLive2dCatalog,
  createReplyVisualRuntime,
  evaluateEmotionGate,
  getReplyVisualIneligibilityReason,
  isReplyVisualEligible,
  normalizeEmotionAnalysis,
  readEmotionManifest,
  resolveConfiguredPath,
  resolveEmotionCooldownKey
};
