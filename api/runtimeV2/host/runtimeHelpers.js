const config = require('../../../config');

const MEMORY_RECALL_LATENCY_RE = /(昨天|昨日|前天|大前天|今天|今日|刚才|刚刚|上次|之前|前面|前几天|那天|聊了什么|聊过什么|聊到哪|说了什么|讲了什么|还记得|记得|记不记得|回忆|想起来|接着|继续|断片|失忆|\byesterday\b|\bremember\b|\blast time\b|\bearlier\b|what did we talk|where did we leave)/i;
const MEMORY_RECALL_MIN_MEMORY_BUDGET_MS = 6000;
const MEMORY_RECALL_MIN_PREPARE_BUDGET_MS = 8000;

function nowTs() {
  return Date.now();
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' ? value : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function clampLatencyBudget(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return Math.max(0, Number(fallback) || 0);
  return Math.max(0, Math.floor(num));
}

function isMemoryRecallLatencyRequest(request = {}) {
  const routeMeta = normalizeObject(request.routeMeta, {});
  const text = String(
    request.runtimeQuestionText
    || request.question
    || request.persistUserText
    || request.originalUserText
    || routeMeta.effectiveIntentText
    || routeMeta.cleanText
    || routeMeta.rawText
    || ''
  ).trim();
  if (!text) return false;
  if (/^(查一下|搜索|搜一下|最新|新闻|官网|search|look up|google)\b/i.test(text)) return false;
  return MEMORY_RECALL_LATENCY_RE.test(text);
}

