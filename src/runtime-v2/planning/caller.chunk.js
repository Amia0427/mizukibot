const {
  DEFAULT_PLANNER_TEMPERATURE,
  PLANNER_DECISION_VERSION,
  PLANNER_PROTOCOL_VERSION,
  TASK_SHAPES,
  TOOL_BUCKETS,
  addPlannerLatency,
  attachPlannerLatencyMeta,
  clampReason,
  config,
  extractJsonSafely,
  extractMessageContent,
  normalizeArray,
  normalizeObject,
  normalizeText,
  normalizeToolNames,
  nowMs,
  postWithRetry,
  runStructuredSubagent
} = require('./runtime-core.chunk');
const {
  buildLegacyExecutionPlanFromSteps,
  buildToolCatalogByName,
  getPlannerDecisionVersion,
  resolveToolBucket
} = require('./dynamic-plan.chunk');
const {
  buildPlannerModelRequestBody,
  collectAvailableToolSummary,
  ensureChatCompletionsUrlLocal,
  getPlannerApiBaseUrlV2,
  getPlannerApiKeyV2,
  getPlannerModel,
  shouldUseDeterministicPlannerPreflight
} = require('./tool-gating.chunk');
const { buildRuleBasedPlannerDecision } = require('./rule-decision.chunk');
const {
  buildPlannerPrompt,
  buildPlannerUserPayload,
  normalizePlannerDecisionV2
} = require('./prompt-normalizer.chunk');

function getMemosPlannerRecall() {
  return require('../../../utils/memosPlannerRecall');
}

function getMemoryRecallDeduper() {
  return require('../../../utils/memoryRecallDeduper');
}

async function callPlannerModelV2(route = {}, options = {}) {
  const apiBaseUrl = getPlannerApiBaseUrlV2();
  const apiKey = getPlannerApiKeyV2();
  if (!apiBaseUrl || !apiKey) return null;
  const { requestBody } = buildPlannerModelRequestBody(route, options);
  const response = await postWithRetry(
    ensureChatCompletionsUrlLocal(apiBaseUrl),
    requestBody,
    0,
    apiKey
  );
  const message = extractMessageContent(response);
  const rawText = typeof message?.content === 'string'
    ? message.content
    : normalizeArray(message?.content).map((part) => (typeof part === 'string' ? part : String(part?.text || ''))).join('');
  return extractJsonSafely(rawText);
}

async function callPlannerSubagentV2(route = {}, options = {}) {
  const toolCatalog = collectAvailableToolSummary(route, options).toolCatalog;
  const result = await runStructuredSubagent({
    agentName: 'planner-v2',
    systemPrompt: buildPlannerPrompt(toolCatalog),
    userPayload: buildPlannerUserPayload(route, toolCatalog, options),
    modelResolver: () => ({
      baseUrl: getPlannerApiBaseUrlV2(),
      apiKey: getPlannerApiKeyV2(),
      model: getPlannerModel(),
      temperature: DEFAULT_PLANNER_TEMPERATURE,
      maxTokens: 900,
      retries: 0,
      timeoutMs: Number(config.PLANNER_SUBAGENT_TIMEOUT_MS || config.REQUEST_TIMEOUT_MS || 8000)
    }),
    trace: {
      ...(options.requestTrace && typeof options.requestTrace === 'object' ? options.requestTrace : {}),
      source: 'planner',
      phase: 'planner_subagent',
      purpose: 'direct_chat_plan',
      userId: normalizeText(options.userId || route?.meta?.userId),
      routePolicyKey: normalizeText(route?.meta?.routePolicyKey),
      topRouteType: normalizeText(route?.topRouteType || route?.meta?.topRouteType || 'direct_chat') || 'direct_chat'
    },
    validateOutput: (output) => {
      const normalized = normalizePlannerDecisionV2(output, route, options);
      return normalizeText(normalized?.plannerMeta?.decisionVersion) === PLANNER_DECISION_VERSION;
    }
  });
  if (!result.ok) return null;
  return result.output;
}

