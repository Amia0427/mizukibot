const axios = require('axios');
const config = require('../config');
const { getApiProvider, ensureAnthropicMessagesUrl } = require('../utils/modelProvider');
const { parseCacheRef, readCachedImagePayload } = require('../utils/imageInputCache');
const { HUMANIZER_SYSTEM_PROMPT } = require('../utils/humanizer');
const {
  startModelCall,
  finishModelCall,
  failModelCall
} = require('../utils/modelCallTracker');
const { extractSSEEvents, flushSSEState, mergeUsageObjects } = require('./parser');

let HttpsProxyAgentCtor = null;
try {
  const mod = require('https-proxy-agent');
  HttpsProxyAgentCtor = mod.HttpsProxyAgent || mod;
} catch (_) {}

function normalizeText(value) {
  return String(value || '').trim();
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

function pickAnthropicPromptCacheTtl() {
  const ttl = normalizeText(process.env.ANTHROPIC_PROMPT_CACHE_TTL || '5m').toLowerCase();
  return ttl === '1h' ? '1h' : '5m';
}

function isAnthropicPromptCacheEnabled() {
  const raw = normalizeText(process.env.ANTHROPIC_PROMPT_CACHE_ENABLED).toLowerCase();
  if (!raw) return true;
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function normalizeAnthropicCacheControl(value) {
  if (value === true) {
    return {
      type: 'ephemeral',
      ttl: pickAnthropicPromptCacheTtl()
    };
  }

  if (typeof value === 'string') {
    const normalized = normalizeText(value).toLowerCase();
    if (!normalized) return null;
    if (normalized === 'ephemeral') {
      return {
        type: 'ephemeral',
        ttl: pickAnthropicPromptCacheTtl()
      };
    }
    if (normalized === '5m' || normalized === '1h') {
      return {
        type: 'ephemeral',
        ttl: normalized
      };
    }
    return null;
  }

  if (!value || typeof value !== 'object') return null;

  const type = normalizeText(value.type || 'ephemeral').toLowerCase();
  if (type !== 'ephemeral') return null;

  const ttl = normalizeText(value.ttl || pickAnthropicPromptCacheTtl()).toLowerCase();
  return {
    type: 'ephemeral',
    ttl: ttl === '1h' ? '1h' : '5m'
  };
}

function extractAnthropicCacheControl(value) {
  if (!value || typeof value !== 'object') {
    return normalizeAnthropicCacheControl(value);
  }

  return (
    normalizeAnthropicCacheControl(value.cache_control)
    || normalizeAnthropicCacheControl(value.cacheControl)
    || normalizeAnthropicCacheControl(value.cache)
    || null
  );
}

function applyAnthropicCacheControl(target, cacheControl) {
  const normalized = normalizeAnthropicCacheControl(cacheControl);
  if (!normalized || !target || typeof target !== 'object') return target;
  return {
    ...target,
    cache_control: normalized
  };
}

function applyAnthropicCacheControlToLastBlock(blocks, cacheControl) {
  const normalized = normalizeAnthropicCacheControl(cacheControl);
  const items = Array.isArray(blocks) ? blocks : [];
  if (!normalized || items.length === 0) return items;

  const lastIndex = items.length - 1;
  return items.map((block, index) => (
    index === lastIndex
      ? applyAnthropicCacheControl(block, normalized)
      : block
  ));
}

function blockHasAnthropicCacheControl(block) {
  return Boolean(extractAnthropicCacheControl(block));
}

function toolHasAnthropicCacheControl(tool) {
  return Boolean(
    extractAnthropicCacheControl(tool)
    || extractAnthropicCacheControl(tool?.function)
  );
}

function mergeAnthropicBetaHeader(baseValue = '', requiredValues = []) {
  const merged = [];
  const seen = new Set();

  for (const part of String(baseValue || '').split(',')) {
    const normalized = normalizeText(part);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
  }

  for (const part of requiredValues) {
    const normalized = normalizeText(part);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
  }

  return merged.join(',');
}

function serializeAnthropicToolResultContent(blocks = []) {
  const items = Array.isArray(blocks) ? blocks : [];
  if (items.length === 0) return '(empty tool result)';
  if (
    items.length === 1
    && items[0]?.type === 'text'
    && !blockHasAnthropicCacheControl(items[0])
  ) {
    return String(items[0].text || '') || '(empty tool result)';
  }
  return items;
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
    String(require('../utils/promptSecurity').buildSecuritySystemPrompt?.() || '').trim(),
    String(require('../utils/personaModules').loadPersonaModuleText?.('core_baseline') || '').trim()
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

  return lastNonEmptyIndex;
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
  if (systemBlocks.length > 0 && !systemBlocks.some((block) => blockHasAnthropicCacheControl(block))) {
    nextBody.system = applyAnthropicCacheControlToBlockIndex(
      systemBlocks,
      findAnthropicAutoCacheSystemBlockIndex(systemBlocks),
      defaultCacheControl
    );
    mutated = true;
  } else if (anthropicSystemUsesArray(nextBody.system)) {
    nextBody.system = systemBlocks;
  }

  const messages = Array.isArray(nextBody.messages) ? nextBody.messages : [];
  if (!messages.some((message) => messageContentHasAnthropicCacheControl(message))) {
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

function clampTemperatureForProvider(provider, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (provider === 'anthropic') return Math.max(0, Math.min(1, n));
  return Math.max(0, Math.min(2, n));
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

function isQqImageUrl(url = '') {
  return /multimedia\.nt\.qq\.com\.cn\//i.test(String(url || '').trim());
}

function normalizeOpenAIImageDetail(value) {
  const normalized = normalizeText(value).toLowerCase();
  return OPENAI_IMAGE_DETAIL_VALUES.has(normalized) ? normalized : '';
}

function sanitizeOpenAICompatibleContentPart(part) {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return part;
  if (!part.image_url || typeof part.image_url !== 'object' || Array.isArray(part.image_url)) return part;

  const imageUrl = { ...part.image_url };
  const detail = normalizeOpenAIImageDetail(imageUrl.detail);
  if (detail) imageUrl.detail = detail;
  else delete imageUrl.detail;

  return {
    ...part,
    image_url: imageUrl
  };
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
  const cachedImage = parseCacheRef(imageUrl) ? readCachedImagePayload(imageUrl) : null;
  if (cachedImage?.data) {
    return {
      type: 'image_url',
      image_url: {
        url: `data:${cachedImage.mediaType || 'image/jpeg'};base64,${cachedImage.data}`,
        ...(imageDetail ? { detail: imageDetail } : {})
      }
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
      text: isQqImageUrl(imageUrl)
        ? '[Image unavailable: QQ image link expired or requires access.]'
        : `[Image URL] ${imageUrl}`
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
  const cachedImage = parseCacheRef(imageUrl) ? readCachedImagePayload(imageUrl) : null;
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

  try {
    const resp = await axios.get(imageUrl, {
      ...getAxiosOptions('openai_compatible', null, Math.min(getRequestTimeoutMs(), 20000)),
      responseType: 'arraybuffer'
    });
    const mediaType = inferImageMediaType(imageUrl, resp?.headers || {});
    const data = Buffer.from(resp.data).toString('base64');
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
      text: isQqImageUrl(imageUrl)
        ? '[Image unavailable: QQ image link expired or requires access.]'
        : `[Image URL] ${imageUrl}`
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
          extractAnthropicCacheControl(item) || true
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
        extractAnthropicCacheControl(item)
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
          }, extractAnthropicCacheControl(item))
        ]
      });
      continue;
    }

    if (role === 'assistant') {
      let blocks = await toAnthropicContentBlocks(item?.content);
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

      blocks = applyAnthropicCacheControlToLastBlock(blocks, extractAnthropicCacheControl(item));

      out.push({
        role: 'assistant',
        content: blocks.length ? blocks : [{ type: 'text', text: '' }]
      });
      continue;
    }

    const userBlocks = applyAnthropicCacheControlToLastBlock(
      await toAnthropicContentBlocks(item?.content),
      extractAnthropicCacheControl(item)
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
  const mapped = await mapMessagesToAnthropic(body.messages);
  const maxTokens = Number(body.max_tokens);

  const requestBody = {
    model: normalizeText(body.model) || normalizeText(config.AI_MODEL) || 'claude-3-5-sonnet-latest',
    max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 1024,
    messages: mapped.messages,
    stream: Boolean(body.stream)
  };

  if (mapped.system.length > 0) requestBody.system = mapped.system;

  const temperature = clampTemperatureForProvider('anthropic', body.temperature);
  if (temperature !== null) requestBody.temperature = temperature;

  const topP = Number(body.top_p);
  if (Number.isFinite(topP)) requestBody.top_p = topP;

  if (Array.isArray(body.stop)) {
    const stops = body.stop.map((x) => String(x || '').trim()).filter(Boolean);
    if (stops.length) requestBody.stop_sequences = stops;
  }

  if (Array.isArray(body.tools)) {
    const tools = body.tools
      .map(mapToolSchemaToAnthropic)
      .filter(Boolean);
    if (tools.length) {
      requestBody.tools = tools;
      const choice = mapToolChoiceToAnthropic(body.tool_choice);
      if (choice) requestBody.tool_choice = choice;
    }
  }

  return applyAutoAnthropicPromptCaching(requestBody);
}

async function prepareRequest(url, body = {}) {
  const provider = getApiProvider(url, body?.model || config.AI_MODEL);
  if (provider !== 'anthropic') {
    const requestBody = body && typeof body === 'object'
      ? { ...body }
      : body;
    if (requestBody && Array.isArray(requestBody.messages)) {
      requestBody.messages = await preprocessOpenAICompatibleMessages(requestBody.messages);
    }
    return {
      provider,
      requestUrl: url,
      requestBody
    };
  }

  const requestBody = await buildAnthropicRequestBody(body);
  return {
    provider,
    requestUrl: ensureAnthropicMessagesUrl(url),
    requestBody,
    requestHeaders: buildAnthropicRequestHeaders(requestBody)
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
    config.HTTP_USER_AGENT
      || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
  ).trim();
  const acceptLanguage = String(config.HTTP_ACCEPT_LANGUAGE || 'zh-CN,zh;q=0.9,en;q=0.8').trim();
  if (provider === 'anthropic') {
    const headers = {
      'x-api-key': apiKey,
      'anthropic-version': config.ANTHROPIC_VERSION || '2023-06-01',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': acceptLanguage,
      'User-Agent': userAgent
    };
    if (config.ANTHROPIC_BETA) {
      headers['anthropic-beta'] = String(config.ANTHROPIC_BETA).trim();
    }
    if (extraHeaders && typeof extraHeaders === 'object') {
      Object.assign(headers, extraHeaders);
    }
    return headers;
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
  return headers;
}

function getAxiosOptions(provider = 'openai_compatible', specificKey = null, timeoutMs = null, extraHeaders = null) {
  const options = {
    headers: getHeaders(provider, specificKey, extraHeaders),
    timeout: Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : getRequestTimeoutMs(),
    proxy: false,
    responseType: 'text'
  };

  if (config.PROXY_URL && HttpsProxyAgentCtor) {
    options.httpsAgent = new HttpsProxyAgentCtor(config.PROXY_URL);
  }
  return options;
}

function getStreamAxiosOptions(provider = 'openai_compatible', specificKey = null, timeoutMs = null, extraHeaders = null) {
  return {
    ...getAxiosOptions(
      provider,
      specificKey,
      Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : getStreamTimeoutMs(),
      extraHeaders
    ),
    responseType: 'stream'
  };
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

  for (let i = 0; i <= maxRetry; i++) {
    let callId = '';
    try {
      const timeoutBase = Number.isFinite(requestedTimeoutMs)
        ? Math.max(1000, Math.floor(requestedTimeoutMs))
        : getRequestTimeoutMs();
      const timeoutCap = Number.isFinite(requestedTimeoutMs)
        ? Math.max(timeoutBase, timeoutBase + (15000 * Math.max(0, maxRetry)))
        : 180000;
      const timeoutMs = getRetryTimeoutMs(timeoutBase, i, 15000, timeoutCap);
      const prepared = await prepareRequest(url, body);
      callId = startModelCall({
        source: trace.source || 'httpClient',
        phase: trace.phase || '',
        purpose: trace.purpose || '',
        userId: trace.userId || '',
        taskId: trace.taskId || '',
        routePolicyKey: trace.routePolicyKey || '',
        topRouteType: trace.topRouteType || '',
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
        getAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders)
      );
      finishModelCall(callId, { response, attempts: i + 1 });
      return response;
    } catch (e) {
      if (callId) failModelCall(callId, e, { attempts: i + 1 });
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
  const trace = body && typeof body === 'object' && body.__trace && typeof body.__trace === 'object'
    ? body.__trace
    : {};

  for (let i = 0; i <= maxRetry; i++) {
    let stream = null;
    let callId = '';
    const usageParserState = { buffer: '' };
    let streamUsage = null;

    try {
      const timeoutMs = getRetryTimeoutMs(getStreamTimeoutMs(), i, 30000, 300000);
      const prepared = await prepareRequest(url, body);
      callId = startModelCall({
        source: trace.source || 'httpClient',
        phase: trace.phase || '',
        purpose: trace.purpose || '',
        userId: trace.userId || '',
        taskId: trace.taskId || '',
        routePolicyKey: trace.routePolicyKey || '',
        topRouteType: trace.topRouteType || '',
        url: prepared.requestUrl,
        provider: prepared.provider,
        model: prepared.requestBody?.model || body?.model,
        request: prepared.requestBody,
        requestHeaders: prepared.requestHeaders,
        memoryInjected: trace.memoryInjected
      });
      const resp = await axios.post(
        prepared.requestUrl,
        prepared.requestBody,
        getStreamAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders)
      );
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
            failModelCall(callId, err, { attempts: i + 1 });
            reject(err);
            return;
          }
          const tailEvents = flushSSEState(usageParserState);
          for (const event of tailEvents) {
            if (!event?.usage) continue;
            streamUsage = mergeUsageObjects(streamUsage, event.usage);
          }
          finishModelCall(callId, { response: resp, attempts: i + 1, usage: streamUsage });
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
      if (callId) failModelCall(callId, e, { attempts: i + 1 });
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
  postWithRetry,
  postStreamWithRetry,
  prepareRequest,
  mapMessagesToAnthropic
};

