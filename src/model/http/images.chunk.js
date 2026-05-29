const {
  OPENAI_IMAGE_DETAIL_VALUES,
  applyAnthropicCacheControl,
  assertSafeHttpUrl,
  axios,
  config,
  extractAnthropicCacheControl,
  normalizeText,
  parseCacheRef,
  readCachedImagePayload,
  stripCacheControlFields
} = require('./runtime-core.chunk');

const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_ANTHROPIC_INLINE_IMAGE_MAX_BASE64_CHARS = 120000;
const DEFAULT_ANTHROPIC_DOWNSAMPLED_IMAGE_MAX_EDGE = 768;
const ANTHROPIC_DOWNSAMPLE_JPEG_QUALITIES = [82, 74, 66, 58, 50, 42];
let sharpLoaderState = 'unloaded';
let sharpModule = null;

function getHttpTransport() {
  return require('./prepare.chunk');
}

function inferImageMediaType(url = '', headers = {}) {
  const contentType = normalizeText(headers?.['content-type'] || headers?.['Content-Type']).toLowerCase();
  if (contentType.startsWith('image/')) return contentType;

  const lowerUrl = String(url || '').toLowerCase();
  if (lowerUrl.includes('.png')) return 'image/png';
  if (lowerUrl.includes('.webp')) return 'image/webp';
  if (lowerUrl.includes('.gif')) return 'image/gif';
  return 'image/jpeg';
}

function getHttpUserAgent() {
  return String(
    config.HTTP_USER_AGENT
      || config.CODEX_USER_AGENT
  ).trim();
}

function getHttpAcceptLanguage() {
  return String(config.HTTP_ACCEPT_LANGUAGE || 'zh-CN,zh;q=0.9,en;q=0.8').trim();
}

function getImageFetchOptions() {
  return {
    headers: {
      Accept: 'image/*,*/*;q=0.8',
      'Accept-Language': getHttpAcceptLanguage(),
      'User-Agent': getHttpUserAgent()
    },
    timeout: Math.min(getHttpTransport().getRequestTimeoutMs(), 20000),
    proxy: false,
    responseType: 'arraybuffer',
    maxRedirects: 0,
    validateStatus: (status) => status >= 200 && status < 300
  };
}

async function fetchRemoteImage(imageUrl) {
  await assertSafeHttpUrl(imageUrl);
  const resp = await axios.get(imageUrl, getImageFetchOptions());
  const contentType = normalizeText(resp?.headers?.['content-type'] || resp?.headers?.['Content-Type']).toLowerCase();
  if (contentType && !contentType.startsWith('image/')) throw new Error('remote resource is not an image');

  const buffer = Buffer.from(resp.data || Buffer.alloc(0));
  if (buffer.length > MAX_REMOTE_IMAGE_BYTES) throw new Error('remote image is too large');
  if (buffer.length === 0) throw new Error('remote image is empty');
  return { buffer, headers: resp?.headers || {} };
}

function isQqImageUrl(url = '') {
  return /multimedia\.nt\.qq\.com\.cn\//i.test(String(url || '').trim());
}

function normalizeOpenAIImageDetail(value) {
  const normalized = normalizeText(value).toLowerCase();
  return OPENAI_IMAGE_DETAIL_VALUES.has(normalized) ? normalized : '';
}

function sanitizeOpenAICompatibleContentPart(part) {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return part;
  const normalizedCacheControl = extractAnthropicCacheControl(part);
  const nextPart = stripCacheControlFields(part);
  if (!nextPart.image_url || typeof nextPart.image_url !== 'object' || Array.isArray(nextPart.image_url)) {
    return normalizedCacheControl
      ? {
          ...nextPart,
          cache_control: normalizedCacheControl
        }
      : nextPart;
  }

  const imageUrl = { ...nextPart.image_url };
  const detail = normalizeOpenAIImageDetail(imageUrl.detail);
  if (detail) imageUrl.detail = detail;
  else delete imageUrl.detail;

  const sanitized = {
    ...nextPart,
    image_url: imageUrl
  };
  return normalizedCacheControl
    ? {
        ...sanitized,
        cache_control: normalizedCacheControl
      }
    : sanitized;
}

