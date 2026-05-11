const config = require('../../../config');
const { getApiProvider } = require('../../../utils/modelProvider');
const { normalizeToolNames } = require('../../../utils/localToolAccess');
const {
  filterCompanionAllowedTools,
  COMPANION_PLANNER_SAFE_READ_TOOLS,
  isCompanionToolModeEnabled
} = require('../../../utils/companionTools');
const { runStructuredSubagent } = require('../../../core/structuredSubagent');
const {
  normalizeChatMode,
  normalizeResponseIntent,
  normalizeToolIntent
} = require('../../../core/routeSchema');
const {
  buildDirectChatToolCatalog,
  buildDirectChatToolCatalogSummary
} = require('../../../core/directChatToolCatalog');
const {
  isConversationalNoop,
  shouldPrioritizeMemoryProbe
} = require('../../../utils/recallHeuristics');
const { getPolicyDefinition } = require('../../../core/routeProfiles');
const { HUMANIZER_SYSTEM_PROMPT } = require('../../../utils/humanizer');
const { buildPlannerStageSystemPrompt } = require('../../../utils/stagePromptContracts');
const {
  buildPlannerPersonaModuleCatalog,
  getPersonaModuleCatalogSummary
} = require('../../../utils/personaModules');
const {
  buildHeuristicDynamicPromptPlan,
  buildMainReplyDynamicPromptGuide,
  getMainReplyDynamicBlockCatalog
} = require('../../../utils/mainReplyPromptBlocks');
const {
  buildReactiveRetryPayload,
  createContextCompactionHardBlockError,
  isContextOverflowError
} = require('../../../utils/contextCompaction');
const { postWithRetry } = require('../../model/http');
const { extractJsonSafely, extractMessageContent } = require('../../../api/parser');
const { isReplyFailure } = require('../../../utils/replyFailure');
const { runHumanizerAgent } = require('../../../api/humanizerAgent');
const {
  ensureChatCompletionsUrl,
  getApiBaseUrl,
  getApiKey,
  getMaxTokens,
  getModelName,
  getRetries,
  getTemperature,
  getTopP,
  normalizeTextContent,
  withMainModelFallback
} = require('../../../api/runtimeV2/model/shared');
const {
  DEFAULT_PLANNER_TEMPERATURE,
  DEFAULT_WORLDBOOK_PLANNER_CANDIDATE_LIMIT,
  DIRECT_CHAT_PLANNER_VERSION,
  DYNAMIC_CONTEXT_PLAN_VERSION,
  PLANNER_DECISION_VERSION,
  PLANNER_LATENCY_KEYS,
  PLANNER_PROTOCOL_VERSION,
  TASK_SHAPES,
  TOOL_BUCKETS
} = require('./constants');
const {
  chooseTaskShape,
  extractExplicitUrl,
  extractTickerHint,
  getPlannerRequestText,
  getPlannerSearchSeed,
  hasExplicitHttpUrl,
  isArxivIdRequest,
  isArxivLatestRequest,
  isArxivRequest,
  isContextStatsRequest,
  isExplicitUrlLookup,
  isFinanceAnalysisRequest,
  isFinanceDividendRequest,
  isFinancePortfolioRequest,
  isFinanceQuoteRequest,
  isFinanceRumorRequest,
  isFinanceWatchlistRequest,
  isNotebookListingRequest,
  isSubjectiveOpinionQuestion,
  isWeatherRequest,
  prefersMemoryRecall,
  shouldKeepNotebookAnswerChatOnly
} = require('./classifiers');

function getToolRegistry() {
  return require('../../../api/toolRegistry');
}

function getToolExecutor(toolName = '') {
  return getToolRegistry().getToolExecutor(toolName);
}

function getToolNames() {
  return getToolRegistry().getToolSchemaNames();
}

function getConfig() {
  try {
    return require('../../../config');
  } catch (_) {
    return config;
  }
}

function nowMs() {
  return Date.now();
}

function addPlannerLatency(latencyMeta = {}, key = '', startedAt = 0) {
  const normalizedKey = normalizeText(key);
  if (!PLANNER_LATENCY_KEYS.includes(normalizedKey)) return latencyMeta;
  const duration = Math.max(0, nowMs() - Number(startedAt || 0));
  latencyMeta[normalizedKey] = Math.max(0, Math.round(Number(latencyMeta[normalizedKey] || 0) + duration));
  return latencyMeta;
}

function normalizePlannerLatencyMeta(...sources) {
  const latencyMeta = {};
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of PLANNER_LATENCY_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const value = Number(source[key]);
      if (Number.isFinite(value) && value >= 0) latencyMeta[key] = Math.round(value);
    }
  }
  return latencyMeta;
}

function attachPlannerLatencyMeta(decision = {}, latencyMeta = {}) {
  if (!decision || typeof decision !== 'object') return decision;
  const merged = normalizePlannerLatencyMeta(decision?.plannerMeta?.latencyMeta, latencyMeta);
  decision.plannerMeta = {
    ...(decision.plannerMeta || {}),
    latencyMeta: merged
  };
  if (decision.validation && typeof decision.validation === 'object') {
    decision.validation.plannerMeta = {
      ...(decision.validation.plannerMeta || {}),
      latencyMeta: merged
    };
  }
  return decision;
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value) {
  return String(value || '').trim();
}

function clampReason(text = '', maxLength = 240) {
  const normalized = normalizeText(text).replace(/\s+/g, ' ');
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

