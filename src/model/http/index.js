const axios = require('axios');
const config = require('../../../config');
const {
  getApiProvider,
  ensureAnthropicMessagesUrl,
  isOpenAICompatibleProvider,
  isAnthropicProvider,
  isGeminiNativeProvider,
  normalizeProviderRequestHeaders
} = require('../../../utils/modelProvider');
const { parseCacheRef, readCachedImagePayload } = require('../../../utils/imageInputCache');
const { HUMANIZER_SYSTEM_PROMPT } = require('../../../utils/humanizer');
const { assertSafeHttpUrl, assertSafeModelEndpoint } = require('../../../utils/networkSafety');
const {
  startModelCall,
  finishModelCall,
  failModelCall
} = require('../../../utils/modelCallTracker');
const {
  appendRequestTraceEvent,
  extractErrorCode,
  extractHttpStatus,
  nextTracePhase
} = require('../../../utils/requestTrace');
const {
  buildModelRouteDiagnostics,
  createModelRouteTracePatch
} = require('../../../utils/modelRouteDiagnostics');
const { extractSSEEvents, flushSSEState, mergeUsageObjects } = require('../../../api/parser');
const {
  applyAnthropicCacheControl,
  applyAnthropicCacheControlToLastBlock,
  blockHasAnthropicCacheControl,
  extractAnthropicCacheControl,
  isAnthropicPromptCacheEnabled,
  mergeAnthropicBetaHeader,
  normalizeAnthropicCacheControl,
  providerAllowsCacheControl,
  providerAllowsOpenAIPromptCache,
  serializeAnthropicToolResultContent,
  stripAnthropicCacheControlFromBlocks,
  stripCacheControlFields,
  stripCacheControlFieldsDeep,
  stripOpenAIPromptCacheFields,
  stripOpenAIPromptCacheRetention,
  toolHasAnthropicCacheControl
} = require('./cache-control');

let HttpsProxyAgentCtor = null;
try {
  const mod = require('https-proxy-agent');
  HttpsProxyAgentCtor = mod.HttpsProxyAgent || mod;
} catch (_) {}

function normalizeText(value) {
  return String(value || '').trim();
}

function isTopPEnabled() {
  const raw = normalizeText(config.MODEL_TOP_P_ENABLED || process.env.MODEL_TOP_P_ENABLED).toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function stripTopPField(requestBody = {}) {
  if (isTopPEnabled()) return requestBody;
  if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) return requestBody;
  const nextBody = { ...requestBody };
  delete nextBody.top_p;
  return nextBody;
}

const OPENAI_IMAGE_DETAIL_VALUES = new Set(['auto', 'low', 'high']);

function normalizeJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};

  try {
    const parsed = JSON.parse(value);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function anthropicSystemUsesArray(system) {
  return Array.isArray(system);
}

const ANTHROPIC_ASSISTANT_CONTEXT_PREFIX = '[Context for assistant only]';
const ANTHROPIC_DYNAMIC_SYSTEM_MARKERS = [
  '[Affinity]',
  '[AffinityPoints]',
  '[DailyMemory]',
  '[LongTermProfile]',
  '[Impression]',
  '[Relationship]',
  '[Attitude]',
  '[ReplyStylePolicy]',
  '[RelationshipGuard]',
  '[Summary]',
  '[MemoryCLI]',
  '[ShortTermSummary]',
  '[ContinuityState]',
  '[ContinuityProbePolicy]',
  '[GlobalToolEvidence]',
  '[CurrentConversation]',
  '[StyleProfile]',
  '[SocialContext]',
  '[SelfImprovement]'
];
const ANTHROPIC_STABLE_SYSTEM_TEXTS = new Set(
  [
    String(config.SYSTEM_PROMPT || '').trim(),
    String(HUMANIZER_SYSTEM_PROMPT || '').trim(),
    String(require('../../../utils/promptSecurity').buildSecuritySystemPrompt?.() || '').trim(),
    String(require('../../../utils/personaModules').loadPersonaModuleText?.('core_baseline') || '').trim()
  ].filter(Boolean)
);

function normalizeAnthropicSystemBlocks(system) {
  if (Array.isArray(system)) return system.filter((block) => block && typeof block === 'object');
  if (typeof system === 'string' && system.trim()) return [{ type: 'text', text: system }];
  return [];
}

function splitAnthropicStableSystemText(text = '') {
  const raw = String(text || '');
  const stablePrefix = String(config.SYSTEM_PROMPT || '').trim();
  if (!stablePrefix || !raw.startsWith(stablePrefix)) return null;

  const remainder = raw.slice(stablePrefix.length).trim();
  if (!remainder) return null;
  if (!ANTHROPIC_DYNAMIC_SYSTEM_MARKERS.some((marker) => remainder.includes(marker))) return null;

  return {
    stableText: stablePrefix,
    dynamicText: remainder
  };
}

function isAnthropicDynamicSystemContextText(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return false;
  return ANTHROPIC_DYNAMIC_SYSTEM_MARKERS.some((marker) => raw.startsWith(marker));
}

function isAnthropicAssistantOnlyContextText(text = '') {
  return String(text || '').trim().startsWith(ANTHROPIC_ASSISTANT_CONTEXT_PREFIX);
}

function isAnthropicStableSystemText(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return false;
  return ANTHROPIC_STABLE_SYSTEM_TEXTS.has(raw);
}

function applyAnthropicCacheControlToBlockIndex(blocks, targetIndex, cacheControl) {
  const normalized = normalizeAnthropicCacheControl(cacheControl);
  const items = Array.isArray(blocks) ? blocks : [];
  if (!normalized || items.length === 0) return items;
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= items.length) return items;

  return items.map((block, index) => (
    index === targetIndex
      ? applyAnthropicCacheControl(block, normalized)
      : block
  ));
}

function extractAnthropicMessageText(message = {}) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (typeof block?.text === 'string') return block.text;
      return '';
    })
    .join('\n')
    .trim();
}

function extractInputMessageText(message = {}) {
  const content = message?.content;
  if (typeof content === 'string') return String(content || '').trim();
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (typeof block?.text === 'string') return block.text;
        return '';
      })
      .join('\n')
      .trim();
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return String(content.text || '').trim();
  }
  return '';
}

function isAnthropicAssistantOnlyContextMessage(message = {}) {
  const role = normalizeText(message?.role).toLowerCase();
  if (role !== 'assistant') return false;
  return extractAnthropicMessageText(message).startsWith(ANTHROPIC_ASSISTANT_CONTEXT_PREFIX);
}

function coerceTrailingAnthropicAssistantContextToUser(messages = []) {
  const items = Array.isArray(messages) ? messages : [];
  if (items.length === 0) return items;

  const lastIndex = items.length - 1;
  const lastMessage = items[lastIndex];
  if (!isAnthropicAssistantOnlyContextMessage(lastMessage)) return items;

  return items.map((message, index) => {
    if (index !== lastIndex) return message;
    return {
      ...message,
      role: 'user'
    };
  });
}

function messageHasAnthropicContent(message = {}) {
  const content = Array.isArray(message?.content) ? message.content : [];
  if (content.length === 0) return false;

  return content.some((block) => {
    if (typeof block === 'string') return Boolean(block.trim());
    if (!block || typeof block !== 'object') return false;
    if (typeof block.text === 'string') return Boolean(block.text.trim());
    return true;
  });
}

function findAnthropicAutoCacheSystemBlockIndex(systemBlocks = []) {
  const items = Array.isArray(systemBlocks) ? systemBlocks : [];
  if (items.length === 0) return -1;

  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (isAnthropicStableSystemText(items[index]?.text)) return index;
  }

  return items.length - 1;
}

function messageContentHasAnthropicCacheControl(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.some((block) => blockHasAnthropicCacheControl(block));
}

function extractAnthropicMessageCacheControl(message = {}) {
  const topLevel = extractAnthropicCacheControl(message);
  if (topLevel) return topLevel;

  const content = message?.content;
  if (Array.isArray(content)) {
    if (content.length !== 1) return null;
    return extractAnthropicCacheControl(content[0]);
  }

  if (content && typeof content === 'object') {
    return extractAnthropicCacheControl(content);
  }

  return null;
}

function anthropicRequestUsesPromptCaching(requestBody = {}) {
  if ((Array.isArray(requestBody.tools) ? requestBody.tools : []).some((tool) => toolHasAnthropicCacheControl(tool))) {
    return true;
  }

  if (normalizeAnthropicSystemBlocks(requestBody.system).some((block) => blockHasAnthropicCacheControl(block))) {
    return true;
  }

  return (Array.isArray(requestBody.messages) ? requestBody.messages : [])
    .some((message) => messageContentHasAnthropicCacheControl(message));
}

function findAnthropicAutoCacheMessageIndex(messages = []) {
  const items = Array.isArray(messages) ? messages : [];
  const nonEmptyIndexes = items
    .map((message, index) => (messageHasAnthropicContent(message) ? index : -1))
    .filter((index) => index >= 0);
  if (nonEmptyIndexes.length === 0) return -1;

  const lastNonEmptyIndex = nonEmptyIndexes[nonEmptyIndexes.length - 1];
  const lastMessage = items[lastNonEmptyIndex] || {};
  const historicalIndexes = (
    normalizeText(lastMessage.role).toLowerCase() === 'user' && nonEmptyIndexes.length > 1
      ? nonEmptyIndexes.slice(0, -1)
      : nonEmptyIndexes
  );

  for (let index = historicalIndexes.length - 1; index >= 0; index -= 1) {
    const candidateIndex = historicalIndexes[index];
    if (isAnthropicAssistantOnlyContextMessage(items[candidateIndex])) continue;
    return candidateIndex;
  }

  return -1;
}

function applyAutoAnthropicPromptCaching(requestBody = {}) {
  if (!isAnthropicPromptCacheEnabled()) return requestBody;

  const defaultCacheControl = normalizeAnthropicCacheControl(true);
  let mutated = false;

  const nextBody = {
    ...requestBody
  };

  const tools = Array.isArray(nextBody.tools) ? nextBody.tools : null;
  if (tools && tools.length > 0 && !tools.some((tool) => toolHasAnthropicCacheControl(tool))) {
    nextBody.tools = tools.map((tool, index) => (
      index === tools.length - 1
        ? applyAnthropicCacheControl(tool, defaultCacheControl)
        : tool
    ));
    mutated = true;
  }

  const systemBlocks = normalizeAnthropicSystemBlocks(nextBody.system);
  let hasSystemCacheControl = systemBlocks.some((block) => blockHasAnthropicCacheControl(block));
  if (systemBlocks.length > 0 && !systemBlocks.some((block) => blockHasAnthropicCacheControl(block))) {
    nextBody.system = applyAnthropicCacheControlToBlockIndex(
      systemBlocks,
      findAnthropicAutoCacheSystemBlockIndex(systemBlocks),
      defaultCacheControl
    );
    hasSystemCacheControl = true;
    mutated = true;
  } else if (anthropicSystemUsesArray(nextBody.system)) {
    nextBody.system = systemBlocks;
  }

  const messages = Array.isArray(nextBody.messages) ? nextBody.messages : [];
  if (!hasSystemCacheControl && !messages.some((message) => messageContentHasAnthropicCacheControl(message))) {
    const messageIndex = findAnthropicAutoCacheMessageIndex(messages);
    if (messageIndex >= 0) {
      nextBody.messages = messages.map((message, index) => (
        index === messageIndex
          ? {
              ...message,
              content: applyAnthropicCacheControlToLastBlock(message.content, defaultCacheControl)
            }
          : message
      ));
      mutated = true;
    }
  }

  return mutated ? nextBody : requestBody;
}

