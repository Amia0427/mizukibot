const { normalizeText } = require('./common');

const PROMPT_TOKEN_WARNING_THRESHOLD = 50000;
const PROMPT_TOKEN_HARD_LIMIT = 100000;

function flattenContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => flattenContentText(part)).join('\n');
  }
  if (!content || typeof content !== 'object') return '';
  if (typeof content.text === 'string') return content.text;
  if (typeof content.content === 'string') return content.content;
  if (Array.isArray(content.content)) return flattenContentText(content.content);
  if (content.type === 'image_url') {
    return String(content?.image_url?.url || content?.url || '');
  }
  return '';
}

function estimatePromptTokens(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  let cjkChars = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x3400 && code <= 0x9fff) cjkChars += 1;
  }
  const latinChars = text.length - cjkChars;
  return cjkChars + Math.ceil(Math.max(0, latinChars) / 4);
}

function estimateContentTokens(content) {
  return estimatePromptTokens(flattenContentText(content));
}

function summarizePromptTokenBudget(request = {}, combinedText = '') {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const systemTokens = estimateContentTokens(request.system);
  const messageRows = messages.map((msg, index) => {
    const role = normalizeText(msg?.role).toLowerCase() || 'unknown';
    const tokens = estimateContentTokens(msg?.content);
    return {
      index,
      role,
      tokens
    };
  });
  const messageTokens = messageRows.reduce((sum, row) => sum + row.tokens, 0);
  const toolTokens = Array.isArray(request.tools)
    ? estimatePromptTokens(JSON.stringify(request.tools))
    : 0;
  const totalEstimatedTokens = systemTokens + messageTokens + toolTokens;
  const largestMessages = messageRows
    .filter((row) => row.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens || a.index - b.index)
    .slice(0, 5);
  const warningThreshold = Math.max(0, Number(request.__promptTokenWarningThreshold || PROMPT_TOKEN_WARNING_THRESHOLD) || PROMPT_TOKEN_WARNING_THRESHOLD);
  const hardLimit = Math.max(0, Number(request.__promptTokenHardLimit || PROMPT_TOKEN_HARD_LIMIT) || PROMPT_TOKEN_HARD_LIMIT);

  return {
    estimated_input_tokens: totalEstimatedTokens,
    estimated_text_tokens: estimatePromptTokens(combinedText),
    estimated_system_tokens: systemTokens,
    estimated_message_tokens: messageTokens,
    estimated_tool_tokens: toolTokens,
    warning_threshold_tokens: warningThreshold,
    hard_limit_tokens: hardLimit,
    over_warning_threshold: warningThreshold > 0 && totalEstimatedTokens >= warningThreshold,
    over_hard_limit: hardLimit > 0 && totalEstimatedTokens >= hardLimit,
    largest_messages: largestMessages
  };
}

function containsMemoryMarker(text) {
  const input = String(text || '');
  if (!input) return false;
  return /\[(?:Memory|Profile|Summary|RetrievedMemoryLite|RetrievedMemory|DailyJournal|TaskMemory|GroupMemory|StyleSignals|ShortTermContinuity|MemOSRecall|LongTermProfile|Impression|ContinuityState)\]|长期记忆|记忆注入/i.test(input);
}

function summarizeRequest(request = {}) {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const systemText = flattenContentText(request.system);
  const combinedText = [
    systemText,
    ...messages.map((msg) => flattenContentText(msg?.content))
  ].join('\n');
  const systemMessages = messages.filter((msg) => {
    const role = String(msg?.role || '').trim().toLowerCase();
    return role === 'system' || role === 'developer';
  });
  const systemCombinedText = [
    systemText,
    ...systemMessages.map((msg) => flattenContentText(msg?.content))
  ].join('\n');
  const markerCounts = summarizePromptMarkerCounts(combinedText);
  const explicitMessageCount = Number(request.message_count);
  const explicitToolCount = Number(request.tool_count);

  return {
    model: normalizeText(request.model),
    stream: Boolean(request.stream),
    max_tokens: Number.isFinite(Number(request.max_tokens))
      ? Math.floor(Number(request.max_tokens))
      : null,
    message_count: Number.isFinite(explicitMessageCount)
      ? Math.max(0, Math.floor(explicitMessageCount))
      : messages.length + (systemText ? 1 : 0),
    tool_count: Number.isFinite(explicitToolCount)
      ? Math.max(0, Math.floor(explicitToolCount))
      : (Array.isArray(request.tools) ? request.tools.length : 0),
    memory_injected: request.memory_injected !== undefined
      ? Boolean(request.memory_injected)
      : containsMemoryMarker(combinedText),
    prompt_integrity: {
      system_message_count: systemMessages.length + (systemText ? 1 : 0),
      has_system_prompt: Boolean(systemCombinedText.trim()),
      memory_marker_count: Object.values(markerCounts).reduce((sum, count) => sum + count, 0),
      memory_markers: markerCounts,
      has_retrieved_memory: markerCounts.retrieved_memory > 0,
      has_daily_journal: markerCounts.daily_journal > 0,
      has_short_term_continuity: markerCounts.short_term_continuity > 0,
      has_memos_recall: markerCounts.memos_recall > 0,
      has_continuity_state: markerCounts.continuity_state > 0,
      token_budget: summarizePromptTokenBudget(request, combinedText)
    }
  };
}

function countPattern(text = '', pattern) {
  const matches = String(text || '').match(pattern);
  return matches ? matches.length : 0;
}

function summarizePromptMarkerCounts(text = '') {
  const input = String(text || '');
  return {
    retrieved_memory: countPattern(input, /\[(?:RetrievedMemoryLite|RetrievedMemory)\]/gi),
    daily_journal: countPattern(input, /\[DailyJournal\]/gi),
    task_memory: countPattern(input, /\[TaskMemory\]/gi),
    group_memory: countPattern(input, /\[GroupMemory\]/gi),
    style_signals: countPattern(input, /\[StyleSignals\]/gi),
    short_term_continuity: countPattern(input, /\[ShortTermContinuity\]/gi),
    memos_recall: countPattern(input, /\[MemOSRecall\]/gi),
    long_term_profile: countPattern(input, /\[LongTermProfile\]/gi),
    summary: countPattern(input, /\[Summary\]/gi),
    continuity_state: countPattern(input, /\[ContinuityState\]/gi)
  };
}

module.exports = {
  containsMemoryMarker,
  estimatePromptTokens,
  flattenContentText,
  summarizePromptTokenBudget,
  summarizePromptMarkerCounts,
  summarizeRequest
};
