const { normalizeText } = require('./common');

function hasCacheControl(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && (
      String(value.type || '').trim().toLowerCase() === 'ephemeral'
      || (
        value.cache_control
        && typeof value.cache_control === 'object'
        && String(value.cache_control.type || '').trim()
      )
    )
  );
}

function countCacheControlBlocks(value) {
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + countCacheControlBlocks(item), 0);
  }
  if (!value || typeof value !== 'object') return 0;

  let total = hasCacheControl(value) ? 1 : 0;
  if (Array.isArray(value.content)) {
    total += value.content.reduce((sum, item) => sum + countCacheControlBlocks(item), 0);
  }
  if (value.function && typeof value.function === 'object') {
    total += countCacheControlBlocks(value.function);
  }
  return total;
}

function summarizePromptCaching(request = {}, requestHeaders = {}) {
  const headers = requestHeaders && typeof requestHeaders === 'object' ? requestHeaders : {};
  const anthropicBeta = String(headers['anthropic-beta'] || headers['Anthropic-Beta'] || '').trim();
  const systemBlocks = Array.isArray(request.system) ? request.system : [];
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const anthropicBetaFlags = anthropicBeta
    ? anthropicBeta.toLowerCase().split(',').map((part) => part.trim()).filter(Boolean)
    : [];

  const requestCacheBreakpoints = countCacheControlBlocks(request.cache_control);
  const systemCacheBreakpoints = systemBlocks.reduce((sum, item) => sum + countCacheControlBlocks(item), 0);
  const messageCacheBreakpoints = messages.reduce((sum, item) => sum + countCacheControlBlocks(item), 0);
  const toolCacheBreakpoints = tools.reduce((sum, item) => sum + countCacheControlBlocks(item), 0);

  return {
    openai_prompt_cache_key: normalizeText(request.prompt_cache_key),
    openai_prompt_cache_retention: normalizeText(request.prompt_cache_retention),
    openai_prompt_cache_enabled: Boolean(
      normalizeText(request.prompt_cache_key)
      || normalizeText(request.prompt_cache_retention)
    ),
    anthropic_beta: anthropicBeta || null,
    prompt_caching_beta_enabled: anthropicBetaFlags.includes('prompt-caching-2024-07-31'),
    request_cache_breakpoints: requestCacheBreakpoints,
    system_cache_breakpoints: systemCacheBreakpoints,
    message_cache_breakpoints: messageCacheBreakpoints,
    tool_cache_breakpoints: toolCacheBreakpoints,
    total_cache_breakpoints: requestCacheBreakpoints + systemCacheBreakpoints + messageCacheBreakpoints + toolCacheBreakpoints
  };
}

module.exports = {
  countCacheControlBlocks,
  hasCacheControl,
  summarizePromptCaching
};
