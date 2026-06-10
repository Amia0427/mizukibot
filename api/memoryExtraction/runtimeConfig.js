const config = require('../../config');

function ensureChatCompletionsUrl(url) {
  const u = String(url || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(u)) return u;
  if (/\/v\d+$/i.test(u)) return `${u}/chat/completions`;
  return u;
}

function normalizeTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : (part?.text || ''))).join('');
  }
  return String(content || '');
}

function getMemoryModelName() {
  return String(config.MEMORY_MODEL || config.AI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4';
}

function getMemoryApiBaseUrl() {
  return String(config.MEMORY_API_BASE_URL || config.API_BASE_URL || '').trim();
}

function getMemoryApiKey() {
  if (String(config.MEMORY_API_BASE_URL || '').trim()) {
    return String(config.MEMORY_API_KEY || config.API_KEY || '').trim();
  }
  return String(config.API_KEY || '').trim();
}

function getTemperature() {
  const n = Number(config.AI_TEMPERATURE);
  if (!Number.isFinite(n)) return 0.6;
  return Math.max(0, Math.min(2, n));
}

function getTopP() {
  const n = Number(config.AI_TOP_P);
  if (!Number.isFinite(n)) return 0.92;
  return Math.max(0, Math.min(1, n));
}

function getMaxTokens(fallback = 500) {
  const n = Number(config.AI_MAX_TOKENS);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(64, Math.floor(n));
}

function getRetries(fallback = 1) {
  const n = Number(config.AI_RETRIES);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, Math.floor(n)));
}

function resolvePostReplyMemoryMode(options = {}) {
  if (options && options.lightweight === true) return 'core';
  const raw = String(options.postReplyMemoryMode || config.POST_REPLY_MEMORY_MODE || 'full').trim().toLowerCase();
  if (raw === 'off' || raw === 'disabled' || raw === 'none') return 'off';
  if (raw === 'core' || raw === 'basic' || raw === 'lite') return 'core';
  return 'full';
}

function resolveLearningIntent(options = {}) {
  const raw = String(options.learningIntent || options.learning_intent || '').trim().toLowerCase();
  if (raw === 'explicit') return 'explicit';
  if (raw === 'implicit') return 'implicit';
  if (raw === 'journal_only' || raw === 'journal-only' || raw === 'journal') return 'journal_only';
  return '';
}

module.exports = {
  ensureChatCompletionsUrl,
  normalizeTextContent,
  getMemoryModelName,
  getMemoryApiBaseUrl,
  getMemoryApiKey,
  getTemperature,
  getTopP,
  getMaxTokens,
  getRetries,
  resolveLearningIntent,
  resolvePostReplyMemoryMode
};