function buildAnthropicRequestHeaders(requestBody = {}) {
  if (!anthropicRequestUsesPromptCaching(requestBody)) return null;

  return {
    'anthropic-beta': mergeAnthropicBetaHeader(
      config.ANTHROPIC_BETA,
      ['prompt-caching-2024-07-31']
    )
  };
}

function stripPromptCachingBetaHeaderValue(headerValue = '') {
  return String(headerValue || '')
    .split(',')
    .map((part) => normalizeText(part))
    .filter((part) => part && part.toLowerCase() !== 'prompt-caching-2024-07-31')
    .join(',');
}

function stripAnthropicPromptCaching(requestBody = {}, requestHeaders = null) {
  if (!requestBody || typeof requestBody !== 'object') {
    return {
      requestBody,
      requestHeaders: requestHeaders && typeof requestHeaders === 'object' ? { ...requestHeaders } : requestHeaders
    };
  }

  const nextBody = stripCacheControlFields({ ...requestBody });
  if (Array.isArray(nextBody.system)) {
    nextBody.system = stripAnthropicCacheControlFromBlocks(nextBody.system);
  } else if (nextBody.system && typeof nextBody.system === 'object') {
    nextBody.system = stripCacheControlFields(nextBody.system);
  }
  if (Array.isArray(nextBody.messages)) {
    nextBody.messages = nextBody.messages.map((message) => {
      if (!message || typeof message !== 'object') return message;
      const nextMessage = stripCacheControlFields(message);
      if (Array.isArray(nextMessage.content)) {
        return {
          ...nextMessage,
          content: stripAnthropicCacheControlFromBlocks(nextMessage.content)
        };
      }
      return nextMessage;
    });
  }
  if (Array.isArray(nextBody.tools)) {
    nextBody.tools = nextBody.tools.map((tool) => {
      if (!tool || typeof tool !== 'object') return tool;
      const nextTool = stripCacheControlFields(tool);
      if (nextTool.function && typeof nextTool.function === 'object' && !Array.isArray(nextTool.function)) {
        return {
          ...nextTool,
          function: stripCacheControlFields(nextTool.function)
        };
      }
      return nextTool;
    });
  }

  const nextHeaders = requestHeaders && typeof requestHeaders === 'object'
    ? { ...requestHeaders }
    : {};
  const headerKey = Object.prototype.hasOwnProperty.call(nextHeaders, 'anthropic-beta')
    ? 'anthropic-beta'
    : (Object.prototype.hasOwnProperty.call(nextHeaders, 'Anthropic-Beta') ? 'Anthropic-Beta' : '');
  if (headerKey) {
    const strippedHeader = stripPromptCachingBetaHeaderValue(nextHeaders[headerKey]);
    if (strippedHeader) nextHeaders[headerKey] = strippedHeader;
    else delete nextHeaders[headerKey];
  }

  return {
    requestBody: nextBody,
    requestHeaders: Object.keys(nextHeaders).length > 0 ? nextHeaders : null
  };
}

function clampTemperatureForProvider(provider, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (provider === 'anthropic') return Math.max(0, Math.min(1, n));
  return Math.max(0, Math.min(2, n));
}

const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;

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
    timeout: Math.min(getRequestTimeoutMs(), 20000),
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
      ...getAxiosOptions('openai_compatible', null, Math.min(getRequestTimeoutMs(), 20000)),
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
    const resp = await fetchRemoteImage(imageUrl);
    const mediaType = inferImageMediaType(imageUrl, resp.headers);
    const data = resp.buffer.toString('base64');
    if (!data) return null;
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType,
        data
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

async function preprocessOpenAICompatibleMessages(messages = []) {
  const normalizedMessages = Array.isArray(messages) ? messages : [];
  const out = [];

  for (const message of normalizedMessages) {
    if (!message || typeof message !== 'object') {
      out.push(message);
      continue;
    }

    if (message.content && typeof message.content === 'object' && !Array.isArray(message.content)) {
      out.push({
        ...message,
        content: sanitizeOpenAICompatibleContentPart(message.content)
      });
      continue;
    }

    const content = Array.isArray(message.content) ? message.content : null;
    if (!content) {
      out.push(message);
      continue;
    }

    const nextContent = [];
    for (const part of content) {
      const sanitizedPart = sanitizeOpenAICompatibleContentPart(part);
      const partType = String(sanitizedPart?.type || '').toLowerCase();
      if (partType === 'image_url' || partType === 'input_image' || partType === 'image') {
        const resolvedPart = await resolveOpenAICompatibleImagePart(sanitizedPart);
        if (resolvedPart) nextContent.push(resolvedPart);
        continue;
      }
      nextContent.push(sanitizedPart);
    }

    out.push({
      ...message,
      content: nextContent
    });
  }

  return out;
}

async function preprocessOpenAICompatibleMessagesWithoutCache(messages = []) {
  const normalizedMessages = Array.isArray(messages) ? messages : [];
  const out = [];

  for (const message of normalizedMessages) {
    if (!message || typeof message !== 'object') {
      out.push(message);
      continue;
    }

    const strippedMessage = sanitizeOpenAICompatibleMessageWithoutCache(message);
    const content = Array.isArray(strippedMessage?.content) ? strippedMessage.content : null;
    if (!content) {
      out.push(strippedMessage);
      continue;
    }

    const nextContent = [];
    for (const part of content) {
      const partType = String(part?.type || '').toLowerCase();
      if (partType === 'image_url' || partType === 'input_image' || partType === 'image') {
        const resolvedPart = await resolveOpenAICompatibleImagePart(part);
        if (resolvedPart) nextContent.push(stripCacheControlFields(resolvedPart));
        continue;
      }
      nextContent.push(part);
    }

    out.push({
      ...strippedMessage,
      content: nextContent
    });
  }

  return out;
}

function requestUsesOpenAICompatiblePromptCaching(requestBody = {}) {
  const topLevel = Boolean(
    requestBody?.prompt_cache_key
    || requestBody?.prompt_cache_retention
    || extractAnthropicCacheControl(requestBody)
  );
  if (topLevel) return true;
  return (Array.isArray(requestBody.messages) ? requestBody.messages : []).some((message) => {
    const content = message?.content;
    if (Array.isArray(content)) {
      return content.some((part) => Boolean(extractAnthropicCacheControl(part)));
    }
    return Boolean(extractAnthropicCacheControl(content));
  });
}

function requestUsesOpenAIPromptCacheRetention(requestBody = {}) {
  return Boolean(requestBody && typeof requestBody === 'object' && requestBody.prompt_cache_retention);
}

function stripOpenAIPromptCacheRetentionFromRequest(requestBody = {}) {
  if (!requestBody || typeof requestBody !== 'object') return requestBody;
  return stripOpenAIPromptCacheRetention(requestBody);
}

function stripOpenAICompatiblePromptCaching(requestBody = {}) {
  if (!requestBody || typeof requestBody !== 'object') return requestBody;
  const nextBody = stripOpenAIPromptCacheFields(stripCacheControlFields(requestBody));
  const strippedBody = {
    ...nextBody,
    tools: Array.isArray(nextBody.tools)
      ? nextBody.tools.map((tool) => sanitizeOpenAICompatibleToolWithoutCache(tool))
      : nextBody.tools
  };
  if (!Array.isArray(nextBody.messages)) return strippedBody;
  return {
    ...strippedBody,
    messages: nextBody.messages.map((message) => {
      if (!message || typeof message !== 'object') return message;
      const nextMessage = stripCacheControlFields(message);
      if (Array.isArray(nextMessage.content)) {
        return {
          ...nextMessage,
          content: nextMessage.content.map((part) => sanitizeOpenAICompatibleContentPart(stripCacheControlFields(part)))
        };
      }
      if (nextMessage.content && typeof nextMessage.content === 'object' && !Array.isArray(nextMessage.content)) {
        return {
          ...nextMessage,
          content: sanitizeOpenAICompatibleContentPart(stripCacheControlFields(nextMessage.content))
        };
      }
      return nextMessage;
    })
  };
}

function isOpenAIPromptCacheRetentionSchemaError(error) {
  const status = Number(error?.response?.status || 0);
  if (![400, 404, 415, 422].includes(status)) return false;
  const responseData = error?.response?.data;
  const bodyText = typeof responseData === 'string'
    ? responseData
    : JSON.stringify(responseData || {});
  return /prompt[_-]?cache[_-]?retention/i.test(bodyText);
}

function isOpenAICompatiblePromptCacheSchemaError(error) {
  const status = Number(error?.response?.status || 0);
  if (![400, 404, 415, 422].includes(status)) return false;
  const responseData = error?.response?.data;
  const bodyText = typeof responseData === 'string'
    ? responseData
    : JSON.stringify(responseData || {});
  return /cache[_-]?control|prompt[_-]?cache|prompt[_-]?cache[_-]?key|unknown field|extra inputs|additional properties/i.test(bodyText);
}

function isResponsesUrl(url = '') {
  return /\/responses(?:\/)?$/i.test(String(url || '').trim());
}

function normalizeResponsesTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      return String(part.text || part.content || part.output_text || '');
    }).join('');
  }
  if (content && typeof content === 'object') return String(content.text || content.content || '');
  return String(content || '');
}

function mapContentPartToResponsesInput(part) {
  if (typeof part === 'string') return { type: 'input_text', text: part };
  if (!part || typeof part !== 'object' || Array.isArray(part)) return null;
  const type = String(part.type || '').trim().toLowerCase();
  if (type === 'image_url') {
    const url = String(part?.image_url?.url || part.url || '').trim();
    if (!url) return null;
    const mapped = { type: 'input_image', image_url: url };
    const detail = normalizeOpenAIImageDetail(part?.image_url?.detail || part.detail);
    if (detail) mapped.detail = detail;
    return mapped;
  }
  if (type === 'input_image') {
    const url = String(part.image_url || part.url || '').trim();
    if (!url) return null;
    const mapped = { type: 'input_image', image_url: url };
    const detail = normalizeOpenAIImageDetail(part.detail);
    if (detail) mapped.detail = detail;
    return mapped;
  }
  if (type === 'input_text' || type === 'text') {
    return { type: 'input_text', text: String(part.text || part.content || '') };
  }
  const text = normalizeResponsesTextContent(part);
  return text ? { type: 'input_text', text } : null;
}

