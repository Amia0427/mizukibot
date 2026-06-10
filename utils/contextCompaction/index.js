const config = require('../../config');
const {
  estimateMessagesTokens,
  trimMessagesByTokenBudget,
} = require('../contextBudget');
const {
  inspectContextSnapshot,
  resolveModelTokenLimit
} = require('../contextInspector');
const { createContextCompactionSegments } = require('./segments');

const CANONICAL_SEGMENT_ORDER = Object.freeze([
  'system_prompt',
  'route_prompt',
  'continuity_state',
  'retrieved_memory',
  'task_memory',
  'group_memory',
  'style_signals',
  'short_term_summary',
  'recent_history',
  'assistant_only_context',
  'current_user_turn',
  'daily_journal',
  'tool_evidence',
  'planner_artifacts'
]);

const PRIORITY_BY_SEGMENT = Object.freeze({
  system_prompt: 'P0',
  route_prompt: 'P1',
  continuity_state: 'P1',
  retrieved_memory: 'P1',
  task_memory: 'P1',
  group_memory: 'P1',
  style_signals: 'P1',
  short_term_summary: 'P2',
  recent_history: 'P1',
  assistant_only_context: 'P2',
  current_user_turn: 'P0',
  daily_journal: 'P3',
  tool_evidence: 'P3',
  planner_artifacts: 'P3'
});

const LEVELS = Object.freeze({
  NORMAL: 'normal',
  WARNING: 'warning',
  COMPACT: 'compact',
  BLOCKING: 'blocking',
  REACTIVE: 'reactive'
});

const {
  buildSegments,
  dropSegment,
  flattenMessages,
  maybeCompactSegment,
  normalizeArray,
  normalizeMessages,
  normalizeObject,
  normalizeText,
  segmentHasContent
} = createContextCompactionSegments({
  CANONICAL_SEGMENT_ORDER,
  LEVELS,
  PRIORITY_BY_SEGMENT
});

const CONTEXT_OVERFLOW_PATTERNS = [
  /\bcontext length\b/i,
  /\bcontext window\b/i,
  /\bmaximum context\b/i,
  /\bmax(?:imum)? tokens?\b/i,
  /\btoo many tokens?\b/i,
  /\binput is too long\b/i,
  /\bprompt is too long\b/i,
  /\brequest too large\b/i,
  /\b413\b/i
];

function getInitialLevel(usageRatio = 0) {
  if (usageRatio >= Number(config.CONTEXT_COMPACTION_BLOCK_RATIO || 0.90)) return LEVELS.BLOCKING;
  if (usageRatio >= Number(config.CONTEXT_COMPACTION_AUTO_RATIO || 0.82)) return LEVELS.COMPACT;
  if (usageRatio >= Number(config.CONTEXT_COMPACTION_WARNING_RATIO || 0.72)) return LEVELS.WARNING;
  return LEVELS.NORMAL;
}

function inspectPlan(segments = [], options = {}) {
  const snapshot = inspectContextSnapshot({
    model: options.modelName,
    modelName: options.modelName,
    tokenLimit: options.modelWindowTokens,
    segments: normalizeArray(segments)
      .filter(segmentHasContent)
      .map((segment) => ({
        name: segment.name,
        messages: segment.messages
      }))
  });
  return snapshot;
}

function buildBudgetMeta(input = {}) {
  const modelWindowTokens = Math.max(256, Number(input.modelWindowTokens) || resolveModelTokenLimit(input.modelName || '', Number(config.CONTEXT_WINDOW_MAX_TOKENS || 32000)));
  const maxOutputTokens = Math.max(0, Number(input.maxOutputTokens) || 0);
  return {
    modelWindowTokens,
    maxOutputTokens,
    availableInputTokens: Math.max(128, modelWindowTokens - maxOutputTokens)
  };
}

function selectDroppableSegments(segments = [], reactive = false) {
  const order = reactive
    ? ['daily_journal', 'planner_artifacts', 'tool_evidence', 'retrieved_memory', 'group_memory', 'task_memory']
    : ['planner_artifacts', 'tool_evidence', 'daily_journal', 'retrieved_memory', 'group_memory', 'task_memory'];
  return order
    .map((name) => normalizeArray(segments).find((segment) => segment.name === name))
    .filter(Boolean);
}

