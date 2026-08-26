const fs = require('fs/promises');
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

function imageExtensionFromSource(source = '') {
  const match = String(source || '').match(/^data:image\/([^;,]+);base64,/i);
  const mimeSubtype = normalizeText(match?.[1]).toLowerCase();
  if (mimeSubtype === 'jpeg') return 'jpg';
  return mimeSubtype || 'png';
}

function ensureImageName(filename = '', extension = 'png') {
  const text = normalizeText(filename);
  if (!text) return `image-${Date.now()}.${extension}`;
  return /\.(?:png|jpe?g|webp|gif)$/i.test(text) ? text : `${text}.${extension}`;
}

async function persistInlineImage(source = '', outputPath = '') {
  const match = String(source || '').match(/^data:image\/[^;,]+;base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) return false;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, Buffer.from(match[1].replace(/\s+/g, ''), 'base64'));
  return true;
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
    return 'Missing configured image provider API key. Nano Banana Pro skill is unavailable.';
  }

  const outputDir = path.join(dataDir, 'skill_cache', 'nano-banana-pro');
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

  const outputPath = path.join(outputDir, ensureImageName(filename, imageExtensionFromSource(result)));
  await persistInlineImage(result, outputPath);

  return JSON.stringify({
    prompt: normalizedPrompt,
    resolution: normalizeText(resolution) || '1K',
    input_image: normalizeText(input_image),
    output_path: outputPath,
    image_source: result
  }, null, 2);
}

module.exports = {
  generateImage,
  persistInlineImage
};