function mapMessageContentToResponsesInput(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(mapContentPartToResponsesInput).filter(Boolean);
  }
  if (content && typeof content === 'object') {
    const mapped = mapContentPartToResponsesInput(content);
    return mapped ? [mapped] : '';
  }
  return String(content || '');
}

function mapChatMessageToResponsesInput(message = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const role = String(message.role || '').trim().toLowerCase();
  if (role === 'tool') {
    const callId = String(message.tool_call_id || message.call_id || '').trim();
    if (!callId) return null;
    return {
      type: 'function_call_output',
      call_id: callId,
      output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content || '')
    };
  }
  if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return message.tool_calls.map((toolCall) => ({
      type: 'function_call',
      call_id: String(toolCall.id || toolCall.call_id || '').trim(),
      name: String(toolCall?.function?.name || toolCall.name || '').trim(),
      arguments: String(toolCall?.function?.arguments || toolCall.arguments || '{}')
    })).filter((item) => item.call_id && item.name);
  }
  const allowedRole = role === 'developer' || role === 'system' || role === 'assistant'
    ? role
    : 'user';
  return {
    type: 'message',
    role: allowedRole,
    content: mapMessageContentToResponsesInput(message.content)
  };
}

function mapChatMessagesToResponsesInput(messages = []) {
  const input = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const mapped = mapChatMessageToResponsesInput(message);
    if (Array.isArray(mapped)) input.push(...mapped);
    else if (mapped) input.push(mapped);
  }
  return input;
}

function mapChatToolsToResponsesTools(tools = []) {
  return (Array.isArray(tools) ? tools : [])
    .map((tool) => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return null;
      if (String(tool.type || '').trim() !== 'function' || !tool.function) return tool;
      const fn = tool.function;
      const mapped = {
        type: 'function',
        name: String(fn.name || '').trim(),
        parameters: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : null
      };
      if (typeof fn.description === 'string') mapped.description = fn.description;
      if (typeof fn.strict === 'boolean') mapped.strict = fn.strict;
      return mapped.name ? mapped : null;
    })
    .filter(Boolean);
}

function mapToolChoiceToResponses(toolChoice) {
  if (!toolChoice || typeof toolChoice === 'string') return toolChoice;
  if (typeof toolChoice !== 'object') return toolChoice;
  if (toolChoice.type === 'function') {
    return {
      type: 'function',
      name: String(toolChoice?.function?.name || toolChoice.name || '').trim()
    };
  }
  return toolChoice;
}

function mapReasoningEffortToResponses(value) {
  const effort = normalizeReasoningEffort(value);
  return effort ? { effort } : null;
}

function buildResponsesRequestBody(openAICompatibleBody = {}) {
  const body = openAICompatibleBody && typeof openAICompatibleBody === 'object'
    ? stripTopPField({ ...openAICompatibleBody })
    : {};
  const requestBody = {
    model: body.model,
    input: Array.isArray(body.input) || typeof body.input === 'string'
      ? body.input
      : mapChatMessagesToResponsesInput(body.messages),
    stream: Boolean(body.stream)
  };

  if (Number.isFinite(Number(body.temperature))) requestBody.temperature = Number(body.temperature);
  if (Number.isFinite(Number(body.top_p))) requestBody.top_p = Number(body.top_p);
  if (Number.isFinite(Number(body.max_output_tokens))) {
    requestBody.max_output_tokens = Math.floor(Number(body.max_output_tokens));
  } else if (Number.isFinite(Number(body.max_tokens))) {
    requestBody.max_output_tokens = Math.floor(Number(body.max_tokens));
  }
  const reasoning = body.reasoning && typeof body.reasoning === 'object'
    ? body.reasoning
    : mapReasoningEffortToResponses(body.reasoning_effort);
  if (reasoning) requestBody.reasoning = reasoning;
  if (Array.isArray(body.tools)) {
    const tools = mapChatToolsToResponsesTools(body.tools);
    if (tools.length > 0) requestBody.tools = tools;
  }
  const toolChoice = mapToolChoiceToResponses(body.tool_choice);
  if (toolChoice) requestBody.tool_choice = toolChoice;
  if (body.prompt_cache_key) requestBody.prompt_cache_key = body.prompt_cache_key;
  if (body.prompt_cache_retention) requestBody.prompt_cache_retention = body.prompt_cache_retention;
  if (body.user) requestBody.user = body.user;
  if (body.service_tier) requestBody.service_tier = body.service_tier;
  if (body.text) requestBody.text = body.text;
  if (body.truncation) requestBody.truncation = body.truncation;
  if (Array.isArray(body.include)) requestBody.include = body.include;
  if (body.previous_response_id) requestBody.previous_response_id = body.previous_response_id;
  return requestBody;
}

function isAnthropicPromptCacheSchemaError(error) {
  const status = Number(error?.response?.status || 0);
  if (![400, 404, 415, 422].includes(status)) return false;
  const responseData = error?.response?.data;
  const bodyText = typeof responseData === 'string'
    ? responseData
    : JSON.stringify(responseData || {});
  return /cache[_-]?control|prompt[_-]?cache|prompt-caching-2024-07-31|anthropic-beta|unknown field|unsupported beta|extra inputs|additional properties/i.test(bodyText);
}

function normalizeReasoningEffort(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return '';
  if (['0', 'false', 'no', 'off', 'none', 'disabled', 'disable'].includes(normalized)) return '';
  if (['minimal', 'low', 'medium', 'high'].includes(normalized)) return normalized;
  return 'high';
}

function getAnthropicThinkingBudget(maxTokens, effort) {
  const normalized = normalizeReasoningEffort(effort);
  if (!normalized) return 0;
  const outputTokens = Number(maxTokens);
  if (!Number.isFinite(outputTokens) || outputTokens <= 0) return 0;
  const defaults = {
    minimal: 1024,
    low: 1024,
    medium: 2048,
    high: 4096
  };
  return Math.min(
    defaults[normalized] || defaults.high,
    Math.max(1024, Math.floor(outputTokens * 0.6)),
    Math.max(0, Math.floor(outputTokens) - 1)
  );
}

function requestUsesReasoning(requestBody = {}) {
  if (!requestBody || typeof requestBody !== 'object') return false;
  return Boolean(requestBody.reasoning_effort || requestBody.reasoning || requestBody.thinking);
}

function stripReasoningFields(requestBody = {}) {
  if (!requestBody || typeof requestBody !== 'object') return requestBody;
  const nextBody = { ...requestBody };
  const originalMaxTokens = Number(requestBody.__originalMaxTokens);
  delete nextBody.reasoning_effort;
  delete nextBody.reasoning;
  delete nextBody.thinking;
  delete nextBody.__originalMaxTokens;
  if (Number.isFinite(originalMaxTokens) && originalMaxTokens > 0) {
    nextBody.max_tokens = Math.floor(originalMaxTokens);
  }
  return nextBody;
}

function requestUsesExtendedSampling(requestBody = {}) {
  if (!requestBody || typeof requestBody !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(requestBody, 'top_k')
    || Object.prototype.hasOwnProperty.call(requestBody, 'top_a')
    || Object.prototype.hasOwnProperty.call(requestBody, 'repetition_penalty');
}

function stripExtendedSamplingFields(requestBody = {}) {
  if (!requestBody || typeof requestBody !== 'object') return requestBody;
  const nextBody = { ...requestBody };
  delete nextBody.top_k;
  delete nextBody.top_a;
  delete nextBody.repetition_penalty;
  return nextBody;
}

function stripProviderCacheFields(provider = 'openai_compatible', requestBody = {}) {
  if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) return requestBody;
  let nextBody = requestBody;
  if (!providerAllowsOpenAIPromptCache(provider)) {
    nextBody = stripOpenAIPromptCacheFields(nextBody);
  }
  if (!providerAllowsCacheControl(provider)) {
    nextBody = stripCacheControlFieldsDeep(nextBody);
  }
  return nextBody;
}

function stripInternalRequestFields(requestBody = {}) {
  if (!requestBody || typeof requestBody !== 'object') return requestBody;
  const nextBody = { ...requestBody };
  delete nextBody.__trace;
  delete nextBody.__timeoutMs;
  delete nextBody.__abortSignal;
  delete nextBody.__requestHeaders;
  delete nextBody.__originalMaxTokens;
  return nextBody;
}

function countCacheControlBlocks(value) {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countCacheControlBlocks(item), 0);
  }
  if (!value || typeof value !== 'object') return 0;
  let total = extractAnthropicCacheControl(value) ? 1 : 0;
  total += countCacheControlBlocks(value.content);
  total += countCacheControlBlocks(value.function);
  return total;
}

function buildRequestCacheTrace(requestBody = {}, requestHeaders = {}) {
  const body = requestBody && typeof requestBody === 'object' ? requestBody : {};
  const promptCaching = {
    openaiPromptCacheKey: normalizeText(body.prompt_cache_key),
    openaiPromptCacheRetention: normalizeText(body.prompt_cache_retention),
    anthropicCacheBreakpoints: 0,
    anthropicPromptCacheTtl: '',
    anthropicBeta: normalizeText((requestHeaders || {})['anthropic-beta'] || (requestHeaders || {})['Anthropic-Beta'])
  };

  promptCaching.anthropicCacheBreakpoints += countCacheControlBlocks(body.system);
  promptCaching.anthropicCacheBreakpoints += countCacheControlBlocks(body.messages);
  promptCaching.anthropicCacheBreakpoints += countCacheControlBlocks(body.tools);

  const findTtl = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const ttl = findTtl(item);
        if (ttl) return ttl;
      }
      return '';
    }
    if (!value || typeof value !== 'object') return '';
    if (value.cache_control && typeof value.cache_control === 'object') {
      return normalizeText(value.cache_control.ttl);
    }
    return findTtl(value.content) || findTtl(value.function);
  };
  promptCaching.anthropicPromptCacheTtl = findTtl(body.system) || findTtl(body.messages) || findTtl(body.tools);
  return promptCaching;
}

