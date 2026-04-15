/**
 * Canonical route contract schema.
 *
 * Single source of truth rules:
 * - router produces route contracts only
 * - directChatPlanner may only consume direct_chat contracts
 * - routeExecution may only translate contract + planner output into an execution plan
 * - routeProfiles may only provide policy metadata/guidance and must not define top route truth
 */
const TOP_ROUTE_TYPES = Object.freeze([
  'ignore',
  'refuse',
  'admin',
  'direct_chat'
]);

const TOP_ROUTE_TYPE_SET = new Set(TOP_ROUTE_TYPES);
const ROUTE_RISK_LEVELS = Object.freeze(['low', 'medium', 'high']);
const TOOL_NEED_TYPES = Object.freeze(['none', 'web', 'local-read', 'local-write', 'image', 'mixed']);
const TOOL_NEED_TYPE_SET = new Set(TOOL_NEED_TYPES);
const EXECUTION_MODES = Object.freeze(['immediate', 'staged', 'delegated', 'background']);
const FACET_MODALITIES = Object.freeze(['text', 'image', 'mixed']);
const FACET_SOURCE_SCOPES = Object.freeze(['none', 'web', 'notebook', 'live', 'vision', 'mixed']);
const FACET_DOMAINS = Object.freeze(['general', 'finance', 'location', 'weather', 'study', 'music', 'personal', 'research', 'admin', 'time']);
const FACET_OUTPUT_KINDS = Object.freeze(['answer', 'summary', 'rewrite', 'quiz', 'plan', 'report', 'action']);
const FACET_FRESHNESS_VALUES = Object.freeze(['timeless', 'latest', 'unknown']);
const CHAT_MODES = Object.freeze(['text_chat', 'image_qa', 'image_summary']);
const TOOL_INTENTS = Object.freeze(['none', 'maybe_tools', 'force_tools']);
const RESPONSE_INTENTS = Object.freeze(['answer', 'summary', 'plan', 'action_guidance']);
const TERMINAL_TOP_ROUTE_TYPES = new Set(['ignore', 'refuse', 'admin']);

const DEFAULT_INTENT = Object.freeze({
  risk: 'low',
  toolNeed: ['none'],
  executionMode: 'immediate',
  needsPlanning: false,
  needsMemory: false
});

const DEFAULT_FACETS = Object.freeze({
  modality: 'text',
  sourceScope: 'none',
  domain: 'general',
  outputKind: 'answer',
  freshness: 'unknown'
});

function normalizeBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function normalizeEnum(value, allow = [], fallback = '') {
  const normalized = String(value || '').trim();
  return allow.includes(normalized) ? normalized : fallback;
}

function sanitizeTopRouteType(type = '') {
  const normalized = String(type || '').trim();
  if (TOP_ROUTE_TYPE_SET.has(normalized)) return normalized;
  return 'direct_chat';
}

function normalizeChatMode(value, fallback = 'text_chat') {
  return normalizeEnum(value, CHAT_MODES, fallback);
}

function normalizeToolIntent(value, fallback = 'none') {
  return normalizeEnum(value, TOOL_INTENTS, fallback);
}

function normalizeResponseIntent(value, fallback = 'answer') {
  return normalizeEnum(value, RESPONSE_INTENTS, fallback);
}

function normalizeToolNeed(value, fallback = ['none']) {
  const list = Array.isArray(value) ? value : [value];
  const normalized = Array.from(new Set(
    list.map((item) => normalizeEnum(item, TOOL_NEED_TYPES, '')).filter(Boolean)
  ));
  if (normalized.length) return normalized;

  const fallbackList = Array.isArray(fallback) ? fallback : [fallback];
  const normalizedFallback = Array.from(new Set(
    fallbackList.map((item) => normalizeEnum(item, TOOL_NEED_TYPES, '')).filter(Boolean)
  ));
  return normalizedFallback.length ? normalizedFallback : ['none'];
}

function normalizeExecutionMode(value, fallback = 'immediate') {
  return normalizeEnum(value, EXECUTION_MODES, fallback);
}

function normalizeIntent(intent = {}, fallback = {}) {
  const base = {
    ...DEFAULT_INTENT,
    ...(fallback && typeof fallback === 'object' ? fallback : {}),
    ...(intent && typeof intent === 'object' ? intent : {})
  };

  return {
    risk: normalizeEnum(base.risk, ROUTE_RISK_LEVELS, 'low'),
    toolNeed: normalizeToolNeed(base.toolNeed, ['none']),
    executionMode: normalizeExecutionMode(base.executionMode, 'immediate'),
    needsPlanning: normalizeBool(base.needsPlanning, false),
    needsMemory: normalizeBool(base.needsMemory, false)
  };
}

