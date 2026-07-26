const assert = require('assert');

const config = require('../config');
const { runVisionCaptionWorker } = require('../core/visionCaptionWorker');

module.exports = (async () => {
  const previousEnabled = config.VISION_CAPTION_WORKER_ENABLED;
  const previousBaseUrl = config.VISION_CAPTION_WORKER_API_BASE_URL;
  const previousApiKey = config.VISION_CAPTION_WORKER_API_KEY;
  try {
    config.VISION_CAPTION_WORKER_ENABLED = false;
    config.VISION_CAPTION_WORKER_API_BASE_URL = '';
    config.VISION_CAPTION_WORKER_API_KEY = '';

    const enabledOverride = await runVisionCaptionWorker({
      enabled: true,
      timeoutMs: 4321,
      images: [{ url: 'data:image/jpeg;base64,aW1hZ2U=', source: 'current' }]
    });
    assert.strictEqual(enabledOverride.ok, false);
    assert.strictEqual(enabledOverride.fallbackReason, 'missing_config');
    assert.strictEqual(enabledOverride.modelConfig.timeoutMs, 4321);

    config.VISION_CAPTION_WORKER_ENABLED = true;
    const disabledOverride = await runVisionCaptionWorker({
      enabled: false,
      images: [{ url: 'data:image/jpeg;base64,aW1hZ2U=', source: 'current' }]
    });
    assert.strictEqual(disabledOverride.fallbackReason, 'disabled');
  } finally {
    config.VISION_CAPTION_WORKER_ENABLED = previousEnabled;
    config.VISION_CAPTION_WORKER_API_BASE_URL = previousBaseUrl;
    config.VISION_CAPTION_WORKER_API_KEY = previousApiKey;
  }

  console.log('sharedLinkVisionOverride.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
