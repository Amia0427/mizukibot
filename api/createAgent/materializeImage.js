const fs = require('fs');
const path = require('path');
const axios = require('axios');
const {
  detectImageExtension,
  normalizeBase64ImageData,
  validateImageBuffer
} = require('./imageValidation');
const { normalizeRequestError } = require('./requestUtils');
const { buildOutputBasename } = require('./promptBuilder');

const DEFAULT_IMAGE_EXTENSION = '.png';
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

function buildImageOutputPath(runtimeConfig = {}, prompt = '', buffer = Buffer.alloc(0), mimeType = '') {
  const extension = detectImageExtension(buffer, DEFAULT_IMAGE_EXTENSION, mimeType);
  return path.join(runtimeConfig.outputDir, `${buildOutputBasename(prompt)}${extension}`);
}

function writeImageBuffer(runtimeConfig = {}, prompt = '', buffer = Buffer.alloc(0), mimeType = '') {
  validateImageBuffer(buffer, mimeType);
  const outputPath = buildImageOutputPath(runtimeConfig, prompt, buffer, mimeType);
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

async function downloadImageFromUrl(imageUrl = '', prompt = '', runtimeConfig = {}, deps = {}) {
  const rawUrl = String(imageUrl || '').trim();
  if (!rawUrl) {
    throw new Error('generation response missing image data');
  }

  const dataUrlMatch = rawUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
  if (dataUrlMatch) {
    const buffer = Buffer.from(normalizeBase64ImageData(dataUrlMatch[2] || ''), 'base64');
    const filePath = writeImageBuffer(runtimeConfig, prompt, buffer, dataUrlMatch[1]);
    return { filePath, buffer };
  }

  const httpClient = deps.httpClient || axios;
  try {
    const response = await httpClient.get(rawUrl, {
      responseType: 'arraybuffer',
      timeout: runtimeConfig.timeoutMs,
      maxContentLength: MAX_IMAGE_BYTES,
      maxBodyLength: MAX_IMAGE_BYTES,
      proxy: false
    });
    const buffer = Buffer.from(response?.data || []);
    const filePath = writeImageBuffer(
      runtimeConfig,
      prompt,
      buffer,
      String(response?.headers?.['content-type'] || '').trim()
    );
    return { filePath, buffer };
  } catch (error) {
    throw new Error(normalizeRequestError(error));
  }
}

async function materializeGeneratedImage(imageResult = null, prompt = '', runtimeConfig = {}, deps = {}) {
  if (!imageResult || typeof imageResult !== 'object') {
    throw new Error('generation response missing image data');
  }

  if (imageResult.kind === 'b64_json') {
    const buffer = Buffer.from(normalizeBase64ImageData(imageResult.value || ''), 'base64');
    const filePath = writeImageBuffer(runtimeConfig, prompt, buffer);
    return { filePath, buffer };
  }

  if (imageResult.kind === 'url') {
    return downloadImageFromUrl(imageResult.value, prompt, runtimeConfig, deps);
  }

  throw new Error('generation response missing image data');
}

module.exports = {
  DEFAULT_IMAGE_EXTENSION,
  MAX_IMAGE_BYTES,
  buildImageOutputPath,
  writeImageBuffer,
  downloadImageFromUrl,
  materializeGeneratedImage
};
