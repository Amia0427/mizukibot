const config = require('../../config');

function enqueueImageVisualSummarySafe(imageRef = '', context = {}, deps = {}) {
  if (config.IMAGE_MEMORY_VISUAL_SUMMARY_ENABLED === false && context.force !== true) {
    return { queued: false, reason: 'disabled' };
  }
  try {
    return require('../../utils/imageVisualSummaryMemory').enqueueImageVisualSummary(imageRef, context, deps);
  } catch (error) {
    if (config.ENABLE_DEBUG_LOG) {
      console.warn('[continuous-message] image visual summary enqueue failed:', error?.message || error);
    }
    return { queued: false, reason: error?.message || 'enqueue_failed' };
  }
}

module.exports = {
  enqueueImageVisualSummarySafe
};
