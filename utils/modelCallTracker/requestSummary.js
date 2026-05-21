const { normalizeText } = require('./common');

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
      has_continuity_state: markerCounts.continuity_state > 0
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
  flattenContentText,
  summarizePromptMarkerCounts,
  summarizeRequest
};