function sanitizeOpenAICompatibleContentPartWithoutCache(part) {
  const sanitized = sanitizeOpenAICompatibleContentPart(part);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) return sanitized;
  return stripCacheControlFields(sanitized);
}

function sanitizeOpenAICompatibleMessageWithoutCache(message = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
  const nextMessage = stripCacheControlFields(message);
  if (Array.isArray(nextMessage.content)) {
    return {
      ...nextMessage,
      content: nextMessage.content.map((part) => sanitizeOpenAICompatibleContentPartWithoutCache(part))
    };
  }
  if (nextMessage.content && typeof nextMessage.content === 'object' && !Array.isArray(nextMessage.content)) {
    return {
      ...nextMessage,
      content: sanitizeOpenAICompatibleContentPartWithoutCache(nextMessage.content)
    };
  }
  return nextMessage;
}

function sanitizeOpenAICompatibleToolWithoutCache(tool = {}) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return tool;
  const nextTool = stripCacheControlFields(tool);
  if (nextTool.function && typeof nextTool.function === 'object' && !Array.isArray(nextTool.function)) {
    return {
      ...nextTool,
      function: stripCacheControlFields(nextTool.function)
    };
  }
  return nextTool;
}

function buildUnavailableImageText(imageUrl = '') {
  if (parseCacheRef(imageUrl)) {
    return '[Image unavailable: cached image payload missing.]';
  }
  return isQqImageUrl(imageUrl)
    ? '[Image unavailable: QQ image link expired or requires access.]'
    : `[Image URL] ${imageUrl}`;
}

function getAnthropicInlineImageMaxBase64Chars() {
  const raw = normalizeText(
    process.env.ANTHROPIC_INLINE_IMAGE_MAX_BASE64_CHARS
    || config.ANTHROPIC_INLINE_IMAGE_MAX_BASE64_CHARS
    || ''
  );
  if (!raw) return DEFAULT_ANTHROPIC_INLINE_IMAGE_MAX_BASE64_CHARS;
  const parsed = Math.floor(Number(raw));
  if (!Number.isFinite(parsed)) return DEFAULT_ANTHROPIC_INLINE_IMAGE_MAX_BASE64_CHARS;
  return Math.max(0, parsed);
}

function shouldInlineAnthropicBase64Image(base64Data = '') {
  const data = String(base64Data || '').trim();
  if (!data) return false;
  const maxChars = getAnthropicInlineImageMaxBase64Chars();
  return maxChars > 0 && data.length <= maxChars;
}

function getAnthropicDownsampledImageMaxEdge() {
  const raw = normalizeText(
    process.env.ANTHROPIC_DOWNSAMPLED_IMAGE_MAX_EDGE
    || config.ANTHROPIC_DOWNSAMPLED_IMAGE_MAX_EDGE
    || ''
  );
  if (!raw) return DEFAULT_ANTHROPIC_DOWNSAMPLED_IMAGE_MAX_EDGE;
  const parsed = Math.floor(Number(raw));
  if (!Number.isFinite(parsed)) return DEFAULT_ANTHROPIC_DOWNSAMPLED_IMAGE_MAX_EDGE;
  return Math.max(96, parsed);
}

function loadSharpForAnthropicDownsample() {
  if (sharpLoaderState !== 'unloaded') return sharpModule;
  sharpLoaderState = 'loaded';
  try {
    sharpModule = require('sharp');
  } catch (error) {
    sharpModule = null;
    if (config.ENABLE_DEBUG_LOG) {
      console.warn('[vision] sharp is unavailable for oversized anthropic image downsample: ' + (error?.message || error));
    }
  }
  return sharpModule;
}

function buildAnthropicImageBlockFromBase64(mediaType = 'image/jpeg', data = '') {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType || 'image/jpeg',
      data
    }
  };
}

function buildAnthropicDownsampleEdges() {
  const configured = getAnthropicDownsampledImageMaxEdge();
  const candidates = [configured, 768, 640, 512, 448, 384, 320, 256, 192]
    .map((value) => Math.floor(Number(value)))
    .filter((value) => Number.isFinite(value) && value >= 96 && value <= configured);
  return [...new Set(candidates)].sort((a, b) => b - a);
}