function buildContextCompactionPlan(input = {}) {
  const routeMeta = normalizeObject(input.routeMeta, {});
  const budget = buildBudgetMeta(input);
  const source = normalizeText(input.source) || 'unknown';
  const isReactive = Boolean(input.reactive);
  let segments = buildSegments(input.segments);
  const diagnostics = {
    source,
    routePolicyKey: normalizeText(routeMeta.routePolicyKey || input.routePolicyKey),
    topRouteType: normalizeText(routeMeta.topRouteType || input.topRouteType),
    modelWindowTokens: budget.modelWindowTokens,
    maxOutputTokens: budget.maxOutputTokens,
    availableInputTokens: budget.availableInputTokens,
    warningRatio: Number(config.CONTEXT_COMPACTION_WARNING_RATIO || 0.72),
    autoCompactRatio: Number(config.CONTEXT_COMPACTION_AUTO_RATIO || 0.82),
    blockingRatio: Number(config.CONTEXT_COMPACTION_BLOCK_RATIO || 0.90),
    compactionSteps: []
  };

  let stats = inspectPlan(segments, input);
  let usageRatio = budget.availableInputTokens > 0
    ? (stats.estimatedTokens / budget.availableInputTokens)
    : 1;
  let level = isReactive ? LEVELS.REACTIVE : getInitialLevel(usageRatio);

  if (level === LEVELS.NORMAL) {
    return {
      usageRatio,
      level,
      compactedSegments: segments.filter(segmentHasContent),
      droppedSegments: [],
      diagnostics: {
        ...diagnostics,
        before: stats,
        after: stats
      },
      hardBlock: false
    };
  }

  segments = segments.map((segment) => maybeCompactSegment(segment, level, input));
  diagnostics.compactionSteps.push(level);
  stats = inspectPlan(segments, input);
  usageRatio = budget.availableInputTokens > 0
    ? (stats.estimatedTokens / budget.availableInputTokens)
    : 1;

  if (usageRatio >= Number(config.CONTEXT_COMPACTION_BLOCK_RATIO || 0.90)) {
    const droppable = selectDroppableSegments(segments, isReactive);
    for (const segment of droppable) {
      if (!segmentHasContent(segment)) continue;
      segments = segments.map((item) => (
        item.name === segment.name
          ? dropSegment(item, isReactive ? 'reactive_drop_for_budget' : 'drop_for_budget')
          : item
      ));
      diagnostics.compactionSteps.push(`drop:${segment.name}`);
      stats = inspectPlan(segments, input);
      usageRatio = budget.availableInputTokens > 0
        ? (stats.estimatedTokens / budget.availableInputTokens)
        : 1;
      if (usageRatio < Number(config.CONTEXT_COMPACTION_BLOCK_RATIO || 0.90)) break;
    }
  }

  const compactedSegments = segments.filter(segmentHasContent);
  const droppedSegments = segments.filter((segment) => !segmentHasContent(segment) && normalizeText(segment.dropReason));
  const hardBlock = usageRatio >= Number(config.CONTEXT_COMPACTION_BLOCK_RATIO || 0.90);
  const finalLevel = hardBlock ? LEVELS.BLOCKING : level;
  const finalStats = inspectPlan(compactedSegments, input);

  return {
    usageRatio,
    level: finalLevel,
    compactedSegments,
    droppedSegments,
    diagnostics: {
      ...diagnostics,
      before: inspectPlan(buildSegments(input.segments), input),
      after: finalStats,
      usageRatio,
      level: finalLevel,
      hardBlock
    },
    hardBlock
  };
}

function collectErrorText(error = null) {
  const responseData = error?.response?.data;
  const values = [
    error?.message,
    error?.code,
    error?.response?.statusText,
    typeof responseData === 'string' ? responseData : '',
    responseData && typeof responseData === 'object' ? responseData?.error?.message : '',
    responseData && typeof responseData === 'object' ? responseData?.message : ''
  ].filter(Boolean);
  return values.join(' | ');
}

function isContextOverflowError(error = null) {
  const status = Number(
    error?.response?.status
    || error?.status
    || error?.statusCode
    || 0
  );
  if (status === 413) return true;
  const text = collectErrorText(error);
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}

function shouldPreferRawMessageReactiveTrim(messages = []) {
  return normalizeArray(messages).some((message) => {
    if (!message || typeof message !== 'object') return false;
    if (String(message.role || '').trim().toLowerCase() === 'tool') return true;
    return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  });
}

