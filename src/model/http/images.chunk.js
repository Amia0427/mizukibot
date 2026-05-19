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
      || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
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
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: inlineMediaType || 'image/jpeg',
        data: inlineData
      }
    };
  }

  const imageUrl = String(part?.image_url?.url || part?.url || '').trim();
  if (!imageUrl) return null;
  const cacheRef = parseCacheRef(imageUrl);
  const cachedImage = cacheRef ? readCachedImagePayload(imageUrl) : null;
  if (cachedImage?.data) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: cachedImage.mediaType || 'image/jpeg',
        data: cachedImage.data
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