function hasKnownImageSignature(buffer, mediaType = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  const normalizedMediaType = normalizeText(mediaType).toLowerCase();
  const startsWithHex = (hex) => buffer.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));
  if (normalizedMediaType === 'image/png') return startsWithHex('89504e470d0a1a0a');
  if (normalizedMediaType === 'image/jpeg' || normalizedMediaType === 'image/jpg') return startsWithHex('ffd8ff');
  if (normalizedMediaType === 'image/webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (normalizedMediaType === 'image/gif') {
    const signature = buffer.subarray(0, 6).toString('ascii');
    return signature === 'GIF87a' || signature === 'GIF89a';
  }
  return startsWithHex('89504e470d0a1a0a')
    || startsWithHex('ffd8ff')
    || (
      buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    )
    || ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'));
}

async function buildDownsampledAnthropicImageBlock(imagePayload = {}) {
  const maxChars = getAnthropicInlineImageMaxBase64Chars();
  if (maxChars <= 0) return null;

  const sharp = loadSharpForAnthropicDownsample();
  if (!sharp) return null;

  const data = String(imagePayload?.data || '').trim();
  if (!data) return null;

  let inputBuffer = null;
  try {
    inputBuffer = Buffer.from(data, 'base64');
  } catch (_) {
    return null;
  }
  if (!inputBuffer || !inputBuffer.length) return null;
  if (!hasKnownImageSignature(inputBuffer, imagePayload?.mediaType)) return null;

  for (const edge of buildAnthropicDownsampleEdges()) {
    for (const quality of ANTHROPIC_DOWNSAMPLE_JPEG_QUALITIES) {
      try {
        const outputBuffer = await sharp(inputBuffer, {
          animated: false,
          limitInputPixels: 25000000
        })
          .rotate()
          .resize({
            width: edge,
            height: edge,
            fit: 'inside',
            withoutEnlargement: true
          })
          .flatten({ background: { r: 255, g: 255, b: 255 } })
          .jpeg({ quality, mozjpeg: true })
          .toBuffer();
        const outputBase64 = outputBuffer.toString('base64');
        if (shouldInlineAnthropicBase64Image(outputBase64)) {
          return buildAnthropicImageBlockFromBase64('image/jpeg', outputBase64);
        }
      } catch (error) {
        if (config.ENABLE_DEBUG_LOG) {
          console.warn('[vision] failed oversized anthropic image downsample: ' + (error?.message || error));
        }
        return null;
      }
    }
  }

  return null;
}

function buildOversizeAnthropicImageText(imageUrl = '') {
  if (parseCacheRef(imageUrl)) {
    return '[Image attached but skipped because the cached image payload is too large to inline safely.]';
  }
  return '[Image attached but skipped because the inline image payload is too large.]';
}

async function buildOversizeAnthropicImageFallbackBlock(imageUrl = '') {
  const url = String(imageUrl || '').trim();
  if (/^https?:\/\//i.test(url) && !isQqImageUrl(url)) {
    try {
      await assertSafeHttpUrl(url);
      return {
        type: 'image',
        source: {
          type: 'url',
          url
        }
      };
    } catch (error) {
      const details = error?.message || 'unknown-error';
      console.warn('[vision] skipped oversized inline image and source url was not safe: ' + details);
    }
  }

  return {
    type: 'text',
    text: buildOversizeAnthropicImageText(imageUrl)
  };
}

function getOpenAICompatibleImageMode() {
  const raw = normalizeText(process.env.OPENAI_COMPAT_IMAGE_INPUT_MODE || '').toLowerCase();
  if (!raw) return 'data_url';
  if (['data_url', 'data-url', 'dataurl', 'inline'].includes(raw)) return 'data_url';
  if (['text_fallback', 'text-fallback', 'text', 'fallback', 'disabled', 'off'].includes(raw)) return 'text_fallback';
  return 'data_url';
}

function buildOpenAICompatibleImageFallbackText(imageUrl = '') {
  if (parseCacheRef(imageUrl)) {
    return '[Image attached but current model endpoint does not support inline cached image payloads. Please use a vision-capable provider or enable compatible image transport.]';
  }
  if (isQqImageUrl(imageUrl)) {
    return '[Image attached but current model endpoint does not support this image transport, and the QQ image link may be ephemeral.]';
  }
  return '[Image attached but current model endpoint does not support inline image transport.]';
}