function createContextCompactionHardBlockError(plan = null, message = '') {
  const error = new Error(
    normalizeText(message)
      || '上下文塞得太满啦。你从最近那一步接着问，或者把范围缩小一点。'
  );
  error.code = 'CONTEXT_COMPACTION_HARD_BLOCK';
  error.isContextHardBlock = true;
  error.compactionPlan = plan || null;
  return error;
}

function getContextCompactionFailureReply() {
  return '上下文塞得太满啦。你从最近那一步接着问，或者把范围缩小一点。';
}

function buildReactiveRawTrimPlan(messages = [], input = {}) {
  const budget = buildBudgetMeta(input);
  const source = normalizeText(input.source) || 'unknown';
  const routeMeta = normalizeObject(input.routeMeta, {});
  const rawMessages = normalizeMessages(messages);
  const targetBudget = Math.max(96, Math.floor(budget.availableInputTokens * 0.68));
  const trimmedMessages = trimMessagesByTokenBudget(rawMessages, targetBudget);
  const estimatedTokens = estimateMessagesTokens(trimmedMessages);
  const usageRatio = budget.availableInputTokens > 0
    ? (estimatedTokens / budget.availableInputTokens)
    : 1;
  const hardBlock = !trimmedMessages.length || usageRatio >= Number(config.CONTEXT_COMPACTION_BLOCK_RATIO || 0.90);
  return {
    usageRatio,
    level: hardBlock ? LEVELS.BLOCKING : LEVELS.REACTIVE,
    compactedSegments: trimmedMessages.length > 0
      ? [{ name: 'reactive_trim', messages: trimmedMessages }]
      : [],
    droppedSegments: [],
    diagnostics: {
      source,
      routePolicyKey: normalizeText(routeMeta.routePolicyKey || input.routePolicyKey),
      topRouteType: normalizeText(routeMeta.topRouteType || input.topRouteType),
      modelWindowTokens: budget.modelWindowTokens,
      maxOutputTokens: budget.maxOutputTokens,
      availableInputTokens: budget.availableInputTokens,
      warningRatio: Number(config.CONTEXT_COMPACTION_WARNING_RATIO || 0.72),
      autoCompactRatio: Number(config.CONTEXT_COMPACTION_AUTO_RATIO || 0.82),
      blockingRatio: Number(config.CONTEXT_COMPACTION_BLOCK_RATIO || 0.90),
      compactionSteps: ['reactive_trim'],
      before: {
        estimatedTokens: estimateMessagesTokens(rawMessages),
        estimatedMessageCount: rawMessages.length
      },
      after: {
        estimatedTokens,
        estimatedMessageCount: trimmedMessages.length
      },
      usageRatio,
      level: hardBlock ? LEVELS.BLOCKING : LEVELS.REACTIVE,
      hardBlock,
      trimBudget: targetBudget
    },
    hardBlock
  };
}

function buildReactiveRetryPayload(input = {}) {
  const routeMeta = normalizeObject(input.routeMeta, {});
  const source = normalizeText(input.source) || 'unknown';
  const canonicalSegments = normalizeObject(input.canonicalSegments, null);
  const rawMessages = normalizeArray(input.messages);
  const preferRawTrim = Boolean(input.preferRawTrim) || shouldPreferRawMessageReactiveTrim(rawMessages) || !canonicalSegments;

  const plan = preferRawTrim
    ? buildReactiveRawTrimPlan(rawMessages, {
        ...input,
        routeMeta,
        source: `${source}:reactive_trim`
      })
    : buildContextCompactionPlan({
        ...input,
        segments: canonicalSegments,
        routeMeta,
        source,
        reactive: true
      });

  if (plan.hardBlock) {
    throw createContextCompactionHardBlockError(plan);
  }

  return {
    messages: flattenMessages(plan.compactedSegments),
    compactionPlan: plan,
    mode: preferRawTrim ? 'reactive_trim' : 'reactive_compaction'
  };
}

module.exports = {
  CANONICAL_SEGMENT_ORDER,
  PRIORITY_BY_SEGMENT,
  LEVELS,
  buildContextCompactionPlan,
  buildReactiveRetryPayload,
  createContextCompactionHardBlockError,
  getContextCompactionFailureReply,
  isContextOverflowError
};