function buildLatencyDecision(request = {}, options = {}) {
  const routeMeta = normalizeObject(request.routeMeta, {});
  const topRouteType = String(request.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
  const routePolicyKey = String(request.routePolicyKey || '').trim().toLowerCase();
  const allowTools = request.allowTools !== false && normalizeArray(request.allowedTools).length > 0;
  const profile = request.systemInitiated
    ? 'full_fidelity'
    : (
      topRouteType === 'direct_chat'
      || routePolicyKey.startsWith('direct_chat/')
      || (!topRouteType && !routePolicyKey)
    )
      ? (allowTools ? 'tool_fast' : 'chat_fast')
      : 'full_fidelity';
  const humanizerMode = String(
    options.humanizeMode
    || request.humanizeMode
    || config.HUMANIZER_MODE
    || 'auto'
  ).trim().toLowerCase() || 'auto';
  const deferPersist = options.deferPersist !== undefined
    ? Boolean(options.deferPersist)
    : (request.deferPersist !== undefined ? Boolean(request.deferPersist) : true);
  const recallNeedsMemory = isMemoryRecallLatencyRequest(request);
  const memoryBudgetFallback = Math.max(0, Number(config.MEMORY_RETRIEVAL_SOFT_BUDGET_MS || 300) || 300);
  const recallMemoryBudget = Math.max(
    memoryBudgetFallback,
    MEMORY_RECALL_MIN_MEMORY_BUDGET_MS,
    Number(config.MEMORY_RECALL_PROMPT_SOFT_BUDGET_MS || 0) || 0,
    Number(config.MEMORY_RETRIEVAL_RECALL_SOFT_BUDGET_MS || 0) || 0
  );
  const prepareBudgetFallback = Math.max(0, Number(config.PREPARE_SOFT_BUDGET_MS || 600) || 600);
  const recallPrepareBudget = Math.max(
    prepareBudgetFallback,
    MEMORY_RECALL_MIN_PREPARE_BUDGET_MS,
    recallMemoryBudget + 1000,
    Number(config.PREPARE_MEMORY_RECALL_SOFT_BUDGET_MS || 0) || 0
  );
  const prepareSoftBudgetMs = clampLatencyBudget(options.prepareSoftBudgetMs ?? request.prepareSoftBudgetMs, prepareBudgetFallback);
  const memoryBudgetMs = clampLatencyBudget(options.memoryBudgetMs ?? request.memoryBudgetMs, memoryBudgetFallback);
  return {
    profile,
    prepareSoftBudgetMs: recallNeedsMemory ? Math.max(prepareSoftBudgetMs, recallPrepareBudget) : prepareSoftBudgetMs,
    memoryBudgetMs: recallNeedsMemory ? Math.max(memoryBudgetMs, recallMemoryBudget) : memoryBudgetMs,
    continuityBudgetMs: clampLatencyBudget(options.continuityBudgetMs ?? request.continuityBudgetMs, config.CONTINUITY_PROBE_SOFT_BUDGET_MS || 250),
    preflightBudgetMs: clampLatencyBudget(options.preflightBudgetMs ?? request.preflightBudgetMs, config.CAPABILITY_PREFLIGHT_SOFT_BUDGET_MS || 350),
    humanizeBudgetMs: clampLatencyBudget(options.humanizeBudgetMs ?? request.humanizeBudgetMs, config.HUMANIZER_SOFT_BUDGET_MS || 500),
    humanizeMode: humanizerMode,
    deferPersist
  };
}

function buildContinuitySnapshotPayload(state) {
  const payload = normalizeObject(state.memory?.continuityState?.payload, {});
  return {
    activeTopic: String(payload.active_topic || '').trim(),
    openLoops: normalizeArray(payload.open_loops).map((item) => String(item || '').trim()).filter(Boolean),
    assistantCommitments: normalizeArray(payload.assistant_commitments).map((item) => String(item || '').trim()).filter(Boolean),
    userConstraints: normalizeArray(payload.user_constraints).map((item) => String(item || '').trim()).filter(Boolean),
    carryOverUserTurn: String(payload.carry_over_user_turn || '').trim()
  };
}

function buildV2CanonicalSegments(state, input = {}, deps = {}) {
  const buildContextCompactionPlan = deps.buildContextCompactionPlan;
  const resolveModelTokenLimit = deps.resolveModelTokenLimit;
  if (typeof buildContextCompactionPlan !== 'function') {
    throw new Error('buildContextCompactionPlan dependency is required');
  }
  if (typeof resolveModelTokenLimit !== 'function') {
    throw new Error('resolveModelTokenLimit dependency is required');
  }

  const request = normalizeObject(state.request, {});
  const routeMeta = normalizeObject(request.routeMeta, {});
  const memoryContext = normalizeObject(state.memory?.context, {});
  const systemPromptMessages = normalizeArray(input.systemPromptMessages);
  const routePromptMessages = normalizeArray(input.routePromptMessages);
  const continuityMessages = normalizeArray(input.continuityMessages);
  const shortTermSummaryMessages = normalizeArray(input.shortTermSummaryMessages);
  const recentHistoryMessages = normalizeArray(input.recentHistoryMessages);
  const userTurnMessages = normalizeArray(input.userTurnMessages);
  const toolEvidenceMessages = normalizeArray(input.toolEvidenceMessages);
  const plannerArtifactMessages = normalizeArray(input.plannerArtifactMessages);
  const modelName = String(input.modelName || request.modelConfig?.model || '').trim();
  const modelWindowTokens = Math.max(
    2048,
    Number(input.modelWindowTokens || state.memory?.affinity?.contextWindowTokens || resolveModelTokenLimit(modelName, Number(config.CONTEXT_WINDOW_MAX_TOKENS || 32000))) || 2048
  );
  const mainReplyDefaultMaxTokens = Math.max(64, Number(config.MAIN_REPLY_DEFAULT_MAX_TOKENS || 8192) || 8192);
  const maxOutputTokens = Math.max(
    64,
    Number(input.maxOutputTokens || request.modelConfig?.maxTokens || config.AI_MAX_TOKENS || mainReplyDefaultMaxTokens) || mainReplyDefaultMaxTokens
  );

  const segments = {
    system_prompt: systemPromptMessages,
    route_prompt: routePromptMessages,
    continuity_state: continuityMessages,
    short_term_summary: shortTermSummaryMessages,
    recent_history: recentHistoryMessages,
    assistant_only_context: normalizeArray(input.assistantOnlyContextMessages),
    current_user_turn: userTurnMessages,
    retrieved_memory: normalizeArray(memoryContext.segments?.retrievedMemory),
    daily_journal: normalizeArray(memoryContext.segments?.dailyJournal),
    task_memory: normalizeArray(memoryContext.segments?.taskMemory),
    group_memory: normalizeArray(memoryContext.segments?.groupMemory),
    style_signals: normalizeArray(memoryContext.segments?.styleSignals),
    tool_evidence: toolEvidenceMessages,
    planner_artifacts: plannerArtifactMessages
  };

  const compactionPlan = buildContextCompactionPlan({
    segments,
    modelName,
    modelWindowTokens,
    maxOutputTokens,
    routeMeta: {
      ...routeMeta,
      routePolicyKey: request.routePolicyKey,
      topRouteType: request.topRouteType
    },
    source: String(input.source || 'direct_reply').trim() || 'direct_reply'
  });

  return {
    segments,
    compactionPlan
  };
}

module.exports = {
  MEMORY_RECALL_LATENCY_RE,
  MEMORY_RECALL_MIN_MEMORY_BUDGET_MS,
  MEMORY_RECALL_MIN_PREPARE_BUDGET_MS,
  nowTs,
  normalizeObject,
  normalizeArray,
  clampLatencyBudget,
  isMemoryRecallLatencyRequest,
  buildLatencyDecision,
  buildContinuitySnapshotPayload,
  buildV2CanonicalSegments
};