function normalizeFacets(facets = {}, fallback = {}, imageUrl = null) {
  const base = {
    ...DEFAULT_FACETS,
    ...(fallback && typeof fallback === 'object' ? fallback : {}),
    ...(facets && typeof facets === 'object' ? facets : {})
  };

  const modalityFallback = imageUrl ? 'image' : 'text';
  return {
    modality: normalizeEnum(base.modality, FACET_MODALITIES, modalityFallback),
    sourceScope: normalizeEnum(base.sourceScope, FACET_SOURCE_SCOPES, imageUrl ? 'vision' : 'none'),
    domain: normalizeEnum(base.domain, FACET_DOMAINS, 'general'),
    outputKind: normalizeEnum(base.outputKind, FACET_OUTPUT_KINDS, 'answer'),
    freshness: normalizeEnum(base.freshness, FACET_FRESHNESS_VALUES, 'unknown')
  };
}

function buildCanonicalRouteContract(route = {}) {
  const imageUrl = route?.imageUrl || null;
  const normalizedIntent = normalizeIntent(route?.intent);
  const normalizedFacets = normalizeFacets(route?.facets, {}, imageUrl);
  const routeMeta = route?.meta && typeof route.meta === 'object' ? route.meta : {};
  const fallbackChatMode = imageUrl
    ? (normalizedFacets.outputKind === 'summary' ? 'image_summary' : 'image_qa')
    : 'text_chat';
  const fallbackToolIntent = normalizedIntent.toolNeed.some((item) => TOOL_NEED_TYPE_SET.has(item) && item !== 'none')
    ? 'maybe_tools'
    : 'none';
  let fallbackResponseIntent = 'answer';
  if (['summary', 'rewrite', 'quiz'].includes(normalizedFacets.outputKind)) fallbackResponseIntent = 'summary';
  else if (['plan', 'report'].includes(normalizedFacets.outputKind)) fallbackResponseIntent = 'plan';
  else if (normalizedFacets.outputKind === 'action') fallbackResponseIntent = 'action_guidance';
  return {
    topRouteType: sanitizeTopRouteType(route?.topRouteType || 'direct_chat'),
    intent: normalizedIntent,
    facets: normalizedFacets,
    chatMode: normalizeChatMode(routeMeta.chatMode, fallbackChatMode),
    toolIntent: normalizeToolIntent(routeMeta.toolIntent, fallbackToolIntent),
    responseIntent: normalizeResponseIntent(routeMeta.responseIntent, fallbackResponseIntent)
  };
}

function isTerminalTopRoute(route = {}) {
  return TERMINAL_TOP_ROUTE_TYPES.has(buildCanonicalRouteContract(route).topRouteType);
}

function isVisionRoute(route = {}) {
  const { facets, intent, chatMode } = buildCanonicalRouteContract(route);
  return (
    ['image_qa', 'image_summary'].includes(chatMode) ||
    facets.modality === 'image' ||
    facets.sourceScope === 'vision' ||
    intent.toolNeed.includes('image')
  );
}

function isNotebookRoute(route = {}) {
  const { topRouteType, intent, facets } = buildCanonicalRouteContract(route);
  if (topRouteType !== 'direct_chat') return false;
  return (
    facets.sourceScope === 'notebook' ||
    facets.domain === 'personal' ||
    intent.needsMemory ||
    intent.toolNeed.includes('local-read')
  );
}

function isBasicLocalWebLookup(route = {}) {
  const { topRouteType, intent, facets, toolIntent } = buildCanonicalRouteContract(route);
  if (topRouteType !== 'direct_chat') return false;
  if (toolIntent === 'none') return false;
  if (!intent.toolNeed.length) return false;
  if (!intent.toolNeed.every((item) => item === 'web')) return false;
  if (isVisionRoute(route)) return false;
  if (facets.sourceScope === 'notebook' || facets.domain === 'personal') return false;
  return true;
}

module.exports = {
  CHAT_MODES,
  RESPONSE_INTENTS,
  TOOL_INTENTS,
  buildCanonicalRouteContract,
  DEFAULT_FACETS,
  DEFAULT_INTENT,
  EXECUTION_MODES,
  FACET_DOMAINS,
  FACET_FRESHNESS_VALUES,
  FACET_MODALITIES,
  FACET_OUTPUT_KINDS,
  FACET_SOURCE_SCOPES,
  isBasicLocalWebLookup,
  isNotebookRoute,
  isTerminalTopRoute,
  isVisionRoute,
  ROUTE_RISK_LEVELS,
  TOOL_NEED_TYPES,
  TOOL_NEED_TYPE_SET,
  TOP_ROUTE_TYPES,
  TOP_ROUTE_TYPE_SET,
  normalizeChatMode,
  normalizeExecutionMode,
  normalizeFacets,
  normalizeIntent,
  normalizeResponseIntent,
  normalizeToolNeed,
  normalizeToolIntent,
  sanitizeTopRouteType
};
