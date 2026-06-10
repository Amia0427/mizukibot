const config = require('../../config');
const {
  estimateMessagesTokens,
  normalizeMessageContent,
  trimTextByTokenBudget
} = require('../contextBudget');

function createContextCompactionSegments(deps = {}) {
  const {
    CANONICAL_SEGMENT_ORDER,
    LEVELS,
    PRIORITY_BY_SEGMENT
  } = deps;

  function normalizeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function normalizeObject(value, fallback = {}) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  }

  function normalizeText(value) {
    return String(value || '').trim();
  }

  function normalizeMessages(messages = []) {
    return normalizeArray(messages)
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        role: String(item.role || 'system').trim() || 'system',
        content: item.content
      }));
  }

  function ensureSegment(name, segment = {}) {
    const normalizedName = String(name || '').trim().toLowerCase();
    const rawSegment = Array.isArray(segment)
      ? { messages: segment }
      : normalizeObject(segment, {});
    const messages = normalizeMessages(rawSegment.messages);
    return {
      name: normalizedName,
      priority: PRIORITY_BY_SEGMENT[normalizedName] || 'P4',
      messages,
      estimatedTokens: estimateMessagesTokens(messages),
      meta: normalizeObject(rawSegment.meta, {}),
      dropReason: '',
      compacted: false
    };
  }

  function cloneSegment(segment = {}) {
    return {
      ...segment,
      messages: normalizeMessages(segment.messages),
      meta: normalizeObject(segment.meta, {}),
      dropReason: normalizeText(segment.dropReason),
      compacted: Boolean(segment.compacted),
      estimatedTokens: estimateMessagesTokens(segment.messages)
    };
  }

  function buildSegments(inputSegments = {}) {
    const byName = normalizeObject(inputSegments, {});
    return CANONICAL_SEGMENT_ORDER.map((name) => ensureSegment(name, byName[name] || {}));
  }

  function flattenMessages(segments = []) {
    return normalizeArray(segments).flatMap((segment) => normalizeMessages(segment.messages));
  }

  function segmentHasContent(segment = {}) {
    return normalizeMessages(segment.messages).some((message) => normalizeText(normalizeMessageContent(message.content)));
  }

  function dedupeMessages(messages = []) {
    const seen = new Set();
    const out = [];
    for (const message of normalizeMessages(messages)) {
      const key = `${String(message.role || '').trim().toLowerCase()}::${normalizeText(normalizeMessageContent(message.content))}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(message);
    }
    return out;
  }

  function trimMessageContent(message = {}, maxChars = config.CONTEXT_COMPACTION_LOW_VALUE_MAX_CHARS) {
    const content = normalizeMessageContent(message.content);
    const trimmed = String(content || '').length > Math.max(1, Number(maxChars) || 1)
      ? `${String(content || '').slice(0, Math.max(1, Number(maxChars) || 1))}...`
      : String(content || '');
    return {
      ...message,
      content: trimmed
    };
  }

  function summarizeMessages(messages = [], options = {}) {
    const label = normalizeText(options.label) || 'Compacted';
    const maxItems = Math.max(1, Number(options.maxItems) || 2);
    const maxChars = Math.max(80, Number(options.maxChars) || Number(config.CONTEXT_COMPACTION_LOW_VALUE_MAX_CHARS) || 1200);
    const lines = normalizeMessages(messages)
      .slice(-maxItems)
      .map((message, index) => {
        const role = String(message.role || 'system').trim() || 'system';
        const body = trimTextByTokenBudget(normalizeMessageContent(message.content), Math.max(48, Math.floor(maxChars / maxItems / 4)), 'tail');
        if (!body) return '';
        return `${index + 1}. [${role}] ${body}`;
      })
      .filter(Boolean);
    if (!lines.length) return [];
    return [{
      role: 'system',
      content: `[${label}]\n${lines.join('\n')}`
    }];
  }

  function maybeMicroCompact(segment = {}) {
    const next = cloneSegment(segment);
    if (!segmentHasContent(next)) return next;

    if (next.name === 'tool_evidence' || next.name === 'planner_artifacts' || next.name === 'daily_journal') {
      next.messages = next.messages.map((message) => trimMessageContent(message));
      next.compacted = true;
      next.estimatedTokens = estimateMessagesTokens(next.messages);
    }

    if (next.name === 'retrieved_memory' || next.name === 'daily_journal') {
      const deduped = dedupeMessages(next.messages);
      if (deduped.length !== next.messages.length) {
        next.messages = deduped;
        next.compacted = true;
        next.estimatedTokens = estimateMessagesTokens(next.messages);
      }
    }

    return next;
  }

  function maybeCompactSegment(segment = {}, level = LEVELS.COMPACT, options = {}) {
    const next = cloneSegment(segment);
    const lowValueMaxChars = Math.max(80, Number(options.lowValueMaxChars) || Number(config.CONTEXT_COMPACTION_LOW_VALUE_MAX_CHARS) || 1200);
    const recentRawMessages = Math.max(1, Number(options.recentRawMessages) || Number(config.CONTEXT_COMPACTION_RECENT_RAW_MESSAGES) || 6);
    const reactiveRecentRawMessages = Math.max(1, Number(options.reactiveRecentRawMessages) || Number(config.CONTEXT_COMPACTION_REACTIVE_RAW_MESSAGES) || 4);
    const maxToolResults = Math.max(1, Number(options.maxToolResults) || Number(config.CONTEXT_COMPACTION_MAX_TOOL_RESULTS) || 2);

    if (!segmentHasContent(next)) return next;

    if (level === LEVELS.WARNING) {
      return maybeMicroCompact(next);
    }

    if (next.name === 'recent_history') {
      const keepCount = level === LEVELS.REACTIVE ? reactiveRecentRawMessages : recentRawMessages;
      next.messages = next.messages.slice(-keepCount);
      next.compacted = true;
      next.estimatedTokens = estimateMessagesTokens(next.messages);
      return next;
    }

    if (next.name === 'tool_evidence') {
      const selected = next.messages.slice(-maxToolResults);
      next.messages = summarizeMessages(selected, {
        label: 'ToolEvidenceDigest',
        maxItems: maxToolResults,
        maxChars: lowValueMaxChars
      });
      next.compacted = true;
      next.estimatedTokens = estimateMessagesTokens(next.messages);
      return next;
    }

    if (next.name === 'planner_artifacts') {
      next.messages = summarizeMessages(next.messages, {
        label: 'PlannerArtifactsDigest',
        maxItems: maxToolResults,
        maxChars: lowValueMaxChars
      });
      next.compacted = true;
      next.estimatedTokens = estimateMessagesTokens(next.messages);
      return next;
    }

    if (next.name === 'daily_journal') {
      next.messages = summarizeMessages(next.messages, {
        label: 'DailyJournalDigest',
        maxItems: Math.min(3, next.messages.length),
        maxChars: lowValueMaxChars
      });
      next.compacted = true;
      next.estimatedTokens = estimateMessagesTokens(next.messages);
      return next;
    }

    if (next.name === 'retrieved_memory' || next.name === 'task_memory' || next.name === 'group_memory' || next.name === 'style_signals' || next.name === 'short_term_summary') {
      next.messages = next.messages.map((message) => ({
        ...message,
        content: trimTextByTokenBudget(
          normalizeMessageContent(message.content),
          Math.max(64, Math.floor(lowValueMaxChars / 4)),
          'tail'
        )
      }));
      next.compacted = true;
      next.estimatedTokens = estimateMessagesTokens(next.messages);
      return next;
    }

    return maybeMicroCompact(next);
  }

  function dropSegment(segment = {}, reason = '') {
    return {
      ...cloneSegment(segment),
      messages: [],
      estimatedTokens: 0,
      dropReason: normalizeText(reason) || 'dropped_for_budget'
    };
  }

  return {
    buildSegments,
    dropSegment,
    flattenMessages,
    maybeCompactSegment,
    normalizeArray,
    normalizeMessages,
    normalizeObject,
    normalizeText,
    segmentHasContent
  };
}

module.exports = {
  createContextCompactionSegments
};
