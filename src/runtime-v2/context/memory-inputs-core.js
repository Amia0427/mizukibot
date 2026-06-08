const config = require('../../../config');
const { filterCompanionAllowedTools } = require('../../../utils/companionTools');
const { normalizeToolNames } = require('../../../utils/localToolAccess');
const { filterAllowedToolsForMemoryCliTurn } = require('../../../utils/memoryCliTurnPolicy');

function normalizeRouteInputs(options = {}) {
  const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  return {
    routeMeta,
    reviewMode: String(options?.reviewMode || '').trim().toLowerCase(),
    routePolicyKey: String(options?.routePolicyKey || '').trim().toLowerCase(),
    topRouteType: String(options?.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase()
  };
}

function isDirectChatLikeRoute(options = {}) {
  const { routePolicyKey, topRouteType } = normalizeRouteInputs(options);
  return topRouteType === 'direct_chat'
    || routePolicyKey.startsWith('direct_chat/')
    || (!topRouteType && !routePolicyKey);
}

function shouldExposeMemoryCli(options = {}) {
  if (!config.MEMORY_CLI_ENABLED || !config.MEMORY_CLI_CHAT_ENABLED) return false;
  if (options?.disableTools) return false;
  if (String(options?.customPrompt || '').trim()) return false;
  const { reviewMode, routePolicyKey, topRouteType } = normalizeRouteInputs(options);

  if (reviewMode) return false;
  const blockedRoutePrefixes = ['review', 'admin', 'refuse', 'ignore', 'proactive'];
  if (new Set(blockedRoutePrefixes).has(topRouteType)) return false;
  if (blockedRoutePrefixes.some((prefix) => routePolicyKey.startsWith(`${prefix}/`))) return false;
  return isDirectChatLikeRoute(options);
}

function shouldExposeContextStats(options = {}) {
  if (options?.disableTools) return false;
  const { reviewMode } = normalizeRouteInputs(options);
  if (reviewMode) return false;
  return isDirectChatLikeRoute(options);
}

function mergeAllowedToolsWithMemoryCli(allowedTools, options = {}) {
  const base = Array.isArray(allowedTools) ? normalizeToolNames(allowedTools) : [];
  const chatMemoryCliEnabled = config.MEMORY_CLI_ENABLED && config.MEMORY_CLI_CHAT_ENABLED;
  const filteredBase = chatMemoryCliEnabled
    ? base
    : base.filter((toolName) => toolName !== 'memory_cli');
  const withContextStats = (!shouldExposeContextStats(options) || base.includes('get_context_stats'))
    ? filteredBase
    : [...filteredBase, 'get_context_stats'];
  const withMemoryCli = (!shouldExposeMemoryCli(options) || withContextStats.includes('memory_cli'))
    ? withContextStats
    : [...withContextStats, 'memory_cli'];
  return filterCompanionAllowedTools(
    filterAllowedToolsForMemoryCliTurn(withMemoryCli, options?.memoryCliTurn),
    config
  );
}

module.exports = {
  mergeAllowedToolsWithMemoryCli,
  shouldExposeMemoryCli
};
