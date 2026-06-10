const config = require('../../config');
const { normalizeText } = require('./common');

function getPlannerApiBaseUrl() {
  return normalizeText(
    config.PLAN_API_BASE_URL
    || process.env.PLANNER_API_BASE_URL
    || process.env.PLAN_API_BASEURI
    || process.env.PLANNER_API_BASEURI
    || config.AI_ROUTER_BASE_URL
    || config.PASSIVE_AWARENESS_REPLY_API_BASE_URL
    || config.PASSIVE_AWARENESS_API_BASE_URL
    || config.API_BASE_URL
  );
}

function getPlannerApiKey() {
  return normalizeText(
    config.PLAN_API_KEY
    || process.env.PLANNER_API_KEY
    || process.env.PLAN_APIKEY
    || process.env.PLANNER_APIKEY
    || config.AI_ROUTER_API_KEY
    || config.PASSIVE_AWARENESS_REPLY_API_KEY
    || config.PASSIVE_AWARENESS_API_KEY
    || config.API_KEY
  );
}

function getPlannerModel() {
  return normalizeText(config.PLAN_MODEL || config.AI_ROUTER_MODEL || config.AI_MODEL || 'gpt-5.4-mini') || 'gpt-5.4-mini';
}

function getMemoryCompletionsUrl(ensureChatCompletionsUrl) {
  return ensureChatCompletionsUrl(config.MEMORY_API_BASE_URL || config.API_BASE_URL || '');
}

function getMemoryApiKey() {
  if (normalizeText(config.MEMORY_API_BASE_URL)) return normalizeText(config.MEMORY_API_KEY || config.API_KEY);
  return normalizeText(config.API_KEY);
}

function getMemoryModel() {
  return normalizeText(config.MEMORY_MODEL || config.AI_MODEL || 'gpt-5.4') || 'gpt-5.4';
}

function getPassiveAwarenessDecisionModel() {
  return normalizeText(config.PASSIVE_AWARENESS_MODEL);
}

function getPassiveAwarenessDecisionApiBaseUrl() {
  return normalizeText(config.PASSIVE_AWARENESS_API_BASE_URL);
}

function getPassiveAwarenessDecisionApiKey() {
  return normalizeText(config.PASSIVE_AWARENESS_API_KEY);
}

function isPassiveAwarenessDecisionConfigured() {
  return Boolean(
    config.PASSIVE_AWARENESS_DECISION_ENABLED !== false
    && getPassiveAwarenessDecisionModel()
    && getPassiveAwarenessDecisionApiBaseUrl()
    && getPassiveAwarenessDecisionApiKey()
  );
}

function getPassiveAwarenessReplyModel() {
  if (config.PASSIVE_AWARENESS_REPLY_USE_MAIN_MODEL === true) return normalizeText(config.AI_MODEL);
  return normalizeText(config.PASSIVE_AWARENESS_REPLY_MODEL || config.PASSIVE_AWARENESS_MODEL);
}

function getPassiveAwarenessReplyApiBaseUrl() {
  if (config.PASSIVE_AWARENESS_REPLY_USE_MAIN_MODEL === true) return normalizeText(config.API_BASE_URL);
  return normalizeText(config.PASSIVE_AWARENESS_REPLY_API_BASE_URL || config.PASSIVE_AWARENESS_API_BASE_URL);
}

function getPassiveAwarenessReplyApiKey() {
  if (config.PASSIVE_AWARENESS_REPLY_USE_MAIN_MODEL === true) return normalizeText(config.API_KEY);
  return normalizeText(config.PASSIVE_AWARENESS_REPLY_API_KEY || config.PASSIVE_AWARENESS_API_KEY);
}

function getPassiveAwarenessReplyApiProvider() {
  if (config.PASSIVE_AWARENESS_REPLY_USE_MAIN_MODEL === true) return normalizeText(config.API_PROVIDER);
  const explicit = normalizeText(config.PASSIVE_AWARENESS_REPLY_API_PROVIDER);
  if (explicit) return explicit;
  if (
    normalizeText(config.API_PROVIDER)
    && getPassiveAwarenessReplyApiBaseUrl() === normalizeText(config.API_BASE_URL)
    && getPassiveAwarenessReplyModel() === normalizeText(config.AI_MODEL)
  ) {
    return normalizeText(config.API_PROVIDER);
  }
  return '';
}

function isPassiveAwarenessReplyConfigured() {
  return Boolean(
    getPassiveAwarenessReplyModel()
    && getPassiveAwarenessReplyApiBaseUrl()
    && getPassiveAwarenessReplyApiKey()
  );
}

module.exports = {
  getMemoryApiKey,
  getMemoryCompletionsUrl,
  getMemoryModel,
  getPassiveAwarenessDecisionApiBaseUrl,
  getPassiveAwarenessDecisionApiKey,
  getPassiveAwarenessDecisionModel,
  getPassiveAwarenessReplyApiBaseUrl,
  getPassiveAwarenessReplyApiKey,
  getPassiveAwarenessReplyModel,
  getPassiveAwarenessReplyApiProvider,
  getPlannerApiBaseUrl,
  getPlannerApiKey,
  getPlannerModel,
  isPassiveAwarenessDecisionConfigured,
  isPassiveAwarenessReplyConfigured
};
