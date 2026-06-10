const { normalizeText, safeClone } = require('./common');

function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const promptTokens = Number(
    raw.prompt_tokens
    ?? raw.input_tokens
    ?? raw.promptTokens
    ?? raw.inputTokens
    ?? raw.input_token_count
  );
  const completionTokens = Number(
    raw.completion_tokens
    ?? raw.output_tokens
    ?? raw.completionTokens
    ?? raw.outputTokens
    ?? raw.output_token_count
  );
  const totalTokens = Number(
    raw.total_tokens
    ?? raw.totalTokens
  );
  const cacheReadInputTokens = Number(
    raw.cache_read_input_tokens
    ?? raw.cacheReadInputTokens
    ?? raw.prompt_cache_hit_tokens
    ?? raw.promptCacheHitTokens
    ?? raw.prompt_tokens_details?.cached_tokens
    ?? raw.promptTokensDetails?.cachedTokens
    ?? raw.input_tokens_details?.cached_tokens
    ?? raw.inputTokensDetails?.cachedTokens
  );
  const cacheCreationInputTokens = Number(
    raw.cache_creation_input_tokens
    ?? raw.cacheCreationInputTokens
    ?? raw.prompt_cache_miss_tokens
    ?? raw.promptCacheMissTokens
    ?? raw.prompt_tokens_details?.cache_write_tokens
    ?? raw.promptTokensDetails?.cacheWriteTokens
    ?? raw.input_tokens_details?.cache_write_tokens
    ?? raw.inputTokensDetails?.cacheWriteTokens
  );
  const cacheCreation = raw.cache_creation && typeof raw.cache_creation === 'object'
    ? safeClone(raw.cache_creation, {})
    : null;

  const hasPrompt = Number.isFinite(promptTokens);
  const hasCompletion = Number.isFinite(completionTokens);
  const hasTotal = Number.isFinite(totalTokens);
  const hasCacheRead = Number.isFinite(cacheReadInputTokens);
  const hasCacheCreation = Number.isFinite(cacheCreationInputTokens) || Boolean(cacheCreation);
  if (!hasPrompt && !hasCompletion && !hasTotal && !hasCacheRead && !hasCacheCreation) return null;

  return {
    prompt_tokens: hasPrompt ? Math.floor(promptTokens) : null,
    completion_tokens: hasCompletion ? Math.floor(completionTokens) : null,
    cache_read_input_tokens: hasCacheRead ? Math.floor(cacheReadInputTokens) : null,
    cache_creation_input_tokens: Number.isFinite(cacheCreationInputTokens) ? Math.floor(cacheCreationInputTokens) : null,
    cache_creation: cacheCreation,
    total_tokens: hasTotal
      ? Math.floor(totalTokens)
      : ((hasPrompt || hasCompletion)
        ? Math.floor((hasPrompt ? promptTokens : 0) + (hasCompletion ? completionTokens : 0))
        : null)
  };
}

function extractUsage(response) {
  const data = response?.data ?? response;
  return (
    normalizeUsage(data?.usage)
    || normalizeUsage(data?.response_metadata?.usage)
    || normalizeUsage(data?.response_metadata?.tokenUsage)
    || normalizeUsage(data?.usage_metadata)
    || null
  );
}

function extractResponseModel(response) {
  const data = response?.data ?? response;
  return normalizeText(
    data?.model
    || data?.model_name
    || data?.response_metadata?.model_name
    || data?.response_metadata?.model
  );
}

function extractFinishReason(response) {
  const data = response?.data ?? response;
  if (!data || typeof data !== 'object') return '';
  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  const candidate = Array.isArray(data.candidates) ? data.candidates[0] : null;
  const incompleteDetails = data.incomplete_details || data.incompleteDetails;
  const incompleteReason = normalizeText(incompleteDetails?.reason);
  const direct = normalizeText(
    choice?.finish_reason
    || choice?.finishReason
    || candidate?.finishReason
    || candidate?.finish_reason
    || data.finish_reason
    || data.finishReason
    || data.stop_reason
    || data.stopReason
    || data.status
  );
  if (incompleteReason) return direct ? `${direct}:${incompleteReason}` : `incomplete:${incompleteReason}`;
  return direct;
}

module.exports = {
  extractResponseModel,
  extractFinishReason,
  extractUsage,
  normalizeUsage
};
