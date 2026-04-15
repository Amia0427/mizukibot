const config = require('../config');
const {
  estimateMessagesTokens,
  normalizeMessageContent
} = require('./contextBudget');

const MODEL_CONTEXT_LIMITS = Object.freeze({
  'gemini-3-pro-preview': 1048576,
  'gemini-2.5-pro': 2097152,
  'gemini-2.0-pro': 2097152,
  'gemini-2.0-flash-thinking': 1048576,
  'gemini-2.0-flash': 1048576,
  'gemini-1.5-pro': 2097152,
  'gemini-1.5-flash': 1048576,
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'chatgpt-4o-latest': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  'gpt-3.5-turbo': 16384,
  'claude-3-7-sonnet': 200000,
  'claude-3-5-sonnet': 200000,
  'claude-3-5-haiku': 200000,
  'claude-3-opus': 200000,
  'claude-3-sonnet': 200000,
  'claude-3-haiku': 200000,
  'deepseek-chat': 128000,
  'deepseek-reasoner': 128000,
  'qwen-long': 1000000,
  'qwen-max': 32768,
  'qwen-plus': 131072,
  'qwen-turbo': 131072,
  'glm-4-plus': 128000,
  'glm-4': 128000,
  'moonshot-v1-200k': 200000,
  'moonshot-v1-128k': 128000,
  'o1': 128000,
  'o1-mini': 128000,
  'o1-preview': 128000,
  'o3-mini': 128000
});

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeSegmentName(value = '') {
  return String(value || '').trim().toLowerCase() || 'other';
}

function normalizeSegmentLabel(name = '') {
  if (name === 'system') return 'system';
  if (name === 'short_term_summary') return 'short_term_summary';
  if (name === 'recent_history') return 'recent_history';
  if (name === 'current_user_turn') return 'current_user_turn';
  if (name === 'global_tool_evidence') return 'global_tool_evidence';
  return name || 'other';
}

function sumChars(messages = []) {
  return normalizeArray(messages).reduce((sum, message) => {
    return sum + String(normalizeMessageContent(message?.content) || '').length;
  }, 0);
}

function resolveModelTokenLimit(modelName = '', fallbackLimit = 0) {
  const normalized = String(modelName || '').trim().toLowerCase();
  const fallback = Math.max(1, Number(fallbackLimit) || 0);
  if (!normalized) return fallback || Math.max(1, Number(config.CONTEXT_WINDOW_MAX_TOKENS || 32000));
  if (MODEL_CONTEXT_LIMITS[normalized]) return MODEL_CONTEXT_LIMITS[normalized];

  const keys = Object.keys(MODEL_CONTEXT_LIMITS).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (normalized.includes(key)) return MODEL_CONTEXT_LIMITS[key];
  }

  return fallback || Math.max(1, Number(config.CONTEXT_WINDOW_MAX_TOKENS || 32000));
}

function inspectContextSnapshot(input = {}) {
  const snapshot = normalizeObject(input, {});
  const model = String(snapshot.modelName || snapshot.model || '').trim() || 'unknown';
  const fallbackLimit = Number(snapshot.tokenLimit || snapshot.fallbackTokenLimit || 0) || 0;
  const tokenLimit = resolveModelTokenLimit(model, fallbackLimit);
  const segmentsInput = normalizeArray(snapshot.segments);

  const segments = segmentsInput
    .map((segment) => {
      const normalizedSegment = normalizeObject(segment, {});
      const name = normalizeSegmentName(normalizedSegment.name || normalizedSegment.label);
      const label = normalizeSegmentLabel(name);
      const messages = normalizeArray(normalizedSegment.messages)
        .filter((message) => message && typeof message === 'object');
      return {
        name,
        label,
        messageCount: messages.length,
        charCount: sumChars(messages),
        estimatedTokens: estimateMessagesTokens(messages),
        messages
      };
    })
    .filter((segment) => segment.messageCount > 0 || segment.charCount > 0 || segment.estimatedTokens > 0);

  const messages = segments.flatMap((segment) => segment.messages);
  const messageCount = messages.length;
  const charCount = sumChars(messages);
  const estimatedTokens = estimateMessagesTokens(messages);
  const usageRatio = tokenLimit > 0 ? estimatedTokens / tokenLimit : 0;

  const summaryLines = [
    `Main conversation context snapshot for model ${model}.`,
    `Estimated usage: ${estimatedTokens} / ${tokenLimit} tokens (${(usageRatio * 100).toFixed(1)}%).`
  ];

  if (segments.length > 0) {
    summaryLines.push('Segment breakdown:');
    for (const segment of segments) {
      summaryLines.push(`- ${segment.label}: ${segment.estimatedTokens} tokens, ${segment.messageCount} messages, ${segment.charCount} chars`);
    }
  }

  return {
    model,
    tokenLimit,
    messageCount,
    charCount,
    estimatedTokens,
    usageRatio,
    segments: segments.map((segment) => ({
      label: segment.label,
      messageCount: segment.messageCount,
      charCount: segment.charCount,
      estimatedTokens: segment.estimatedTokens
    })),
    summaryText: summaryLines.join('\n')
  };
}

function formatContextStats(input = {}) {
  const stats = inspectContextSnapshot(input);
  const lines = [
    'Main conversation context stats',
    `Model: ${stats.model}`,
    `Estimated tokens: ${stats.estimatedTokens} / ${stats.tokenLimit} (${(stats.usageRatio * 100).toFixed(1)}%)`,
    `Messages: ${stats.messageCount}`,
    `Characters: ${stats.charCount}`
  ];

  if (stats.segments.length > 0) {
    lines.push('Segments:');
    for (const segment of stats.segments) {
      lines.push(`- ${segment.label}: ${segment.estimatedTokens} tokens, ${segment.messageCount} messages, ${segment.charCount} chars`);
    }
  }

  lines.push('This reflects the effective context prepared for the main conversation model in the current turn.');
  return lines.join('\n');
}

module.exports = {
  MODEL_CONTEXT_LIMITS,
  formatContextStats,
  inspectContextSnapshot,
  resolveModelTokenLimit
};