function emitHttpTrace(trace = {}, phase = '', payload = {}) {
  const requestId = normalizeText(trace?.requestId || trace?.request_id);
  if (!requestId) return;
  const diagnostics = trace?.modelRouteDiagnostic && typeof trace.modelRouteDiagnostic === 'object'
    ? trace.modelRouteDiagnostic
    : buildModelRouteDiagnostics({
        routeDebugKey: trace?.routeDebugKey,
        routePolicyKey: trace?.routePolicyKey || trace?.route_policy_key,
        topRouteType: trace?.topRouteType || trace?.top_route_type,
        branch: trace?.dispatchBranch || trace?.branch,
        triggerBranch: trace?.triggerBranch || phase,
        provider: payload.provider || trace?.provider,
        apiBaseUrl: trace?.apiBaseUrl || payload.requestUrl,
        model: payload.model || trace?.model,
        modelSource: trace?.modelSource,
        apiBaseUrlSource: trace?.apiBaseUrlSource,
        apiKeySource: trace?.apiKeySource,
        fallbackReason: trace?.fallbackReason,
        fallbackScope: trace?.mainFallbackScope,
        fallbackActive: trace?.mainFallbackActive === true,
        fallbackForced: trace?.mainFallbackForced === true
      });
  appendRequestTraceEvent(nextTracePhase(trace, phase, {
    tracePhase: normalizeText(phase || trace.phase || 'httpClient') || 'httpClient',
    stage: normalizeText(payload.stage || phase || trace.phase || 'http_client'),
    source: normalizeText(trace.source || 'httpClient') || 'httpClient',
    purpose: normalizeText(trace.purpose),
    userId: normalizeText(trace.userId || trace.user_id),
    routePolicyKey: normalizeText(trace.routePolicyKey || trace.route_policy_key),
    routeDebugKey: normalizeText(trace.routeDebugKey || diagnostics.routeDebugKey),
    topRouteType: normalizeText(trace.topRouteType || trace.top_route_type),
    dispatchBranch: normalizeText(trace.dispatchBranch || diagnostics.branch),
    triggerBranch: normalizeText(trace.triggerBranch || diagnostics.triggerBranch),
    apiBaseUrl: normalizeText(trace.apiBaseUrl || diagnostics.apiBaseUrl),
    apiBaseUrlHost: normalizeText(trace.apiBaseUrlHost || diagnostics.apiBaseUrlHost),
    modelSource: normalizeText(trace.modelSource || diagnostics.modelSource),
    apiBaseUrlSource: normalizeText(trace.apiBaseUrlSource || diagnostics.apiBaseUrlSource),
    apiKeySource: normalizeText(trace.apiKeySource || diagnostics.apiKeySource),
    fallbackReason: normalizeText(trace.fallbackReason || diagnostics.fallbackReason),
    mainFallbackScope: normalizeText(trace.mainFallbackScope || diagnostics.fallbackScope),
    mainFallbackActive: trace.mainFallbackActive === true || diagnostics.fallbackActive === true,
    mainFallbackForced: trace.mainFallbackForced === true || diagnostics.fallbackForced === true,
    modelRouteDiagnostic: diagnostics,
    ...payload
  }));
}

function emitHttpSuccessTrace(trace = {}, prepared = {}, body = {}, payload = {}) {
  emitHttpTrace(trace, 'http_client_success', {
    stage: 'http_client_success',
    provider: prepared?.provider,
    model: prepared?.requestBody?.model || body?.model || '',
    requestUrl: prepared?.requestUrl,
    fallbackActive: trace?.mainFallbackActive === true,
    ...payload
  });
}

function emitHttpFailureTrace(trace = {}, prepared = {}, body = {}, error = null, payload = {}) {
  emitHttpTrace(trace, 'http_client_failure', {
    stage: 'http_client_failure',
    provider: prepared?.provider,
    model: prepared?.requestBody?.model || body?.model || '',
    requestUrl: prepared?.requestUrl,
    statusCode: extractHttpStatus(error) || null,
    finalErrorCode: extractErrorCode(error),
    error: normalizeText(error?.message || error).slice(0, 400),
    fallbackActive: trace?.mainFallbackActive === true,
    ...payload
  });
}

function emitHttpDowngradeTrace(trace = {}, prepared = {}, body = {}, reason = '', error = null, payload = {}) {
  emitHttpTrace(trace, 'http_client_request_downgrade', {
    stage: 'http_client_request_downgrade',
    reason,
    provider: prepared?.provider,
    model: prepared?.requestBody?.model || body?.model || '',
    requestUrl: prepared?.requestUrl,
    statusCode: extractHttpStatus(error) || null,
    ...payload
  });
}

function extractInternalRequestHeaders(requestBody = {}) {
  if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) return null;
  const rawHeaders = requestBody.__requestHeaders;
  if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) return null;

  const headers = {};
  for (const [rawKey, rawValue] of Object.entries(rawHeaders)) {
    const key = String(rawKey || '').trim();
    const value = String(rawValue || '').trim();
    if (!key || !value) continue;
    headers[key] = value;
  }

  return Object.keys(headers).length > 0 ? headers : null;
}

function extractProviderRequestHeaders(provider = 'openai_compatible', requestBody = {}) {
  return normalizeProviderRequestHeaders(provider, extractInternalRequestHeaders(requestBody));
}

function isReasoningSchemaError(error) {
  const status = Number(error?.response?.status || 0);
  if (![400, 404, 415, 422].includes(status)) return false;
  const responseData = error?.response?.data;
  const bodyText = typeof responseData === 'string'
    ? responseData
    : JSON.stringify(responseData || {});
  return /reasoning|reasoning[_-]?effort|thinking|budget[_-]?tokens|unsupported.*(?:field|parameter)|unknown field|extra inputs|additional properties/i.test(bodyText);
}

function isExtendedSamplingSchemaError(error) {
  const status = Number(error?.response?.status || 0);
  if (![400, 404, 415, 422].includes(status)) return false;
  const responseData = error?.response?.data;
  const bodyText = typeof responseData === 'string'
    ? responseData
    : JSON.stringify(responseData || {});
  return /top[_-]?k|top[_-]?a|repetition[_-]?penalty|unsupported.*(?:field|parameter)|unknown field|unknown parameter|extra inputs|additional properties/i.test(bodyText);
}

function mapToolSchemaToAnthropic(tool) {
  if (!tool || typeof tool !== 'object') return null;
  if (tool.type !== 'function') return null;

  const fn = tool.function || {};
  const name = normalizeText(fn.name);
  if (!name) return null;

  return {
    name,
    description: normalizeText(fn.description),
    input_schema: (fn.parameters && typeof fn.parameters === 'object')
      ? fn.parameters
      : { type: 'object', properties: {} }
  };
}

function mapToolChoiceToAnthropic(toolChoice) {
  if (!toolChoice) return null;

  if (typeof toolChoice === 'string') {
    if (toolChoice === 'auto') return { type: 'auto' };
    if (toolChoice === 'required') return { type: 'any' };
    return null;
  }

  const type = String(toolChoice.type || '').toLowerCase();
  if (type === 'auto') return { type: 'auto' };
  if (type === 'any' || type === 'required') return { type: 'any' };
  if (type === 'function') {
    const name = normalizeText(toolChoice?.function?.name);
    return name ? { type: 'tool', name } : null;
  }
  if (type === 'tool') {
    const name = normalizeText(toolChoice?.name);
    return name ? { type: 'tool', name } : null;
  }

  return null;
}

function inferMessageRole(item) {
  const explicitRole = normalizeText(item?.role).toLowerCase();
  if (explicitRole) return explicitRole;

  if (typeof item?._getType === 'function') {
    const lcType = normalizeText(item._getType()).toLowerCase();
    if (lcType === 'system') return 'system';
    if (lcType === 'tool') return 'tool';
    if (lcType === 'ai') return 'assistant';
    if (lcType === 'human') return 'user';
  }

  if (normalizeText(item?.tool_call_id || item?.tool_use_id)) return 'tool';
  if (Array.isArray(item?.tool_calls) && item.tool_calls.length > 0) return 'assistant';
  return 'user';
}

async function mapMessagesToAnthropic(messages) {
  const systemBlocks = [];
  const out = [];

  const items = Array.isArray(messages) ? messages : [];
  for (const item of items) {
    const role = inferMessageRole(item);
    const messageCacheControl = extractAnthropicMessageCacheControl(item);

    if (role === 'system') {
      const rawSystemText = typeof item?.content === 'string'
        ? item.content
        : ((Array.isArray(item?.content) && item.content.every((block) => typeof block?.text === 'string'))
          ? item.content.map((block) => String(block.text || '')).join('\n')
          : '');
      const splitSystem = splitAnthropicStableSystemText(rawSystemText);
      if (splitSystem) {
        const stableBlocks = applyAnthropicCacheControlToLastBlock(
          (await toAnthropicContentBlocks(splitSystem.stableText))
            .filter((block) => block?.type === 'text'),
          messageCacheControl || true
        );
        if (stableBlocks.length > 0) systemBlocks.push(...stableBlocks);

        const dynamicBlocks = await toAnthropicContentBlocks(`${ANTHROPIC_ASSISTANT_CONTEXT_PREFIX}\n${splitSystem.dynamicText}`);
        if (dynamicBlocks.length > 0) {
          out.push({
            role: 'assistant',
            content: dynamicBlocks
          });
        }
        continue;
      }

      if (isAnthropicDynamicSystemContextText(rawSystemText)) {
        const contextBlocks = await toAnthropicContentBlocks(`${ANTHROPIC_ASSISTANT_CONTEXT_PREFIX}\n${rawSystemText}`);
        if (contextBlocks.length > 0) {
          out.push({
            role: 'assistant',
            content: contextBlocks
          });
        }
        continue;
      }

      const blocks = applyAnthropicCacheControlToLastBlock(
        (await toAnthropicContentBlocks(item?.content))
          .filter((block) => block?.type === 'text'),
        messageCacheControl
      );
      if (blocks.length > 0) systemBlocks.push(...blocks);
      continue;
    }

    if (role === 'tool') {
      const toolUseId = normalizeText(item?.tool_call_id || item?.tool_use_id) || `tool_${Date.now()}`;
      const toolResultBlocks = await toAnthropicContentBlocks(item?.content);

      out.push({
        role: 'user',
        content: [
          applyAnthropicCacheControl({
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: serializeAnthropicToolResultContent(toolResultBlocks)
          }, messageCacheControl)
        ]
      });
      continue;
    }

    if (role === 'assistant') {
      let blocks = await toAnthropicContentBlocks(item?.content);
      const allowAssistantCacheControl = !isAnthropicAssistantOnlyContextText(extractInputMessageText(item));
      const toolCalls = Array.isArray(item?.tool_calls) ? item.tool_calls : [];

      for (const call of toolCalls) {
        const toolName = normalizeText(call?.function?.name || call?.name);
        if (!toolName) continue;

        blocks.push({
          type: 'tool_use',
          id: normalizeText(call?.id) || `tooluse_${Date.now()}`,
          name: toolName,
          input: normalizeJsonObject(call?.function?.arguments || call?.args)
        });
      }

      blocks = allowAssistantCacheControl
        ? applyAnthropicCacheControlToLastBlock(blocks, messageCacheControl)
        : stripAnthropicCacheControlFromBlocks(blocks);

      out.push({
        role: 'assistant',
        content: blocks.length ? blocks : [{ type: 'text', text: '' }]
      });
      continue;
    }

    const userBlocks = applyAnthropicCacheControlToLastBlock(
      await toAnthropicContentBlocks(item?.content),
      messageCacheControl
    );
    out.push({
      role: 'user',
      content: userBlocks.length ? userBlocks : [{ type: 'text', text: '' }]
    });
  }

  return {
    system: systemBlocks,
    messages: coerceTrailingAnthropicAssistantContextToUser(
      out.length ? out : [{ role: 'user', content: [{ type: 'text', text: '(empty input)' }] }]
    )
  };
}

