const axios = require('axios');
const config = require('../../../config');
const { CODEX_USER_AGENT } = require('../../../config/userAgentRuntime');
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
const {
  assertSafeHttpUrl,
  assertSafeModelEndpoint,
  resolveSafeModelEndpoint
} = require('../../../utils/networkSafety');
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
  cacheControlUsesAnthropicOneHourTtl,
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
    ...(Array.isArray(config.SYSTEM_PROMPT_BLOCKS)
      ? config.SYSTEM_PROMPT_BLOCKS.map((block) => String(block?.content || '').trim())
      : []),
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

  return -1;
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
  if (extractAnthropicCacheControl(requestBody)) return true;

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
  if (nonEmptyIndexes.length < 2) return -1;

  const historicalIndexes = nonEmptyIndexes.slice(0, -1);

  for (let index = historicalIndexes.length - 1; index >= 0; index -= 1) {
    const candidateIndex = historicalIndexes[index];
    if (isAnthropicAssistantOnlyContextMessage(items[candidateIndex])) continue;
    return candidateIndex;
  }

  return -1;
}

const ANTHROPIC_MAX_CACHE_BREAKPOINTS = 4;

function extractAnthropicToolCacheControl(tool = {}) {
  return extractAnthropicCacheControl(tool) || extractAnthropicCacheControl(tool?.function);
}

function stripAnthropicToolCacheControl(tool = {}) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return tool;
  const stripped = stripCacheControlFields(tool);
  if (stripped.function && typeof stripped.function === 'object' && !Array.isArray(stripped.function)) {
    return {
      ...stripped,
      function: stripCacheControlFields(stripped.function)
    };
  }
  return stripped;
}

function extractAnthropicMessageBreakpointCacheControl(message = {}) {
  const topLevel = extractAnthropicCacheControl(message);
  if (topLevel) return topLevel;

  if (Array.isArray(message?.content)) {
    for (let index = message.content.length - 1; index >= 0; index -= 1) {
      const cacheControl = extractAnthropicCacheControl(message.content[index]);
      if (cacheControl) return cacheControl;
    }
    return null;
  }

  return extractAnthropicCacheControl(message?.content);
}

function stripAnthropicMessageCacheControl(message = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
  const stripped = stripCacheControlFields(message);
  if (Array.isArray(stripped.content)) {
    return {
      ...stripped,
      content: stripped.content.map((block) => (
        block && typeof block === 'object' && !Array.isArray(block)
          ? stripCacheControlFields(block)
          : block
      ))
    };
  }
  if (stripped.content && typeof stripped.content === 'object') {
    return {
      ...stripped,
      content: stripCacheControlFields(stripped.content)
    };
  }
  return stripped;
}

function findLastAnthropicCacheControlIndex(items = [], extractor = extractAnthropicCacheControl) {
  const list = Array.isArray(items) ? items : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (extractor(list[index])) return index;
  }
  return -1;
}

function normalizeAnthropicCacheBreakpointSlots(requestBody = {}) {
  if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) return requestBody;

  let slotsUsed = 0;
  const keepNextExplicit = () => {
    if (slotsUsed >= ANTHROPIC_MAX_CACHE_BREAKPOINTS) return false;
    slotsUsed += 1;
    return true;
  };

  const nextBody = { ...requestBody };

  if (Array.isArray(nextBody.tools)) {
    const toolCacheIndex = findLastAnthropicCacheControlIndex(nextBody.tools, extractAnthropicToolCacheControl);
    nextBody.tools = nextBody.tools.map((tool, index) => {
      const cacheControl = extractAnthropicToolCacheControl(tool);
      const stripped = stripAnthropicToolCacheControl(tool);
      return index === toolCacheIndex && cacheControl && keepNextExplicit()
        ? applyAnthropicCacheControl(stripped, cacheControl)
        : stripped;
    });
  }

  const systemBlocks = normalizeAnthropicSystemBlocks(nextBody.system);
  if (systemBlocks.length > 0) {
    const systemCacheIndex = findLastAnthropicCacheControlIndex(systemBlocks);
    nextBody.system = systemBlocks.map((block, index) => {
      const cacheControl = extractAnthropicCacheControl(block);
      const stripped = stripCacheControlFields(block);
      return index === systemCacheIndex && cacheControl && keepNextExplicit()
        ? applyAnthropicCacheControl(stripped, cacheControl)
        : stripped;
    });
  }

  if (Array.isArray(nextBody.messages)) {
    const messageCacheIndex = findAnthropicAutoCacheMessageIndex(nextBody.messages);
    nextBody.messages = nextBody.messages.map((message, index) => {
      const cacheControl = extractAnthropicMessageBreakpointCacheControl(message);
      const stripped = stripAnthropicMessageCacheControl(message);
      if (index !== messageCacheIndex || !cacheControl || !keepNextExplicit()) return stripped;
      return {
        ...stripped,
        content: applyAnthropicCacheControlToLastBlock(stripped.content, cacheControl)
      };
    });
  }

  const strippedBody = stripCacheControlFields(nextBody);
  return strippedBody;
}