async function resolveOpenAICompatibleImagePart(part = {}) {
  const normalizedPart = sanitizeOpenAICompatibleContentPart(part);
  const inlineData = String(
    normalizedPart?.data
    || normalizedPart?.image?.data
    || normalizedPart?.source?.data
    || ''
  ).trim();
  const inlineMediaType = normalizeText(
    normalizedPart?.media_type
    || normalizedPart?.mime
    || normalizedPart?.image?.media_type
    || normalizedPart?.source?.media_type
  ).toLowerCase();
  const sourceType = normalizeText(normalizedPart?.source?.type || '');
  const imageDetail = normalizeOpenAIImageDetail(normalizedPart?.image_url?.detail);

  if (inlineData && (sourceType === 'base64' || normalizedPart?.type === 'input_image' || normalizedPart?.type === 'image')) {
    if (getOpenAICompatibleImageMode() !== 'data_url') {
      return {
        type: 'text',
        text: buildOpenAICompatibleImageFallbackText(String(normalizedPart?.image_url?.url || normalizedPart?.url || ''))
      };
    }
    return {
      type: 'image_url',
      image_url: {
        url: `data:${inlineMediaType || 'image/jpeg'};base64,${inlineData}`,
        ...(imageDetail ? { detail: imageDetail } : {})
      }
    };
  }

  const imageUrl = String(normalizedPart?.image_url?.url || normalizedPart?.url || '').trim();
  if (!imageUrl) return null;
  const cacheRef = parseCacheRef(imageUrl);
  const cachedImage = cacheRef ? readCachedImagePayload(imageUrl) : null;
  if (cachedImage?.data) {
    if (getOpenAICompatibleImageMode() !== 'data_url') {
      return {
        type: 'text',
        text: buildOpenAICompatibleImageFallbackText(imageUrl)
      };
    }
    return {
      type: 'image_url',
      image_url: {
        url: `data:${cachedImage.mediaType || 'image/jpeg'};base64,${cachedImage.data}`,
        ...(imageDetail ? { detail: imageDetail } : {})
      }
    };
  }
  if (cacheRef) {
    return {
      type: 'text',
      text: buildUnavailableImageText(imageUrl)
    };
  }

  try {
    const resp = await axios.get(imageUrl, {
      ...getHttpTransport().getAxiosOptions(
        'openai_compatible',
        null,
        Math.min(getHttpTransport().getRequestTimeoutMs(), 20000)
      ),
      responseType: 'arraybuffer'
    });
    const mediaType = inferImageMediaType(imageUrl, resp?.headers || {});
    const data = Buffer.from(resp.data).toString('base64');
    if (!data) return null;
    if (getOpenAICompatibleImageMode() !== 'data_url') {
      return {
        type: 'text',
        text: buildOpenAICompatibleImageFallbackText(imageUrl)
      };
    }
    return {
      type: 'image_url',
      image_url: {
        url: `data:${mediaType};base64,${data}`,
        ...(imageDetail ? { detail: imageDetail } : {})
      }
    };
  } catch (error) {
    const details = error?.response?.status ? ('status=' + error.response.status) : (error?.message || 'unknown-error');
    console.warn('[vision] failed to fetch image url for openai-compatible block: ' + details);
    return {
      type: 'text',
      text: buildUnavailableImageText(imageUrl)
    };
  }
}

