const { trimTextByTokenBudget } = require('../contextBudget');

function getRuntimeConfig(explicitConfig = null) {
  if (explicitConfig && typeof explicitConfig === 'object') return explicitConfig;
  return require('../../config');
}

function normalizeText(value = '') {
  return String(value || '').trim();
}

function getPromptTokenLimit(name, fallback, runtimeConfig = null) {
  const config = getRuntimeConfig(runtimeConfig);
  return Math.max(0, Number(config[name] || fallback) || fallback || 0);
}

function limitPromptText(text = '', tokenBudget = 0, strategy = 'tail') {
  const value = normalizeText(text);
  if (!value) return '';
  const budget = Math.max(0, Number(tokenBudget || 0) || 0);
  if (budget <= 0) return '';
  return trimTextByTokenBudget(value, budget, strategy);
}

function stripPromptSectionLabel(text = '') {
  return normalizeText(text).replace(/^\[[^\]\r\n]{1,80}\]\s*\r?\n?/, '').trim();
}

function extractPromptSectionText(messages = [], fallbackText = '', options = {}) {
  const fromMessages = Array.isArray(messages)
    ? messages
      .map((message) => stripPromptSectionLabel(message?.content))
      .filter(Boolean)
      .join('\n\n')
    : '';
  const text = fromMessages || normalizeText(fallbackText);
  if (!text) return '';
  const tokenBudget = getPromptTokenLimit(
    options.tokenLimitName || '',
    Math.max(0, Number(options.fallbackTokens || 0) || 0),
    options.config
  );
  return limitPromptText(text, tokenBudget, options.strategy || 'tail');
}

function limitMemoryForPrompt(text = '', options = {}) {
  const tokenBudget = getPromptTokenLimit(
    'MAIN_PROMPT_MEMORY_CONTEXT_MAX_TOKENS',
    2500,
    options.config
  );
  return limitPromptText(text, tokenBudget, options.strategy || 'head');
}

module.exports = {
  extractPromptSectionText,
  getPromptTokenLimit,
  limitMemoryForPrompt,
  limitPromptText,
  stripPromptSectionLabel
};