async function planRequestV2(input = {}) {
  const requestLatencyMeta = {};
  const route = {
    question: normalizeText(input.question || input.route?.question || ''),
    cleanText: normalizeText(input.cleanText || input.route?.cleanText || input.question || ''),
    imageUrl: input.imageUrl || input.route?.imageUrl || null,
    topRouteType: normalizeText(input.topRouteType || input.route?.topRouteType || 'direct_chat') || 'direct_chat',
    meta: normalizeObject(input.routeMeta || input.route?.meta, {}),
    intent: normalizeObject(input.intent || input.route?.intent, {}),
    facets: normalizeObject(input.facets || input.route?.facets, {})
  };
  const inputMemosRecall = normalizeObject(input.memosRecall, normalizeObject(route?.meta?.memosRecall, null));
  let memosRecall = inputMemosRecall && Object.keys(inputMemosRecall).length > 0 ? inputMemosRecall : null;
  if (!memosRecall && getMemosPlannerRecall().isMemosPlannerRecallEnabled(input)) {
    memosRecall = await getMemosPlannerRecall().recallForPlanner(route.question || route.cleanText, {
      ...input,
      routeMeta: route.meta,
      userId: normalizeText(input.userId || route?.meta?.userId),
      config: normalizeObject(input.config, {})
    });
  }
  const memoryContext = normalizeObject(input.memoryContext, normalizeObject(route?.meta?.memoryContext, {}));
  memosRecall = getMemoryRecallDeduper().dedupeMemosRecallAgainstMemoryContext(memosRecall || {}, memoryContext, {
    maxChars: normalizeObject(input.config, {}).MEMOS_RECALL_MAX_CHARS || config.MEMOS_RECALL_MAX_CHARS
  });
  const memosRecallText = getMemosPlannerRecall().getMemosRecallPromptText(memosRecall || {});
  const inputAvailableContextSignals = normalizeObject(input.availableContextSignals, normalizeObject(route?.meta?.availableContextSignals, {}));
  const availableContextSignals = memosRecallText
    ? { ...inputAvailableContextSignals, memosRecall: true }
    : inputAvailableContextSignals;
  const options = {
    userId: normalizeText(input.userId || route?.meta?.userId),
    allowedTools: normalizeArray(input.allowedTools),
    toolCatalog: normalizeArray(input.toolCatalog),
    contextSummary: normalizeText(input.contextSummary),
    continuitySignals: normalizeObject(input.continuitySignals, normalizeObject(route?.meta?.continuitySignals, {})),
    memoryContext,
    memosRecall: normalizeObject(memosRecall, {}),
    memosRecallText,
    availableContextSignals,
    constraints: normalizeObject(input.constraints, {}),
    directedContext: normalizeObject(input.directedContext, normalizeObject(route?.meta?.directedContext, null)),
    personaModuleCatalog: normalizeArray(input.personaModuleCatalog).length > 0
      ? normalizeArray(input.personaModuleCatalog)
      : normalizeArray(route?.meta?.personaModuleCatalog),
    dynamicPromptBlockCatalog: normalizeArray(input.dynamicPromptBlockCatalog).length > 0
      ? normalizeArray(input.dynamicPromptBlockCatalog)
      : normalizeArray(route?.meta?.dynamicPromptBlockCatalog),
    dynamicPromptGuide: normalizeText(input.dynamicPromptGuide || route?.meta?.dynamicPromptGuide),
    dynamicFewShotPrompt: normalizeText(input.dynamicFewShotPrompt || route?.meta?.dynamicFewShotPrompt),
    memoryCliTurn: normalizeObject(input.memoryCliTurn, normalizeObject(route?.meta?.memoryCliTurn, {})),
    schedulerInjection: input.schedulerInjection || route?.meta?.schedulerInjection || route?.meta?.lifeSchedulerInjection,
    sharedShortTermContext: normalizeObject(input.sharedShortTermContext, normalizeObject(route?.meta?.sharedShortTermContext, {})),
    personaMemoryState: normalizeObject(input.personaMemoryState, normalizeObject(route?.meta?.personaMemoryState, {})),
    userInfo: normalizeObject(input.userInfo, normalizeObject(route?.meta?.userInfo, {})),
    config: normalizeObject(input.config, {}),
    worldbookPlannerCandidateLimit: input.worldbookPlannerCandidateLimit,
    requestTrace: input.requestTrace || route?.meta?.requestTrace || null,
    question: route.question,
    goal: normalizeText(input.goal || route.question || route.cleanText),
    topRouteType: route.topRouteType,
    contextEvidence: input.contextEvidence === true
  };

  if (typeof input.planner === 'function') {
    const plannerOutput = await input.planner(route, options);
    const normalizeStartedAt = nowMs();
    const normalized = normalizePlannerDecisionV2(plannerOutput, route, {
      ...options,
      allowPlannerCorrection: true
    });
    addPlannerLatency(requestLatencyMeta, 'planner_normalize_ms', normalizeStartedAt);
    return attachPlannerLatencyMeta(normalized, requestLatencyMeta);
  }

  const preflightStartedAt = nowMs();
  const shouldPreflight = shouldUseDeterministicPlannerPreflight(route, options);
  addPlannerLatency(requestLatencyMeta, 'planner_preflight_ms', preflightStartedAt);
  if (shouldPreflight) {
    const preflightDecision = buildRuleBasedPlannerDecision(route, {
      ...options,
      fallbackUsed: false,
      decisionSource: 'rule_preflight',
      latencyMeta: requestLatencyMeta
    });
    const normalizeStartedAt = nowMs();
    const normalized = normalizePlannerDecisionV2(preflightDecision, route, {
      ...options,
      fallbackUsed: false,
      latencyMeta: requestLatencyMeta
    });
    addPlannerLatency(requestLatencyMeta, 'planner_normalize_ms', normalizeStartedAt);
    return attachPlannerLatencyMeta(normalized, requestLatencyMeta);
  }

  if (config.PLANNER_SUBAGENT_ENABLED) {
    try {
      const modelStartedAt = nowMs();
      const subagentOutput = await callPlannerSubagentV2(route, options);
      addPlannerLatency(requestLatencyMeta, 'planner_model_ms', modelStartedAt);
      if (subagentOutput && typeof subagentOutput === 'object') {
        const normalizeStartedAt = nowMs();
        const normalized = normalizePlannerDecisionV2(subagentOutput, route, {
          ...options,
          fallbackUsed: false,
          latencyMeta: requestLatencyMeta
        });
        addPlannerLatency(requestLatencyMeta, 'planner_normalize_ms', normalizeStartedAt);
        return attachPlannerLatencyMeta(normalized, requestLatencyMeta);
      }
    } catch (_) {}
  }

  try {
    const modelStartedAt = nowMs();
    const plannerOutput = await callPlannerModelV2(route, options);
    addPlannerLatency(requestLatencyMeta, 'planner_model_ms', modelStartedAt);
    if (plannerOutput && typeof plannerOutput === 'object') {
      const normalizeStartedAt = nowMs();
      const normalized = normalizePlannerDecisionV2(plannerOutput, route, {
        ...options,
        fallbackUsed: false,
        latencyMeta: requestLatencyMeta
      });
      addPlannerLatency(requestLatencyMeta, 'planner_normalize_ms', normalizeStartedAt);
      return attachPlannerLatencyMeta(normalized, requestLatencyMeta);
    }
  } catch (_) {}

  const normalizeStartedAt = nowMs();
  const normalized = normalizePlannerDecisionV2(null, route, {
    ...options,
    fallbackUsed: true,
    latencyMeta: requestLatencyMeta
  });
  addPlannerLatency(requestLatencyMeta, 'planner_normalize_ms', normalizeStartedAt);
  return attachPlannerLatencyMeta(normalized, requestLatencyMeta);
}