async function resolveAnthropicImageBlock(part = {}) {
  const inlineData = String(
    part?.data
    || part?.image?.data
    || part?.source?.data
    || ''
  ).trim();
  const inlineMediaType = normalizeText(
    part?.media_type
    || part?.mime
    || part?.image?.media_type
    || part?.source?.media_type
  ).toLowerCase();
  const sourceType = normalizeText(part?.source?.type || '');
  if (inlineData && (sourceType === 'base64' || part?.type === 'input_image' || part?.type === 'image')) {
    if (!shouldInlineAnthropicBase64Image(inlineData)) {
      const downsampledBlock = await buildDownsampledAnthropicImageBlock({
        mediaType: inlineMediaType || 'image/jpeg',
        data: inlineData
      });
      if (downsampledBlock) return downsampledBlock;
      return buildOversizeAnthropicImageFallbackBlock(String(part?.image_url?.url || part?.url || '').trim());
    }
    return buildAnthropicImageBlockFromBase64(inlineMediaType || 'image/jpeg', inlineData);
  }

  const imageUrl = String(part?.image_url?.url || part?.url || '').trim();
  if (!imageUrl) return null;
  const cacheRef = parseCacheRef(imageUrl);
  const cachedImage = cacheRef ? readCachedImagePayload(imageUrl) : null;
  if (cachedImage?.data) {
    if (!shouldInlineAnthropicBase64Image(cachedImage.data)) {
      const downsampledBlock = await buildDownsampledAnthropicImageBlock(cachedImage);
      if (downsampledBlock) return downsampledBlock;
      return buildOversizeAnthropicImageFallbackBlock(cachedImage.sourceUrl || imageUrl);
    }
    return buildAnthropicImageBlockFromBase64(cachedImage.mediaType || 'image/jpeg', cachedImage.data);
  }
  if (cacheRef) {
    return {
      type: 'text',
      text: buildUnavailableImageText(imageUrl)
    };
  }

  try {
    await assertSafeHttpUrl(imageUrl);
    return {
      type: 'image',
      source: {
        type: 'url',
        url: imageUrl
      }
    };
  } catch (error) {
    const details = error?.response?.status ? ('status=' + error.response.status) : (error?.message || 'unknown-error');
    console.warn('[vision] failed to fetch image url for anthropic block: ' + details);
    return {
      type: 'text',
      text: buildUnavailableImageText(imageUrl)
    };
  }
}

async function toAnthropicContentBlocks(content) {
  if (typeof content === 'string') {
    return [{ type: 'text', text: String(content) }];
  }

  if (Array.isArray(content)) {
    const blocks = [];
    for (const part of content) {
      if (typeof part === 'string') {
        blocks.push({ type: 'text', text: part });
        continue;
      }

      const partType = String(part?.type || '').toLowerCase();
      if (partType === 'text') {
        const text = String(part?.text || '');
        if (text) {
          blocks.push(applyAnthropicCacheControl(
            { type: 'text', text },
            extractAnthropicCacheControl(part)
          ));
        }
        continue;
      }

      if (partType === 'image_url') {
        const imageBlock = await resolveAnthropicImageBlock(part);
        if (imageBlock) blocks.push(applyAnthropicCacheControl(imageBlock, extractAnthropicCacheControl(part)));
        continue;
      }

      if (partType === 'input_image' || partType === 'image') {
        const imageBlock = await resolveAnthropicImageBlock(part);
        if (imageBlock) blocks.push(applyAnthropicCacheControl(imageBlock, extractAnthropicCacheControl(part)));
        continue;
      }

      if (typeof part?.text === 'string') {
        blocks.push(applyAnthropicCacheControl(
          { type: 'text', text: part.text },
          extractAnthropicCacheControl(part)
        ));
      }
    }
    return blocks;
  }

  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return [applyAnthropicCacheControl(
      { type: 'text', text: content.text },
      extractAnthropicCacheControl(content)
    )];
  }

  const fallback = String(content || '');
  return fallback ? [{ type: 'text', text: fallback }] : [];
}

module.exports = {
  buildOpenAICompatibleImageFallbackText,
  buildUnavailableImageText,
  fetchRemoteImage,
  getHttpAcceptLanguage,
  getHttpUserAgent,
  getImageFetchOptions,
  getAnthropicDownsampledImageMaxEdge,
  getAnthropicInlineImageMaxBase64Chars,
  getOpenAICompatibleImageMode,
  inferImageMediaType,
  isQqImageUrl,
  normalizeOpenAIImageDetail,
  resolveAnthropicImageBlock,
  resolveOpenAICompatibleImagePart,
  sanitizeOpenAICompatibleContentPart,
  sanitizeOpenAICompatibleContentPartWithoutCache,
  sanitizeOpenAICompatibleMessageWithoutCache,
  sanitizeOpenAICompatibleToolWithoutCache,
  toAnthropicContentBlocks
};

