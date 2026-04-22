const path = require('path');
const { drawBotDiaryQzonePicture } = require('../imageGeneration');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function resolveImageApiKey(apiKey = '') {
  return normalizeText(
    apiKey
    || process.env.GEMINI_API_KEY
    || process.env.BOT_DIARY_QZONE_IMAGE_PROVIDER_API_KEY
    || ''
  );
}

function resolveImageApiBaseUrl() {
  return normalizeText(process.env.BOT_DIARY_QZONE_IMAGE_PROVIDER_API_BASE_URL || '');
}

function ensurePngName(filename = '') {
  const text = normalizeText(filename);
  if (!text) return `image-${Date.now()}.png`;
  return /\.png$/i.test(text) ? text : `${text}.png`;
}

async function generateImage({
  prompt = '',
  filename = '',
  resolution = '1K',
  input_image = '',
  api_key = ''
} = {}, dataDir) {
  const normalizedPrompt = normalizeText(prompt);
  if (!normalizedPrompt) return 'Missing prompt.';
  const resolvedApiKey = resolveImageApiKey(api_key);
  if (!resolvedApiKey) {
    return 'Missing GEMINI_API_KEY or BOT_DIARY_QZONE_IMAGE_PROVIDER_API_KEY. Nano Banana Pro skill is unavailable.';
  }

  const outputDir = path.join(dataDir, 'skill_cache', 'nano-banana-pro');
  const outputPath = path.join(outputDir, ensurePngName(filename || `image-${Date.now()}`));
  let result = '';
  try {
    result = await drawBotDiaryQzonePicture(normalizedPrompt, {
      buildProviderConfig() {
        return {
          enabled: true,
          model: process.env.BOT_DIARY_QZONE_IMAGE_PROVIDER_MODEL || 'gemini-3.1-flash-image-preview',
          apiBaseUrl: resolveImageApiBaseUrl(),
          apiKey: resolvedApiKey
        };
      }
    });
  } catch (error) {
    return `Image generation failed: ${normalizeText(error?.message || error) || 'unknown provider error'}`;
  }

  if (!result) {
    return 'Image generation returned no image.';
  }

  return JSON.stringify({
    prompt: normalizedPrompt,
    resolution: normalizeText(resolution) || '1K',
    input_image: normalizeText(input_image),
    output_path: outputPath,
    image_source: result
  }, null, 2);
}

module.exports = {
  generateImage
};