function convertPlannerDecisionToDirectChatDecision(decision = {}, route = {}, options = {}) {
  const toolCatalog = normalizeArray(options.toolCatalog);
  const toolCatalogByName = buildToolCatalogByName(toolCatalog);
  const allowedToolNames = normalizeToolNames(decision.allowedToolNames);
  const toolBuckets = Array.from(new Set(
    allowedToolNames.map((toolName) => resolveToolBucket(toolName, toolCatalogByName)).filter((bucket) => TOOL_BUCKETS.includes(bucket))
  ));
  const dynamicPromptPlan = normalizeObject(decision?.dynamicPromptPlan || decision?.plannerMeta?.dynamicPromptPlan, {});
  const personaModules = normalizeArray(
    decision?.personaModules && normalizeArray(decision.personaModules).length > 0
      ? decision.personaModules
      : (dynamicPromptPlan.personaModules || decision?.plannerMeta?.personaModules)
  ).map((item) => normalizeText(item)).filter(Boolean);
  return {
    decisionVersion: getPlannerDecisionVersion(),
    decisionSource: normalizeText(decision?.plannerMeta?.decisionSource) || 'planner',
    shouldUseTools: normalizeText(decision.mode) === 'tool_plan' && allowedToolNames.length > 0,
    taskShape: TASK_SHAPES.includes(normalizeText(decision.taskShape)) ? normalizeText(decision.taskShape) : 'fast_reply',
    needsBackground: normalizeText(decision.taskShape) === 'background_tool_task',
    toolBuckets,
    allowedToolNames,
    executionPlan: buildLegacyExecutionPlanFromSteps(decision.steps),
    reason: clampReason(normalizeText(decision?.plannerMeta?.reason)),
    plannerModel: normalizeText(decision?.plannerMeta?.plannerModel) || getPlannerModel(),
    plannerFallbackUsed: Boolean(decision?.plannerMeta?.fallbackUsed),
    backgroundResearchRequested: decision?.plannerMeta?.backgroundResearchRequested === true,
    backgroundResearchQuery: normalizeText(decision?.plannerMeta?.backgroundResearchQuery),
    backgroundResearchReason: normalizeText(decision?.plannerMeta?.backgroundResearchReason),
    personaModules,
    dynamicPromptPlan,
    memosRecall: normalizeObject(decision?.memosRecall || decision?.plannerMeta?.memosRecall || options.memosRecall, {}),
    plannerDecisionV2: decision,
    plannerProtocolVersion: normalizeText(decision?.plannerMeta?.protocolVersion) || PLANNER_PROTOCOL_VERSION
  };
}

module.exports = {
  callPlannerModelV2,
  callPlannerSubagentV2,
  convertPlannerDecisionToDirectChatDecision,
  planRequestV2
};