async function buildAnthropicRequestBody(body = {}) {
  const inputBody = stripTopPField(body);
  const mapped = await mapMessagesToAnthropic(inputBody.messages);
  const maxTokens = Number(inputBody.max_tokens);
  const visibleMaxTokens = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 1024;

  const requestBody = {
    model: normalizeText(inputBody.model) || normalizeText(config.AI_MODEL) || 'claude-3-5-sonnet-latest',
    max_tokens: visibleMaxTokens,
    messages: mapped.messages,
    stream: Boolean(inputBody.stream)
  };

  if (mapped.system.length > 0) requestBody.system = mapped.system;

  const temperature = clampTemperatureForProvider('anthropic', inputBody.temperature);
  if (temperature !== null) requestBody.temperature = temperature;

  const topP = Number(inputBody.top_p);
  if (Number.isFinite(topP)) requestBody.top_p = topP;

  const topK = Number(inputBody.top_k);
  if (Number.isFinite(topK) && topK > 0) requestBody.top_k = Math.floor(topK);

  if (Array.isArray(inputBody.stop)) {
    const stops = inputBody.stop.map((x) => String(x || '').trim()).filter(Boolean);
    if (stops.length) requestBody.stop_sequences = stops;
  }

  if (Array.isArray(inputBody.tools)) {
    const tools = inputBody.tools
      .map(mapToolSchemaToAnthropic)
      .filter(Boolean);
    if (tools.length) {
      requestBody.tools = tools;
      const choice = mapToolChoiceToAnthropic(inputBody.tool_choice);
      if (choice) requestBody.tool_choice = choice;
    }
  }

  const reasoningEffort = normalizeReasoningEffort(inputBody.reasoning_effort);
  const thinkingBudget = getAnthropicThinkingBudget(Math.max(visibleMaxTokens, 1200), reasoningEffort);
  if (thinkingBudget > 0) {
    requestBody.max_tokens = Math.max(visibleMaxTokens + thinkingBudget, 1200);
    requestBody.thinking = {
      type: 'enabled',
      budget_tokens: thinkingBudget
    };
    requestBody.__originalMaxTokens = visibleMaxTokens;
  }

  return applyAutoAnthropicPromptCaching(requestBody);
}

async function prepareRequest(url, body = {}) {
  const provider = getApiProvider(url, body?.model || config.AI_MODEL);
  const internalRequestHeaders = extractProviderRequestHeaders(provider, body);
  if (!isAnthropicProvider(provider)) {
    const requestBody = body && typeof body === 'object'
      ? stripTopPField(stripProviderCacheFields(provider, stripInternalRequestFields({ ...body })))
      : body;
    const shouldUseOpenAIPromptCache = Boolean(
      providerAllowsOpenAIPromptCache(provider)
      && requestBody
      && typeof requestBody === 'object'
      && (requestBody.prompt_cache_key || requestBody.prompt_cache_retention)
    );
    const shouldUseAnthropicCompatibleCache = Boolean(
      requestBody
      && typeof requestBody === 'object'
      && !shouldUseOpenAIPromptCache
      && providerAllowsCacheControl(provider)
    );
    const normalizedTopLevelCacheControl = extractAnthropicCacheControl(body);
    if (normalizedTopLevelCacheControl && shouldUseAnthropicCompatibleCache) {
      requestBody.cache_control = normalizedTopLevelCacheControl;
    }
    if (requestBody && Array.isArray(requestBody.messages)) {
      const shouldPreserveCacheControl = !shouldUseOpenAIPromptCache && providerAllowsCacheControl(provider);
      requestBody.messages = shouldUseOpenAIPromptCache
        ? await preprocessOpenAICompatibleMessagesWithoutCache(requestBody.messages)
        : (
            shouldPreserveCacheControl
              ? await preprocessOpenAICompatibleMessages(requestBody.messages)
              : await preprocessOpenAICompatibleMessagesWithoutCache(requestBody.messages)
          );
    }
    if (
      requestBody
      && (shouldUseOpenAIPromptCache || !providerAllowsCacheControl(provider))
      && Array.isArray(requestBody.tools)
    ) {
      requestBody.tools = requestBody.tools.map((tool) => sanitizeOpenAICompatibleToolWithoutCache(tool));
    }
    const reasoningEffort = normalizeReasoningEffort(requestBody?.reasoning_effort);
    if (requestBody && typeof requestBody === 'object') {
      if (reasoningEffort) requestBody.reasoning_effort = reasoningEffort;
      else delete requestBody.reasoning_effort;
    }
    const finalRequestBody = isResponsesUrl(url)
      ? buildResponsesRequestBody(requestBody)
      : requestBody;
    return {
      provider,
      requestUrl: url,
      requestBody: finalRequestBody,
      requestHeaders: internalRequestHeaders
    };
  }

  const requestBody = await buildAnthropicRequestBody(stripInternalRequestFields(body));
  const anthropicRequestHeaders = buildAnthropicRequestHeaders(requestBody);
  return {
    provider,
    requestUrl: ensureAnthropicMessagesUrl(url),
    requestBody,
    requestHeaders: normalizeProviderRequestHeaders(provider, {
      ...(anthropicRequestHeaders || {}),
      ...(internalRequestHeaders || {})
    })
  };
}

/**
 * Build axios options used by all API requests.
 */
function getRequestTimeoutMs() {
  const n = Number(config.REQUEST_TIMEOUT_MS);
  if (!Number.isFinite(n)) return 60000;
  return Math.max(10000, Math.floor(n));
}

function getStreamTimeoutMs() {
  const n = Number(config.REQUEST_STREAM_TIMEOUT_MS);
  const base = getRequestTimeoutMs();
  if (!Number.isFinite(n)) return Math.max(base, 120000);
  return Math.max(base, Math.floor(n));
}

function getFirstTokenTimeoutMs() {
  const n = Number(config.AI_STREAM_FIRST_TOKEN_TIMEOUT_MS);
  if (!Number.isFinite(n)) return 240000;
  return Math.max(10000, Math.floor(n));
}

function getRetryTimeoutMs(baseMs, attempt, stepMs, capMs) {
  const value = baseMs + (Math.max(0, attempt) * stepMs);
  return Math.min(capMs, value);
}

function containsAny(text, keywords = []) {
  const lower = String(text || '').toLowerCase();
  if (!lower) return false;
  return keywords.some((kw) => lower.includes(String(kw || '').toLowerCase()));
}

function isCloudflare403(err) {
  const status = Number(err?.response?.status);
  if (status !== 403) return false;

  const headers = err?.response?.headers || {};
  const server = String(headers.server || '');
  const cfRay = String(headers['cf-ray'] || '');
  const body = String(err?.response?.data || '');

  // Cloudflare blocked pages usually expose cf-ray header or cloudflare markers in body/html.
  if (containsAny(server, ['cloudflare'])) return true;
  if (cfRay.trim()) return true;
  if (containsAny(body, ['cloudflare', 'attention required', 'captcha', 'sorry, you have been blocked'])) return true;

  return false;
}

function parseRetryAfterMs(err) {
  const raw = err?.response?.headers?.['retry-after'];
  if (raw == null) return null;

  const text = String(raw).trim();
  if (!text) return null;

  const asSeconds = Number(text);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.floor(asSeconds * 1000);
  }

  const asDate = Date.parse(text);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now());
  }

  return null;
}

function getRetryDelayMs(err, attempt) {
  const retryAfterMs = parseRetryAfterMs(err);
  if (retryAfterMs != null) {
    const capped = Math.min(30000, Math.max(500, retryAfterMs));
    return capped + Math.floor(Math.random() * 250);
  }

  // Cloudflare challenge usually needs a longer cool-down than normal transient errors.
  if (isCloudflare403(err)) {
    const base = 2500 * Math.pow(2, attempt);
    const capped = Math.min(30000, base);
    return capped + Math.floor(Math.random() * 1000);
  }

  const base = 300 * Math.pow(2, attempt);
  return base + Math.floor(Math.random() * 200);
}

function getHeaders(provider, specificKey = null, extraHeaders = null) {
  const apiKey = specificKey || config.API_KEY;
  const userAgent = String(
    config.MODEL_HTTP_USER_AGENT
      || config.MAIN_REPLY_USER_AGENT
      || config.HTTP_USER_AGENT
      || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
  ).trim();
  const acceptLanguage = String(config.HTTP_ACCEPT_LANGUAGE || 'zh-CN,zh;q=0.9,en;q=0.8').trim();
  if (isAnthropicProvider(provider)) {
    const headers = {
      'x-api-key': apiKey,
      'anthropic-version': config.ANTHROPIC_VERSION || '2023-06-01',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': acceptLanguage
    };
    if (config.ANTHROPIC_BETA) {
      headers['anthropic-beta'] = String(config.ANTHROPIC_BETA).trim();
    }
    if (extraHeaders && typeof extraHeaders === 'object') {
      Object.assign(headers, extraHeaders);
    }
    const normalizedHeaders = normalizeProviderRequestHeaders(provider, headers) || {};
    normalizedHeaders['User-Agent'] = false;
    return normalizedHeaders;
  }

  if (isGeminiNativeProvider(provider)) {
    const headers = {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': acceptLanguage
    };
    if (extraHeaders && typeof extraHeaders === 'object') {
      Object.assign(headers, extraHeaders);
    }
    const normalizedHeaders = normalizeProviderRequestHeaders(provider, headers) || {};
    normalizedHeaders['User-Agent'] = false;
    return normalizedHeaders;
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': acceptLanguage,
    'User-Agent': userAgent
  };
  if (extraHeaders && typeof extraHeaders === 'object') {
    Object.assign(headers, extraHeaders);
  }
  return normalizeProviderRequestHeaders(provider, headers) || {};
}

function getAxiosOptions(provider = 'openai_compatible', specificKey = null, timeoutMs = null, extraHeaders = null, abortSignal = null) {
  const options = {
    headers: getHeaders(provider, specificKey, extraHeaders),
    timeout: Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : getRequestTimeoutMs(),
    proxy: false,
    responseType: 'text'
  };
  if (abortSignal) options.signal = abortSignal;

  if (config.PROXY_URL && HttpsProxyAgentCtor) {
    options.httpsAgent = new HttpsProxyAgentCtor(config.PROXY_URL);
  }
  return options;
}

function getStreamAxiosOptions(provider = 'openai_compatible', specificKey = null, timeoutMs = null, extraHeaders = null, abortSignal = null) {
  return {
    ...getAxiosOptions(
      provider,
      specificKey,
      Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : getStreamTimeoutMs(),
      extraHeaders,
      abortSignal
    ),
    responseType: 'stream'
  };
}

async function validatePreparedEndpoint(requestUrl) {
  await assertSafeModelEndpoint(requestUrl, {
    allowLocalHttp: Boolean(config.MODEL_ENDPOINT_ALLOW_LOCAL_HTTP)
  });
}