function applyAutoAnthropicPromptCaching(requestBody = {}) {
  if (!isAnthropicPromptCacheEnabled()) return requestBody;

  const defaultCacheControl = normalizeAnthropicCacheControl(true);
  let mutated = false;

  const nextBody = {
    ...requestBody
  };

  const tools = Array.isArray(nextBody.tools) ? nextBody.tools : null;
  const cacheableToolIndexes = tools
    ? tools
        .map((tool, index) => (
          String(tool?.type || '').trim() === 'web_search_20250305' ? -1 : index
        ))
        .filter((index) => index >= 0)
    : [];
  if (
    tools
    && cacheableToolIndexes.length > 0
    && !cacheableToolIndexes.some((index) => toolHasAnthropicCacheControl(tools[index]))
  ) {
    const cacheToolIndex = cacheableToolIndexes[cacheableToolIndexes.length - 1];
    nextBody.tools = tools.map((tool, index) => (
      index === cacheToolIndex
        ? applyAnthropicCacheControl(tool, defaultCacheControl)
        : tool
    ));
    mutated = true;
  }

  const systemBlocks = normalizeAnthropicSystemBlocks(nextBody.system);
  if (systemBlocks.length > 0 && !systemBlocks.some((block) => blockHasAnthropicCacheControl(block))) {
    const systemCacheIndex = findAnthropicAutoCacheSystemBlockIndex(systemBlocks);
    const nextSystemBlocks = applyAnthropicCacheControlToBlockIndex(
      systemBlocks,
      systemCacheIndex,
      defaultCacheControl
    );
    if (nextSystemBlocks.some((block) => blockHasAnthropicCacheControl(block))) {
      nextBody.system = nextSystemBlocks;
      mutated = true;
    } else if (anthropicSystemUsesArray(nextBody.system)) {
      nextBody.system = systemBlocks;
    }
  } else if (anthropicSystemUsesArray(nextBody.system)) {
    nextBody.system = systemBlocks;
  }

  const messages = Array.isArray(nextBody.messages) ? nextBody.messages : [];
  const messageIndex = findAnthropicAutoCacheMessageIndex(messages);
  if (messageIndex >= 0 && !messageContentHasAnthropicCacheControl(messages[messageIndex])) {
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

  const normalized = normalizeAnthropicCacheBreakpointSlots(nextBody);
  return mutated || normalized !== nextBody ? normalized : requestBody;
}

function buildAnthropicRequestHeaders(requestBody = {}) {
  if (!anthropicRequestUsesPromptCaching(requestBody)) return null;

  const betaFlags = ['prompt-caching-2024-07-31'];
  const headers = {
    'X-Enable-1h-cache': '1'
  };
  if (cacheControlUsesAnthropicOneHourTtl(requestBody)) {
    betaFlags.push('extended-cache-ttl-2025-04-11');
  }

  headers['anthropic-beta'] = mergeAnthropicBetaHeader(
    config.ANTHROPIC_BETA,
    betaFlags
  );
  return headers;
}

function stripPromptCachingBetaHeaderValue(headerValue = '') {
  return String(headerValue || '')
    .split(',')
    .map((part) => normalizeText(part))
    .filter((part) => {
      const normalized = part.toLowerCase();
      return part
        && normalized !== 'prompt-caching-2024-07-31'
        && normalized !== 'extended-cache-ttl-2025-04-11';
    })
    .join(',');
}

function stripPromptCachingBetaHeader(requestHeaders = null) {
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
  delete nextHeaders['X-Enable-1h-cache'];
  delete nextHeaders['x-enable-1h-cache'];
  return Object.keys(nextHeaders).length > 0 ? nextHeaders : null;
}

function rebuildAnthropicPromptCachingHeaders(requestBody = {}, requestHeaders = null) {
  const baseHeaders = stripPromptCachingBetaHeader(requestHeaders) || {};
  const promptCachingHeaders = buildAnthropicRequestHeaders(requestBody) || {};
  const nextHeaders = {
    ...baseHeaders,
    ...promptCachingHeaders
  };
  const beta = mergeAnthropicBetaHeader(
    baseHeaders['anthropic-beta'] || baseHeaders['Anthropic-Beta'],
    String(promptCachingHeaders['anthropic-beta'] || promptCachingHeaders['Anthropic-Beta'] || '').split(',')
  );
  delete nextHeaders['Anthropic-Beta'];
  if (beta) nextHeaders['anthropic-beta'] = beta;
  return Object.keys(nextHeaders).length > 0 ? nextHeaders : null;
}

function stripAnthropicAutomaticPromptCaching(requestBody = {}, requestHeaders = null) {
  if (!requestBody || typeof requestBody !== 'object') {
    return {
      requestBody,
      requestHeaders: requestHeaders && typeof requestHeaders === 'object' ? { ...requestHeaders } : requestHeaders
    };
  }

  const nextBody = stripCacheControlFields({ ...requestBody });
  return {
    requestBody: nextBody,
    requestHeaders: anthropicRequestUsesPromptCaching(nextBody)
      ? rebuildAnthropicPromptCachingHeaders(nextBody, requestHeaders)
      : stripPromptCachingBetaHeader(requestHeaders)
  };
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

  return {
    requestBody: nextBody,
    requestHeaders: stripPromptCachingBetaHeader(requestHeaders)
  };
}

function clampTemperatureForProvider(provider, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (provider === 'anthropic') return Math.max(0, Math.min(1, n));
  return Math.max(0, Math.min(2, n));
}

module.exports = {
  ANTHROPIC_ASSISTANT_CONTEXT_PREFIX,
  ANTHROPIC_DYNAMIC_SYSTEM_MARKERS,
  ANTHROPIC_MAX_CACHE_BREAKPOINTS,
  ANTHROPIC_STABLE_SYSTEM_TEXTS,
  OPENAI_IMAGE_DETAIL_VALUES,
  appendRequestTraceEvent,
  applyAnthropicCacheControl,
  applyAnthropicCacheControlToBlockIndex,
  applyAnthropicCacheControlToLastBlock,
  applyAutoAnthropicPromptCaching,
  anthropicRequestUsesPromptCaching,
  anthropicSystemUsesArray,
  assertSafeHttpUrl,
  assertSafeModelEndpoint,
  resolveSafeModelEndpoint,
  axios,
  blockHasAnthropicCacheControl,
  buildAnthropicRequestHeaders,
  buildModelRouteDiagnostics,
  CODEX_USER_AGENT,
  clampTemperatureForProvider,
  coerceTrailingAnthropicAssistantContextToUser,
  config,
  createModelRouteTracePatch,
  ensureAnthropicMessagesUrl,
  extractAnthropicCacheControl,
  extractErrorCode,
  extractAnthropicMessageCacheControl,
  extractAnthropicMessageText,
  extractHttpStatus,
  extractInputMessageText,
  extractSSEEvents,
  failModelCall,
  findAnthropicAutoCacheMessageIndex,
  findAnthropicAutoCacheSystemBlockIndex,
  finishModelCall,
  flushSSEState,
  getApiProvider,
  HUMANIZER_SYSTEM_PROMPT,
  HttpsProxyAgentCtor,
  isAnthropicAssistantOnlyContextMessage,
  isAnthropicAssistantOnlyContextText,
  isAnthropicDynamicSystemContextText,
  isAnthropicPromptCacheEnabled,
  isAnthropicProvider,
  isAnthropicStableSystemText,
  isGeminiNativeProvider,
  isOpenAICompatibleProvider,
  isTopPEnabled,
  mergeAnthropicBetaHeader,
  mergeUsageObjects,
  messageContentHasAnthropicCacheControl,
  messageHasAnthropicContent,
  normalizeAnthropicCacheControl,
  normalizeAnthropicSystemBlocks,
  normalizeJsonObject,
  normalizeProviderRequestHeaders,
  normalizeText,
  nextTracePhase,
  parseCacheRef,
  providerAllowsCacheControl,
  providerAllowsOpenAIPromptCache,
  readCachedImagePayload,
  serializeAnthropicToolResultContent,
  splitAnthropicStableSystemText,
  startModelCall,
  stripAnthropicCacheControlFromBlocks,
  stripAnthropicAutomaticPromptCaching,
  stripAnthropicPromptCaching,
  stripCacheControlFields,
  stripCacheControlFieldsDeep,
  stripOpenAIPromptCacheFields,
  stripOpenAIPromptCacheRetention,
  stripPromptCachingBetaHeader,
  stripPromptCachingBetaHeaderValue,
  stripTopPField,
  toolHasAnthropicCacheControl
};

