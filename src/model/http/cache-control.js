const {
  isAnthropicProvider,
  isOpenAICompatibleProvider
} = require('../../../utils/modelProvider');

function normalizeText(value) {
  return String(value || '').trim();
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

function stripCacheControlFields(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return target;
  const next = { ...target };
  delete next.cache_control;
  delete next.cacheControl;
  delete next.cache;
  return next;
}

const CACHE_FIELD_SCHEMA_RECURSION_STOP_KEYS = new Set([
  'additionalProperties',
  'definitions',
  '$defs',
  'enum',
  'items',
  'json_schema',
  'parameters',
  'properties',
  'required',
  'schema',
  'input_schema'
]);

function stripCacheControlFieldsDeep(target) {
  if (Array.isArray(target)) {
    return target.map((item) => stripCacheControlFieldsDeep(item));
  }
  if (!target || typeof target !== 'object') return target;

  const next = stripCacheControlFields(target);
  for (const [key, value] of Object.entries(next)) {
    if (CACHE_FIELD_SCHEMA_RECURSION_STOP_KEYS.has(key)) continue;
    if (Array.isArray(value) || (value && typeof value === 'object')) {
      next[key] = stripCacheControlFieldsDeep(value);
    }
  }
  return next;
}

function stripOpenAIPromptCacheFields(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return target;
  const next = { ...target };
  delete next.prompt_cache_key;
  delete next.prompt_cache_retention;
  return next;
}

function providerAllowsOpenAIPromptCache(provider = '') {
  return isOpenAICompatibleProvider(provider);
}

function providerAllowsCacheControl(provider = '') {
  return isAnthropicProvider(provider) || isOpenAICompatibleProvider(provider);
}

function stripOpenAIPromptCacheRetention(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return target;
  const next = { ...target };
  delete next.prompt_cache_retention;
  return next;
}

function stripAnthropicCacheControlFromBlocks(blocks = []) {
  const items = Array.isArray(blocks) ? blocks : [];
  return items.map((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return block;
    const nextBlock = stripCacheControlFields(block);
    if (Array.isArray(nextBlock.content)) {
      return {
        ...nextBlock,
        content: stripAnthropicCacheControlFromBlocks(nextBlock.content)
      };
    }
    return nextBlock;
  });
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

function cacheControlUsesAnthropicOneHourTtl(value) {
  if (Array.isArray(value)) {
    return value.some((item) => cacheControlUsesAnthropicOneHourTtl(item));
  }
  if (!value || typeof value !== 'object') return false;

  const cacheControl = extractAnthropicCacheControl(value);
  if (cacheControl?.ttl === '1h') return true;

  return cacheControlUsesAnthropicOneHourTtl(value.content)
    || cacheControlUsesAnthropicOneHourTtl(value.function)
    || cacheControlUsesAnthropicOneHourTtl(value.system)
    || cacheControlUsesAnthropicOneHourTtl(value.messages)
    || cacheControlUsesAnthropicOneHourTtl(value.tools);
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

module.exports = {
  applyAnthropicCacheControl,
  applyAnthropicCacheControlToLastBlock,
  blockHasAnthropicCacheControl,
  cacheControlUsesAnthropicOneHourTtl,
  extractAnthropicCacheControl,
  isAnthropicPromptCacheEnabled,
  mergeAnthropicBetaHeader,
  normalizeAnthropicCacheControl,
  pickAnthropicPromptCacheTtl,
  providerAllowsCacheControl,
  providerAllowsOpenAIPromptCache,
  serializeAnthropicToolResultContent,
  stripAnthropicCacheControlFromBlocks,
  stripCacheControlFields,
  stripCacheControlFieldsDeep,
  stripOpenAIPromptCacheFields,
  stripOpenAIPromptCacheRetention,
  toolHasAnthropicCacheControl
};