function shouldRetry(err) {
  const code = String(err?.code || '').toUpperCase();
  if (['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) return true;
  const status = Number(err?.response?.status);
  if (isCloudflare403(err)) return true;
  if (status === 408 || status === 409 || status === 425 || status === 429) return true;
  if (status >= 500) return true;
  // Network errors usually have no response object.
  if (!err?.response) return true;
  return false;
}

function shouldRetryStreamRequest(err, handlers = {}) {
  if (handlers && handlers.__abort_requested) return false;
  if (!shouldRetry(err)) return false;
  if (handlers && handlers.__stream_started) return false;
  return true;
}

/**
 * POST request with retry + exponential backoff.
 */
async function postWithRetry(url, body, retries = 1, specificKey = null) {
  let lastErr;
  const maxRetry = Math.max(0, Number(retries) || 0);
  const trace = body && typeof body === 'object' && body.__trace && typeof body.__trace === 'object'
    ? body.__trace
    : {};
  const requestedTimeoutMs = body && typeof body === 'object'
    ? Number(body.__timeoutMs)
    : NaN;
  const abortSignal = body && typeof body === 'object' && body.__abortSignal
    ? body.__abortSignal
    : null;

  for (let i = 0; i <= maxRetry; i++) {
    let callId = '';
    let prepared = null;
    let timeoutMs = getRequestTimeoutMs();
    const attemptStartedAt = Date.now();
    try {
      const timeoutBase = Number.isFinite(requestedTimeoutMs)
        ? Math.max(1000, Math.floor(requestedTimeoutMs))
        : getRequestTimeoutMs();
      const timeoutCap = Number.isFinite(requestedTimeoutMs)
        ? Math.max(timeoutBase, timeoutBase + (15000 * Math.max(0, maxRetry)))
        : 180000;
      timeoutMs = getRetryTimeoutMs(timeoutBase, i, 15000, timeoutCap);
      prepared = await prepareRequest(url, body);
      await validatePreparedEndpoint(prepared.requestUrl);
      const routeDiagnostics = buildModelRouteDiagnostics({
        ...trace,
        provider: prepared.provider,
        apiBaseUrl: prepared.requestUrl,
        model: prepared.requestBody?.model || body?.model || ''
      });
      Object.assign(trace, createModelRouteTracePatch(routeDiagnostics));
      emitHttpTrace(trace, 'http_client_start', {
        stage: 'http_client_start',
        attempt: i + 1,
        maxAttempts: maxRetry + 1,
        provider: prepared.provider,
        model: prepared.requestBody?.model || body?.model || '',
        requestUrl: prepared.requestUrl,
        stream: Boolean(prepared.requestBody?.stream || body?.stream),
        cache: buildRequestCacheTrace(prepared.requestBody, prepared.requestHeaders),
        fallbackActive: trace.mainFallbackActive === true,
        fallbackScope: trace.mainFallbackScope || ''
      });
      callId = startModelCall({
        source: trace.source || 'httpClient',
        phase: trace.phase || '',
        purpose: trace.purpose || '',
        requestId: trace.requestId || '',
        phaseSeq: trace.phaseSeq,
        userId: trace.userId || '',
        taskId: trace.taskId || '',
        routePolicyKey: trace.routePolicyKey || '',
        routeDebugKey: trace.routeDebugKey || '',
        topRouteType: trace.topRouteType || '',
        dispatchBranch: trace.dispatchBranch || '',
        triggerBranch: trace.triggerBranch || '',
        apiBaseUrl: trace.apiBaseUrl || prepared.requestUrl,
        apiBaseUrlHost: trace.apiBaseUrlHost || '',
        fallbackReason: trace.fallbackReason || '',
        userRole: trace.userRole || '',
        modelSource: trace.modelSource || '',
        apiBaseUrlSource: trace.apiBaseUrlSource || '',
        apiKeySource: trace.apiKeySource || '',
        mainFallbackScope: trace.mainFallbackScope || '',
        mainFallbackActive: trace.mainFallbackActive === true,
        mainFallbackForced: trace.mainFallbackForced === true,
        modelRouteDiagnostic: trace.modelRouteDiagnostic,
        adminDedicatedModelConfigured: trace.adminDedicatedModelConfigured,
        url: prepared.requestUrl,
        provider: prepared.provider,
        model: prepared.requestBody?.model || body?.model,
        request: prepared.requestBody,
        requestHeaders: prepared.requestHeaders,
        memoryInjected: trace.memoryInjected
      });
      const response = await axios.post(
        prepared.requestUrl,
        prepared.requestBody,
        getAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal)
      );
      emitHttpTrace(trace, 'http_client_success', {
        stage: 'http_client_success',
        attempt: i + 1,
        provider: prepared.provider,
        model: prepared.requestBody?.model || body?.model || '',
        requestUrl: prepared.requestUrl,
        statusCode: Number(response?.status || 0) || null,
        durationMs: Math.max(0, Date.now() - attemptStartedAt),
        fallbackActive: trace.mainFallbackActive === true
      });
      finishModelCall(callId, {
        response,
        attempts: i + 1,
        requestUrl: prepared.requestUrl,
        request: prepared.requestBody,
        requestHeaders: prepared.requestHeaders
      });
      return response;
    } catch (e) {
      emitHttpTrace(trace, 'http_client_failure', {
        stage: 'http_client_failure',
        attempt: i + 1,
        provider: prepared?.provider,
        model: prepared?.requestBody?.model || body?.model || '',
        requestUrl: prepared?.requestUrl,
        statusCode: extractHttpStatus(e) || null,
        finalErrorCode: extractErrorCode(e),
        error: normalizeText(e?.message || e).slice(0, 400),
        retryable: i < maxRetry && shouldRetry(e),
        durationMs: Math.max(0, Date.now() - attemptStartedAt),
        fallbackActive: trace.mainFallbackActive === true
      });
      if (callId && requestUsesReasoning(prepared?.requestBody) && isReasoningSchemaError(e)) {
        emitHttpTrace(trace, 'http_client_request_downgrade', {
          stage: 'http_client_request_downgrade',
          reason: 'strip_reasoning_fields',
          provider: prepared?.provider,
          model: prepared?.requestBody?.model || body?.model || '',
          requestUrl: prepared?.requestUrl,
          statusCode: extractHttpStatus(e) || null,
          durationMs: Math.max(0, Date.now() - attemptStartedAt)
        });
        try {
          const strippedRequestBody = stripReasoningFields(prepared.requestBody);
          const response = await axios.post(
            prepared.requestUrl,
            strippedRequestBody,
            getAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal)
          );
          emitHttpSuccessTrace(trace, { ...prepared, requestBody: strippedRequestBody }, body, {
            attempt: i + 1,
            statusCode: Number(response?.status || 0) || null,
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            downgraded: true,
            downgradeReason: 'strip_reasoning_fields'
          });
          finishModelCall(callId, {
            response,
            attempts: i + 1,
            requestUrl: prepared.requestUrl,
            request: strippedRequestBody,
            requestHeaders: prepared.requestHeaders
          });
          return response;
        } catch (retryWithoutReasoningError) {
          emitHttpFailureTrace(trace, { ...prepared, requestBody: stripReasoningFields(prepared.requestBody) }, body, retryWithoutReasoningError, {
            attempt: i + 1,
            retryable: i < maxRetry && shouldRetry(retryWithoutReasoningError),
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            downgraded: true,
            downgradeReason: 'strip_reasoning_fields'
          });
          if (callId) {
            failModelCall(callId, retryWithoutReasoningError, {
              attempts: i + 1,
              requestUrl: prepared.requestUrl,
              request: stripReasoningFields(prepared.requestBody),
              requestHeaders: prepared.requestHeaders
            });
          }
          lastErr = retryWithoutReasoningError;
          if (i >= maxRetry || !shouldRetry(retryWithoutReasoningError)) break;
          const delayMs = getRetryDelayMs(retryWithoutReasoningError, i);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
      }
      if (callId && requestUsesExtendedSampling(prepared?.requestBody) && isExtendedSamplingSchemaError(e)) {
        emitHttpTrace(trace, 'http_client_request_downgrade', {
          stage: 'http_client_request_downgrade',
          reason: 'strip_extended_sampling_fields',
          provider: prepared?.provider,
          model: prepared?.requestBody?.model || body?.model || '',
          requestUrl: prepared?.requestUrl,
          statusCode: extractHttpStatus(e) || null,
          durationMs: Math.max(0, Date.now() - attemptStartedAt)
        });
        try {
          const strippedRequestBody = stripExtendedSamplingFields(prepared.requestBody);
          const response = await axios.post(
            prepared.requestUrl,
            strippedRequestBody,
            getAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal)
          );
          emitHttpSuccessTrace(trace, { ...prepared, requestBody: strippedRequestBody }, body, {
            attempt: i + 1,
            statusCode: Number(response?.status || 0) || null,
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            downgraded: true,
            downgradeReason: 'strip_extended_sampling_fields'
          });
          finishModelCall(callId, {
            response,
            attempts: i + 1,
            requestUrl: prepared.requestUrl,
            request: strippedRequestBody,
            requestHeaders: prepared.requestHeaders
          });
          return response;
        } catch (retryWithoutSamplingError) {
          emitHttpFailureTrace(trace, { ...prepared, requestBody: stripExtendedSamplingFields(prepared.requestBody) }, body, retryWithoutSamplingError, {
            attempt: i + 1,
            retryable: i < maxRetry && shouldRetry(retryWithoutSamplingError),
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            downgraded: true,
            downgradeReason: 'strip_extended_sampling_fields'
          });
          if (callId) {
            failModelCall(callId, retryWithoutSamplingError, {
              attempts: i + 1,
              requestUrl: prepared.requestUrl,
              request: stripExtendedSamplingFields(prepared.requestBody),
              requestHeaders: prepared.requestHeaders
            });
          }
          lastErr = retryWithoutSamplingError;
          if (i >= maxRetry || !shouldRetry(retryWithoutSamplingError)) break;
          const delayMs = getRetryDelayMs(retryWithoutSamplingError, i);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
      }
      if (
        callId
        && prepared?.provider === 'openai_compatible'
        && requestUsesOpenAIPromptCacheRetention(prepared.requestBody)
        && isOpenAIPromptCacheRetentionSchemaError(e)
      ) {
        emitHttpTrace(trace, 'http_client_request_downgrade', {
          stage: 'http_client_request_downgrade',
          reason: 'strip_openai_prompt_cache_retention',
          provider: prepared?.provider,
          model: prepared?.requestBody?.model || body?.model || '',
          requestUrl: prepared?.requestUrl,
          statusCode: extractHttpStatus(e) || null,
          durationMs: Math.max(0, Date.now() - attemptStartedAt)
        });
        try {
          const strippedRequestBody = stripOpenAIPromptCacheRetentionFromRequest(prepared.requestBody);
          const response = await axios.post(
            prepared.requestUrl,
            strippedRequestBody,
            getAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal)
          );
          emitHttpSuccessTrace(trace, { ...prepared, requestBody: strippedRequestBody }, body, {
            attempt: i + 1,
            statusCode: Number(response?.status || 0) || null,
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            downgraded: true,
            downgradeReason: 'strip_openai_prompt_cache_retention'
          });
          finishModelCall(callId, {
            response,
            attempts: i + 1,
            requestUrl: prepared.requestUrl,
            request: strippedRequestBody,
            requestHeaders: prepared.requestHeaders
          });
          return response;
        } catch (retryWithoutRetentionError) {
          const strippedRetentionRequestBody = stripOpenAIPromptCacheRetentionFromRequest(prepared.requestBody);
          if (
            requestUsesOpenAICompatiblePromptCaching(strippedRetentionRequestBody)
            && isOpenAICompatiblePromptCacheSchemaError(retryWithoutRetentionError)
          ) {
            emitHttpTrace(trace, 'http_client_request_downgrade', {
              stage: 'http_client_request_downgrade',
              reason: 'strip_openai_prompt_cache',
              provider: prepared?.provider,
              model: prepared?.requestBody?.model || body?.model || '',
              requestUrl: prepared?.requestUrl,
              statusCode: extractHttpStatus(retryWithoutRetentionError) || null
            });
            try {
              const strippedCacheRequestBody = stripOpenAICompatiblePromptCaching(strippedRetentionRequestBody);
              const response = await axios.post(
                prepared.requestUrl,
                strippedCacheRequestBody,
                getAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal)
              );
              emitHttpSuccessTrace(trace, { ...prepared, requestBody: strippedCacheRequestBody }, body, {
                attempt: i + 1,
                statusCode: Number(response?.status || 0) || null,
                durationMs: Math.max(0, Date.now() - attemptStartedAt),
                downgraded: true,
                downgradeReason: 'strip_openai_prompt_cache'
              });
              finishModelCall(callId, {
                response,
                attempts: i + 1,
                requestUrl: prepared.requestUrl,
                request: strippedCacheRequestBody,
                requestHeaders: prepared.requestHeaders
              });
              return response;
            } catch (retryWithoutCacheError) {
              emitHttpFailureTrace(trace, { ...prepared, requestBody: stripOpenAICompatiblePromptCaching(strippedRetentionRequestBody) }, body, retryWithoutCacheError, {
                attempt: i + 1,
                retryable: i < maxRetry && shouldRetry(retryWithoutCacheError),
                durationMs: Math.max(0, Date.now() - attemptStartedAt),
                downgraded: true,
                downgradeReason: 'strip_openai_prompt_cache'
              });
              if (callId) {
                failModelCall(callId, retryWithoutCacheError, {
                  attempts: i + 1,
                  requestUrl: prepared.requestUrl,
                  request: stripOpenAICompatiblePromptCaching(strippedRetentionRequestBody),
                  requestHeaders: prepared.requestHeaders
                });
              }
              lastErr = retryWithoutCacheError;
              if (i >= maxRetry || !shouldRetry(retryWithoutCacheError)) break;
              const delayMs = getRetryDelayMs(retryWithoutCacheError, i);
              await new Promise((r) => setTimeout(r, delayMs));
              continue;
            }
          }
          if (callId) {
            emitHttpFailureTrace(trace, { ...prepared, requestBody: strippedRetentionRequestBody }, body, retryWithoutRetentionError, {
              attempt: i + 1,
              retryable: i < maxRetry && shouldRetry(retryWithoutRetentionError),
              durationMs: Math.max(0, Date.now() - attemptStartedAt),
              downgraded: true,
              downgradeReason: 'strip_openai_prompt_cache_retention'
            });
            failModelCall(callId, retryWithoutRetentionError, {
              attempts: i + 1,
              requestUrl: prepared.requestUrl,
              request: strippedRetentionRequestBody,
              requestHeaders: prepared.requestHeaders
            });
          }
          lastErr = retryWithoutRetentionError;
          if (i >= maxRetry || !shouldRetry(retryWithoutRetentionError)) break;
          const delayMs = getRetryDelayMs(retryWithoutRetentionError, i);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
      }
      if (
        callId
        && prepared?.provider === 'openai_compatible'
        && requestUsesOpenAICompatiblePromptCaching(prepared.requestBody)
        && isOpenAICompatiblePromptCacheSchemaError(e)
      ) {
        emitHttpTrace(trace, 'http_client_request_downgrade', {
          stage: 'http_client_request_downgrade',
          reason: 'strip_openai_prompt_cache',
          provider: prepared?.provider,
          model: prepared?.requestBody?.model || body?.model || '',
          requestUrl: prepared?.requestUrl,
          statusCode: extractHttpStatus(e) || null,
          durationMs: Math.max(0, Date.now() - attemptStartedAt)
        });
        try {
          const strippedRequestBody = stripOpenAICompatiblePromptCaching(prepared.requestBody);
          const response = await axios.post(
            prepared.requestUrl,
            strippedRequestBody,
            getAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal)
          );
          emitHttpSuccessTrace(trace, { ...prepared, requestBody: strippedRequestBody }, body, {
            attempt: i + 1,
            statusCode: Number(response?.status || 0) || null,
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            downgraded: true,
            downgradeReason: 'strip_openai_prompt_cache'
          });
          finishModelCall(callId, {
            response,
            attempts: i + 1,
            requestUrl: prepared.requestUrl,
            request: strippedRequestBody,
            requestHeaders: prepared.requestHeaders
          });
          return response;
        } catch (retryWithoutCacheError) {
          emitHttpFailureTrace(trace, { ...prepared, requestBody: stripOpenAICompatiblePromptCaching(prepared.requestBody) }, body, retryWithoutCacheError, {
            attempt: i + 1,
            retryable: i < maxRetry && shouldRetry(retryWithoutCacheError),
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            downgraded: true,
            downgradeReason: 'strip_openai_prompt_cache'
          });
          if (callId) {
            failModelCall(callId, retryWithoutCacheError, {
              attempts: i + 1,
              requestUrl: prepared.requestUrl,
              request: stripOpenAICompatiblePromptCaching(prepared.requestBody),
              requestHeaders: prepared.requestHeaders
            });
          }
          lastErr = retryWithoutCacheError;
          if (i >= maxRetry || !shouldRetry(retryWithoutCacheError)) break;
          const delayMs = getRetryDelayMs(retryWithoutCacheError, i);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
      }
      if (
        callId
        && prepared?.provider === 'anthropic'
        && anthropicRequestUsesPromptCaching(prepared.requestBody)
        && isAnthropicPromptCacheSchemaError(e)
      ) {
        emitHttpTrace(trace, 'http_client_request_downgrade', {
          stage: 'http_client_request_downgrade',
          reason: 'strip_anthropic_prompt_cache',
          provider: prepared?.provider,
          model: prepared?.requestBody?.model || body?.model || '',
          requestUrl: prepared?.requestUrl,
          statusCode: extractHttpStatus(e) || null,
          durationMs: Math.max(0, Date.now() - attemptStartedAt)
        });
        try {
          const downgraded = stripAnthropicPromptCaching(prepared.requestBody, prepared.requestHeaders);
          const response = await axios.post(
            prepared.requestUrl,
            downgraded.requestBody,
            getAxiosOptions(prepared.provider, specificKey, timeoutMs, downgraded.requestHeaders, abortSignal)
          );
          emitHttpSuccessTrace(trace, { ...prepared, requestBody: downgraded.requestBody, requestHeaders: downgraded.requestHeaders }, body, {
            attempt: i + 1,
            statusCode: Number(response?.status || 0) || null,
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            downgraded: true,
            downgradeReason: 'strip_anthropic_prompt_cache'
          });
          finishModelCall(callId, {
            response,
            attempts: i + 1,
            requestUrl: prepared.requestUrl,
            request: downgraded.requestBody,
            requestHeaders: downgraded.requestHeaders
          });
          return response;
        } catch (retryWithoutCacheError) {
          const downgraded = stripAnthropicPromptCaching(prepared.requestBody, prepared.requestHeaders);
          emitHttpFailureTrace(trace, { ...prepared, requestBody: downgraded.requestBody, requestHeaders: downgraded.requestHeaders }, body, retryWithoutCacheError, {
            attempt: i + 1,
            retryable: i < maxRetry && shouldRetry(retryWithoutCacheError),
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            downgraded: true,
            downgradeReason: 'strip_anthropic_prompt_cache'
          });
          if (callId) {
            failModelCall(callId, retryWithoutCacheError, {
              attempts: i + 1,
              requestUrl: prepared.requestUrl,
              request: downgraded.requestBody,
              requestHeaders: downgraded.requestHeaders
            });
          }
          lastErr = retryWithoutCacheError;
          if (i >= maxRetry || !shouldRetry(retryWithoutCacheError)) break;
          const delayMs = getRetryDelayMs(retryWithoutCacheError, i);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
      }
      if (callId) {
        failModelCall(callId, e, {
          attempts: i + 1,
          requestUrl: prepared?.requestUrl,
          request: prepared?.requestBody,
          requestHeaders: prepared?.requestHeaders
        });
      }
      lastErr = e;
      if (i >= maxRetry || !shouldRetry(e)) break;

      const delayMs = getRetryDelayMs(e, i);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw lastErr;
}

/**
 * Streaming POST request with retry support.
 * The caller receives raw chunks and handles SSE parsing.
 */
async function postStreamWithRetry(url, body, handlers = {}, retries = 1, specificKey = null) {
  let lastErr;
  const maxRetry = Math.max(0, Number(retries) || 0);
  const onResponse = typeof handlers.onResponse === 'function' ? handlers.onResponse : null;
  const onData = typeof handlers.onData === 'function' ? handlers.onData : null;
  const onDone = typeof handlers.onDone === 'function' ? handlers.onDone : null;
  const abortSignal = body && typeof body === 'object' && body.__abortSignal
    ? body.__abortSignal
    : null;
  if (abortSignal && typeof abortSignal.addEventListener === 'function') {
    abortSignal.addEventListener('abort', () => {
      handlers.__abort_requested = true;
    }, { once: true });
  }
  const trace = body && typeof body === 'object' && body.__trace && typeof body.__trace === 'object'
    ? body.__trace
    : {};
  const streamFailureTraceEmitted = new WeakSet();

  for (let i = 0; i <= maxRetry; i++) {
    let stream = null;
    let callId = '';
    let prepared = null;
    const usageParserState = { buffer: '' };
    let streamUsage = null;
    const attemptStartedAt = Date.now();

    try {
      const timeoutMs = getRetryTimeoutMs(getStreamTimeoutMs(), i, 30000, 300000);
      prepared = await prepareRequest(url, body);
      await validatePreparedEndpoint(prepared.requestUrl);
      const routeDiagnostics = buildModelRouteDiagnostics({
        ...trace,
        provider: prepared.provider,
        apiBaseUrl: prepared.requestUrl,
        model: prepared.requestBody?.model || body?.model || ''
      });
      Object.assign(trace, createModelRouteTracePatch(routeDiagnostics));
      emitHttpTrace(trace, 'http_client_start', {
        stage: 'http_client_start',
        attempt: i + 1,
        maxAttempts: maxRetry + 1,
        provider: prepared.provider,
        model: prepared.requestBody?.model || body?.model || '',
        requestUrl: prepared.requestUrl,
        stream: true,
        cache: buildRequestCacheTrace(prepared.requestBody, prepared.requestHeaders),
        fallbackActive: trace.mainFallbackActive === true,
        fallbackScope: trace.mainFallbackScope || ''
      });
      callId = startModelCall({
        source: trace.source || 'httpClient',
        phase: trace.phase || '',
        purpose: trace.purpose || '',
        requestId: trace.requestId || '',
        phaseSeq: trace.phaseSeq,
        userId: trace.userId || '',
        taskId: trace.taskId || '',
        routePolicyKey: trace.routePolicyKey || '',
        routeDebugKey: trace.routeDebugKey || '',
        topRouteType: trace.topRouteType || '',
        dispatchBranch: trace.dispatchBranch || '',
        triggerBranch: trace.triggerBranch || '',
        apiBaseUrl: trace.apiBaseUrl || prepared.requestUrl,
        apiBaseUrlHost: trace.apiBaseUrlHost || '',
        fallbackReason: trace.fallbackReason || '',
        userRole: trace.userRole || '',
        modelSource: trace.modelSource || '',
        apiBaseUrlSource: trace.apiBaseUrlSource || '',
        apiKeySource: trace.apiKeySource || '',
        mainFallbackScope: trace.mainFallbackScope || '',
        mainFallbackActive: trace.mainFallbackActive === true,
        mainFallbackForced: trace.mainFallbackForced === true,
        modelRouteDiagnostic: trace.modelRouteDiagnostic,
        adminDedicatedModelConfigured: trace.adminDedicatedModelConfigured,
        url: prepared.requestUrl,
        provider: prepared.provider,
        model: prepared.requestBody?.model || body?.model,
        request: prepared.requestBody,
        requestHeaders: prepared.requestHeaders,
        memoryInjected: trace.memoryInjected
      });
      let resp;
      try {
        resp = await axios.post(
          prepared.requestUrl,
          prepared.requestBody,
          getStreamAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal)
        );
        } catch (error) {
        if (requestUsesReasoning(prepared?.requestBody) && isReasoningSchemaError(error)) {
          emitHttpDowngradeTrace(trace, prepared, body, 'strip_reasoning_fields', error, {
            attempt: i + 1,
            durationMs: Math.max(0, Date.now() - attemptStartedAt)
          });
          const strippedRequestBody = stripReasoningFields(prepared.requestBody);
          resp = await axios.post(
            prepared.requestUrl,
            strippedRequestBody,
            getStreamAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal)
          );
          prepared = {
            ...prepared,
            requestBody: strippedRequestBody,
            requestHeaders: prepared.requestHeaders
          };
        } else if (requestUsesExtendedSampling(prepared?.requestBody) && isExtendedSamplingSchemaError(error)) {
          emitHttpDowngradeTrace(trace, prepared, body, 'strip_extended_sampling_fields', error, {
            attempt: i + 1,
            durationMs: Math.max(0, Date.now() - attemptStartedAt)
          });
          const strippedRequestBody = stripExtendedSamplingFields(prepared.requestBody);
          resp = await axios.post(
            prepared.requestUrl,
            strippedRequestBody,
            getStreamAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal)
          );
          prepared = {
            ...prepared,
            requestBody: strippedRequestBody,
            requestHeaders: prepared.requestHeaders
          };
        } else if (
          prepared?.provider === 'openai_compatible'
          && requestUsesOpenAIPromptCacheRetention(prepared.requestBody)
          && isOpenAIPromptCacheRetentionSchemaError(error)
        ) {
          emitHttpDowngradeTrace(trace, prepared, body, 'strip_openai_prompt_cache_retention', error, {
            attempt: i + 1,
            durationMs: Math.max(0, Date.now() - attemptStartedAt)
          });
          const strippedRequestBody = stripOpenAIPromptCacheRetentionFromRequest(prepared.requestBody);
          try {
            resp = await axios.post(
              prepared.requestUrl,
              strippedRequestBody,
              getStreamAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal)
            );
            prepared = {
              ...prepared,
              requestBody: strippedRequestBody,
              requestHeaders: prepared.requestHeaders
            };
          } catch (retryWithoutRetentionError) {
            if (
              requestUsesOpenAICompatiblePromptCaching(strippedRequestBody)
              && isOpenAICompatiblePromptCacheSchemaError(retryWithoutRetentionError)
            ) {
              emitHttpDowngradeTrace(trace, prepared, body, 'strip_openai_prompt_cache', retryWithoutRetentionError, {
                attempt: i + 1,
                durationMs: Math.max(0, Date.now() - attemptStartedAt)
              });
              const strippedCacheRequestBody = stripOpenAICompatiblePromptCaching(strippedRequestBody);
              resp = await axios.post(
                prepared.requestUrl,
                strippedCacheRequestBody,
                getStreamAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal)
              );
              prepared = {
                ...prepared,
                requestBody: strippedCacheRequestBody,
                requestHeaders: prepared.requestHeaders
              };
            } else {
              throw retryWithoutRetentionError;
            }
          }
        } else if (
          prepared?.provider === 'openai_compatible'
          && requestUsesOpenAICompatiblePromptCaching(prepared.requestBody)
          && isOpenAICompatiblePromptCacheSchemaError(error)
        ) {
          emitHttpDowngradeTrace(trace, prepared, body, 'strip_openai_prompt_cache', error, {
            attempt: i + 1,
            durationMs: Math.max(0, Date.now() - attemptStartedAt)
          });
          resp = await axios.post(
            prepared.requestUrl,
            stripOpenAICompatiblePromptCaching(prepared.requestBody),
            getStreamAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal)
          );
          prepared = {
            ...prepared,
            requestBody: stripOpenAICompatiblePromptCaching(prepared.requestBody),
            requestHeaders: prepared.requestHeaders
          };
        } else if (
          prepared?.provider === 'anthropic'
          && anthropicRequestUsesPromptCaching(prepared.requestBody)
          && isAnthropicPromptCacheSchemaError(error)
        ) {
          emitHttpDowngradeTrace(trace, prepared, body, 'strip_anthropic_prompt_cache', error, {
            attempt: i + 1,
            durationMs: Math.max(0, Date.now() - attemptStartedAt)
          });
          const downgraded = stripAnthropicPromptCaching(prepared.requestBody, prepared.requestHeaders);
          resp = await axios.post(
            prepared.requestUrl,
            downgraded.requestBody,
            getStreamAxiosOptions(prepared.provider, specificKey, timeoutMs, downgraded.requestHeaders, abortSignal)
          );
          prepared = {
            ...prepared,
            requestBody: downgraded.requestBody,
            requestHeaders: downgraded.requestHeaders
          };
        } else {
          throw error;
        }
      }
      stream = resp?.data;
      if (!stream || typeof stream.on !== 'function') {
        throw new Error('Streaming response is not a readable stream');
      }

      if (onResponse) onResponse(resp);

      await new Promise((resolve, reject) => {
        let settled = false;
        let firstChunkSeen = false;
        let firstTokenTimer = null;

        const cleanup = () => {
          if (firstTokenTimer) {
            clearTimeout(firstTokenTimer);
            firstTokenTimer = null;
          }
          if (!stream) return;
          stream.removeListener('data', handleData);
          stream.removeListener('end', handleEnd);
          stream.removeListener('close', handleClose);
          stream.removeListener('error', handleError);
        };

        const finish = (err = null) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (err) {
            emitHttpFailureTrace(trace, prepared, body, err, {
              attempt: i + 1,
              retryable: i < maxRetry && shouldRetryStreamRequest(err, handlers),
              durationMs: Math.max(0, Date.now() - attemptStartedAt)
            });
            if (err && typeof err === 'object') streamFailureTraceEmitted.add(err);
            failModelCall(callId, err, { attempts: i + 1, requestUrl: prepared?.requestUrl });
            reject(err);
            return;
          }
          const tailEvents = flushSSEState(usageParserState);
          for (const event of tailEvents) {
            if (!event?.usage) continue;
            streamUsage = mergeUsageObjects(streamUsage, event.usage);
          }
          finishModelCall(callId, {
            response: resp,
            attempts: i + 1,
            usage: streamUsage,
            requestUrl: prepared?.requestUrl,
            request: prepared?.requestBody,
            requestHeaders: prepared?.requestHeaders
          });
          emitHttpSuccessTrace(trace, prepared, body, {
            attempt: i + 1,
            statusCode: Number(resp?.status || 0) || null,
            stream: true,
            durationMs: Math.max(0, Date.now() - attemptStartedAt)
          });
          resolve();
        };

        const handleData = (chunk) => {
          const parsed = extractSSEEvents(usageParserState, chunk);
          usageParserState.buffer = parsed.state.buffer;
          for (const event of parsed.events) {
            if (!event?.usage) continue;
            streamUsage = mergeUsageObjects(streamUsage, event.usage);
          }
          if (!firstChunkSeen) {
            firstChunkSeen = true;
            if (firstTokenTimer) {
              clearTimeout(firstTokenTimer);
              firstTokenTimer = null;
            }
          }
          handlers.__stream_started = true;
          if (onData) onData(chunk);
        };

        const handleEnd = () => {
          if (onDone) onDone();
          finish();
        };

        const handleClose = () => {
          if (settled) return;
          if (onDone) onDone();
          finish();
        };

        const handleError = (err) => {
          finish(err);
        };

        stream.on('data', handleData);
        stream.once('end', handleEnd);
        stream.once('close', handleClose);
        stream.once('error', handleError);
        firstTokenTimer = setTimeout(() => {
          if (firstChunkSeen || settled) return;
          finish(new Error(`Stream first token timeout after ${getFirstTokenTimeoutMs()}ms`));
        }, getFirstTokenTimeoutMs());
      });

      return true;
    } catch (e) {
      if (abortSignal?.aborted) {
        handlers.__abort_requested = true;
      }
      if (!e || typeof e !== 'object' || !streamFailureTraceEmitted.has(e)) {
        emitHttpFailureTrace(trace, prepared, body, e, {
          attempt: i + 1,
          retryable: i < maxRetry && shouldRetryStreamRequest(e, handlers),
          durationMs: Math.max(0, Date.now() - attemptStartedAt)
        });
      }
      if (callId) {
        failModelCall(callId, e, {
          attempts: i + 1,
          requestUrl: prepared?.requestUrl,
          request: prepared?.requestBody,
          requestHeaders: prepared?.requestHeaders
        });
      }
      lastErr = e;
      if (stream && typeof stream.destroy === 'function') {
        try { stream.destroy(); } catch (_) {}
      }
      if (i >= maxRetry || !shouldRetryStreamRequest(e, handlers)) break;

      const delayMs = getRetryDelayMs(e, i);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw lastErr;
}

module.exports = {
  buildAnthropicRequestHeaders,
  buildOpenAICompatibleImageFallbackText,
  buildResponsesRequestBody,
  getAxiosOptions,
  postWithRetry,
  postStreamWithRetry,
  prepareRequest,
  mapMessagesToAnthropic,
  preprocessOpenAICompatibleMessages,
  preprocessOpenAICompatibleMessagesWithoutCache,
  resolveAnthropicImageBlock,
  resolveOpenAICompatibleImagePart
};
