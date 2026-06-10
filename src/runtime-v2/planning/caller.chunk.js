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

function getMemoryRecallObservability() {
  return require('../../../utils/memoryRecallObservability');
}

function getOpenVikingRecallRuntime() {
  return require('../../../utils/openVikingMemory/recall');
}

function getOpenVikingDeduper() {
  return require('../../../utils/openVikingMemory/deduper');
}

function attachExternalRecallToPlannerDecision(decision = {}, options = {}) {
  const normalizedDecision = normalizeObject(decision, {});
  const memosRecall = normalizeObject(
    normalizedDecision.memosRecall
    || normalizedDecision.plannerMeta?.memosRecall
    || options.memosRecall,
    {}
  );
  const memosRecallText = normalizeText(
    normalizedDecision.memosRecallText
    || normalizedDecision.plannerMeta?.memosRecallText
    || options.memosRecallText
  );
  const openVikingRecall = normalizeObject(
    normalizedDecision.openVikingRecall
    || normalizedDecision.openvikingRecall
    || normalizedDecision.plannerMeta?.openVikingRecall
    || normalizedDecision.plannerMeta?.openvikingRecall
    || options.openVikingRecall,
    {}
  );
  const openVikingRecallText = normalizeText(
    normalizedDecision.openVikingRecallText
    || normalizedDecision.openvikingRecallText
    || normalizedDecision.plannerMeta?.openVikingRecallText
    || normalizedDecision.plannerMeta?.openvikingRecallText
    || options.openVikingRecallText
  );
  const patch = {};
  if (Object.keys(memosRecall).length > 0) patch.memosRecall = memosRecall;
  if (memosRecallText) patch.memosRecallText = memosRecallText;
  if (Object.keys(openVikingRecall).length > 0) patch.openVikingRecall = openVikingRecall;
  if (openVikingRecallText) patch.openVikingRecallText = openVikingRecallText;
  if (Object.keys(patch).length === 0) return normalizedDecision;
  return {
    ...normalizedDecision,
    ...patch,
    plannerMeta: {
      ...normalizeObject(normalizedDecision.plannerMeta, {}),
      ...patch
    }
  };
}

function normalizePlannerPositiveInt(value, fallback = 1, min = 1, max = 3) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return Math.max(min, Math.min(max, fallback));
  return Math.max(min, Math.min(max, number));
}

function getPlannerMaxModelCalls(options = {}) {
  const optionConfig = normalizeObject(options.config, {});
  return normalizePlannerPositiveInt(
    options.plannerMaxModelCalls
      ?? optionConfig.PLANNER_MAX_MODEL_CALLS
      ?? config.PLANNER_MAX_MODEL_CALLS
      ?? 1,
    1,
    1,
    1
  );
}

function isPlannerSemanticRefineEnabled(options = {}) {
  const optionConfig = normalizeObject(options.config, {});
  if (options.plannerSemanticRefineEnabled === false || options.semanticRefineEnabled === false) return false;
  if (optionConfig.PLANNER_SEMANTIC_REFINE_ENABLED === false) return false;
  return config.PLANNER_SEMANTIC_REFINE_ENABLED !== false;
}

function getPlannerSemanticConfidenceThreshold(options = {}) {
  const optionConfig = normalizeObject(options.config, {});
  const value = Number(
    options.plannerSemanticConfidenceThreshold
      ?? optionConfig.PLANNER_SEMANTIC_CONFIDENCE_THRESHOLD
      ?? config.PLANNER_SEMANTIC_CONFIDENCE_THRESHOLD
      ?? 0.72
  );
  if (!Number.isFinite(value)) return 0.72;
  return Math.max(0, Math.min(1, value));
}

function readPlannerSemanticConfidence(output = {}) {
  const meta = normalizeObject(output?.plannerMeta, {});
  const assessment = normalizeObject(meta.semanticAssessment || output?.semanticAssessment, {});
  const value = Number(
    meta.semanticConfidence
      ?? assessment.confidence
      ?? output?.semanticConfidence
  );
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
}

function plannerOutputHasDecisionShape(output = {}) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  if (Object.keys(output).length === 0) return false;
  if (normalizeText(output.mode)) return true;
  if (Array.isArray(output.steps)) return true;
  if (Array.isArray(output.allowedToolNames)) return true;
  if (output.dynamicPromptPlan && typeof output.dynamicPromptPlan === 'object') return true;
  if (output.plannerMeta && typeof output.plannerMeta === 'object') return true;
  return false;
}

function getPlannerSemanticRefineReasons(output = null, options = {}) {
  const reasons = [];
  if (!plannerOutputHasDecisionShape(output)) {
    reasons.push(output && typeof output === 'object' ? 'empty_planner_output' : 'invalid_planner_json');
    return reasons;
  }
  const meta = normalizeObject(output.plannerMeta, {});
  const assessment = normalizeObject(meta.semanticAssessment || output.semanticAssessment, {});
  const confidence = readPlannerSemanticConfidence(output);
  if (
    meta.needsSemanticRefinement === true
    || meta.semanticRefinementRequested === true
    || assessment.needsRefinement === true
    || normalizeText(assessment.action).toLowerCase() === 'semantic_refine'
  ) {
    reasons.push('requested_semantic_refinement');
  }
  if (confidence !== null && confidence < getPlannerSemanticConfidenceThreshold(options)) {
    reasons.push('low_semantic_confidence');
  }
  const mode = normalizeText(output.mode);
  const allowed = normalizeToolNames(output.allowedToolNames);
  if (mode === 'tool_plan' && (allowed.length === 0 || normalizeArray(output.steps).length === 0)) {
    reasons.push('incomplete_tool_plan');
  }
  return Array.from(new Set(reasons));
}

function summarizePlannerDecisionForRefine(output = {}) {
  const meta = normalizeObject(output?.plannerMeta, {});
  const dynamicPromptPlan = normalizeObject(output?.dynamicPromptPlan || meta.dynamicPromptPlan, {});
  return {
    mode: normalizeText(output?.mode),
    taskShape: normalizeText(output?.taskShape),
    allowedToolNames: normalizeToolNames(output?.allowedToolNames),
    stepTools: normalizeArray(output?.steps).map((step) => normalizeText(step?.tool)).filter(Boolean),
    personaModules: normalizeArray(output?.personaModules || meta.personaModules).map((item) => normalizeText(item)).filter(Boolean),
    enabledBlockIds: normalizeArray(dynamicPromptPlan.enabledBlockIds).map((item) => normalizeText(item)).filter(Boolean),
    semanticConfidence: readPlannerSemanticConfidence(output),
    semanticAssessment: normalizeObject(meta.semanticAssessment || output?.semanticAssessment, {}),
    reason: clampReason(normalizeText(meta.reason), 180)
  };
}

function buildPlannerSemanticRefinementPayload({ route = {}, output = null, reasons = [], attempt = 1, maxCalls = 1 } = {}) {
  return {
    schemaVersion: 'planner_semantic_refinement_v1',
    attempt,
    maxCalls,
    reasons: normalizeArray(reasons).map((item) => normalizeText(item)).filter(Boolean),
    currentQuestion: normalizeText(route?.question || route?.cleanText),
    instruction: [
      'Re-evaluate the user intent, source scope, temporal need, context dependencies, and tool/context selection.',
      'Correct any overly broad chat-only choice, generic tool substitution, missing dynamic context block, or incomplete execution graph.',
      'Return the final planner JSON only; include plannerMeta.semanticAssessment and a calibrated semanticConfidence.'
    ].join(' '),
    previousDecision: output && typeof output === 'object'
      ? summarizePlannerDecisionForRefine(output)
      : null
  };
}

function buildPlannerModelAttemptMeta(attempts = [], maxCalls = 1) {
  const normalizedAttempts = normalizeArray(attempts).map((attempt) => ({
    attempt: normalizePlannerPositiveInt(attempt.attempt, 1, 1, 10),
    ok: attempt.ok === true,
    reasons: normalizeArray(attempt.reasons).map((item) => normalizeText(item)).filter(Boolean),
    semanticConfidence: attempt.semanticConfidence === null || attempt.semanticConfidence === undefined
      ? null
      : Math.max(0, Math.min(1, Number(attempt.semanticConfidence))),
    refinedNext: attempt.refinedNext === true
  }));
  return {
    totalModelCalls: normalizedAttempts.length,
    maxModelCalls: maxCalls,
    refined: normalizedAttempts.some((attempt) => attempt.refinedNext),
    triggerReasons: Array.from(new Set(normalizedAttempts.flatMap((attempt) => attempt.reasons))),
    attempts: normalizedAttempts
  };
}

function attachPlannerModelAttemptMeta(decision = {}, attemptMeta = {}) {
  const meta = normalizeObject(attemptMeta, {});
  if (!decision || typeof decision !== 'object' || Object.keys(meta).length === 0) return decision;
  const existingMeta = normalizeObject(decision.plannerMeta?.semanticRefinement, {});
  const mergedMeta = {
    ...existingMeta,
    ...meta,
    triggerReasons: Array.from(new Set(
      normalizeArray(existingMeta.triggerReasons)
        .concat(normalizeArray(meta.triggerReasons))
        .map((item) => normalizeText(item))
        .filter(Boolean)
    )),
    attempts: normalizeArray(meta.attempts).length > 0
      ? normalizeArray(meta.attempts)
      : normalizeArray(existingMeta.attempts)
  };
  const next = {
    ...decision,
    plannerMeta: {
      ...normalizeObject(decision.plannerMeta, {}),
      semanticRefinement: mergedMeta
    }
  };
  if (next.validation && typeof next.validation === 'object') {
    next.validation = {
      ...next.validation,
      plannerMeta: {
        ...normalizeObject(next.validation.plannerMeta, {}),
        semanticRefinement: mergedMeta
      }
    };
  }
  return next;
}

async function callPlannerModelAttemptV2(route = {}, options = {}) {
  const apiBaseUrl = getPlannerApiBaseUrlV2();
  const apiKey = getPlannerApiKeyV2();
  if (!apiBaseUrl || !apiKey) return null;
  const { requestBody } = buildPlannerModelRequestBody(route, options);
  requestBody.__timeoutMs = Number(config.PLANNER_REQUEST_TIMEOUT_MS || 60000);
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
  return {
    output: extractJsonSafely(rawText),
    rawText
  };
}

async function callPlannerModelV2(route = {}, options = {}) {
  const attempt = await callPlannerModelAttemptV2(route, options);
  return attempt?.output || null;
}

async function callPlannerModelWithSemanticRefinement(route = {}, options = {}, latencyMeta = {}) {
  const maxCalls = getPlannerMaxModelCalls(options);
  const attempts = [];
  const refineEnabled = isPlannerSemanticRefineEnabled(options) && maxCalls > 1;
  let refinement = normalizeObject(options.semanticRefinement, null);
  let lastOutput = null;

  for (let index = 0; index < maxCalls; index += 1) {
    const attemptOptions = refinement
      ? { ...options, semanticRefinement: refinement }
      : options;
    const modelStartedAt = nowMs();
    const attemptResult = await callPlannerModelAttemptV2(route, attemptOptions);
    addPlannerLatency(latencyMeta, 'planner_model_ms', modelStartedAt);
    const output = attemptResult?.output || null;
    const reasons = getPlannerSemanticRefineReasons(output, attemptOptions);
    const canRefineNext = refineEnabled && reasons.length > 0 && index + 1 < maxCalls;
    attempts.push({
      attempt: index + 1,
      ok: plannerOutputHasDecisionShape(output),
      reasons,
      semanticConfidence: readPlannerSemanticConfidence(output),
      refinedNext: canRefineNext
    });
    lastOutput = output;
    if (!canRefineNext) {
      return {
        output,
        attemptMeta: buildPlannerModelAttemptMeta(attempts, maxCalls)
      };
    }
    refinement = buildPlannerSemanticRefinementPayload({
      route,
      output,
      reasons,
      attempt: index + 1,
      maxCalls
    });
  }

  return {
    output: lastOutput,
    attemptMeta: buildPlannerModelAttemptMeta(attempts, maxCalls)
  };
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
  const rawMemosRecall = memosRecall && typeof memosRecall === 'object'
    ? {
        ...memosRecall,
        items: normalizeArray(memosRecall.items).map((item) => (item && typeof item === 'object' ? { ...item } : item)),
        diagnostics: normalizeObject(memosRecall.diagnostics, {})
      }
    : {};
  memosRecall = getMemoryRecallDeduper().dedupeMemosRecallAgainstMemoryContext(memosRecall || {}, memoryContext, {
    maxChars: normalizeObject(input.config, {}).MEMOS_RECALL_MAX_CHARS || config.MEMOS_RECALL_MAX_CHARS
  });
  const memosRecallText = getMemosPlannerRecall().getMemosRecallPromptText(memosRecall || {});
  const inputOpenVikingRecall = normalizeObject(
    input.openVikingRecall
    || input.openvikingRecall,
    normalizeObject(route?.meta?.openVikingRecall || route?.meta?.openvikingRecall, null)
  );
  let openVikingRecall = inputOpenVikingRecall && Object.keys(inputOpenVikingRecall).length > 0 ? inputOpenVikingRecall : null;
  if (!openVikingRecall) {
    const inputConfig = normalizeObject(input.config, {});
    openVikingRecall = await getOpenVikingRecallRuntime().recallOpenVikingForPrompt(route.question || route.cleanText, {
      ...input,
      routeMeta: route.meta,
      userId: normalizeText(input.userId || route?.meta?.userId),
      senderId: normalizeText(input.senderId || route?.meta?.senderId || route?.meta?.sender_id || input.userId || route?.meta?.userId),
      groupId: normalizeText(input.groupId || route?.meta?.groupId || route?.meta?.group_id),
      sessionKey: normalizeText(input.sessionKey || route?.meta?.sessionKey || route?.meta?.session_key),
      topRouteType: route.topRouteType,
      platform: route?.meta?.platform || route?.meta?.channel || 'qq',
      memoryContext,
      ...(Object.keys(inputConfig).length > 0 ? { config: inputConfig } : {})
    });
  }
  openVikingRecall = getOpenVikingDeduper().dedupeOpenVikingRecallAgainstMemoryContext(openVikingRecall || {}, memoryContext, {
    maxChars: normalizeObject(input.config, {}).OPENVIKING_RECALL_MAX_CHARS || config.OPENVIKING_RECALL_MAX_CHARS
  });
  const openVikingRecallText = getOpenVikingRecallRuntime().getOpenVikingRecallPromptText(openVikingRecall || {});
  getMemoryRecallObservability().recordMemosPlannerRecallObservation({
    requestTrace: input.requestTrace || route?.meta?.requestTrace || null,
    routeMeta: route.meta,
    userId: normalizeText(input.userId || route?.meta?.userId),
    topRouteType: route.topRouteType,
    query: route.question || route.cleanText,
    rawRecall: rawMemosRecall,
    dedupedRecall: memosRecall || {},
    memosRecallText,
    memoryContext,
    stage: 'planner_memos_recall'
  });
  const inputAvailableContextSignals = normalizeObject(input.availableContextSignals, normalizeObject(route?.meta?.availableContextSignals, {}));
  const availableContextSignals = memosRecallText
    ? { ...inputAvailableContextSignals, memosRecall: true }
    : { ...inputAvailableContextSignals };
  if (openVikingRecallText) availableContextSignals.openVikingRecall = true;
  const options = {
    userId: normalizeText(input.userId || route?.meta?.userId),
    allowedTools: normalizeArray(input.allowedTools),
    toolCatalog: normalizeArray(input.toolCatalog),
    contextSummary: normalizeText(input.contextSummary),
    continuitySignals: normalizeObject(input.continuitySignals, normalizeObject(route?.meta?.continuitySignals, {})),
    memoryContext,
    memosRecall: normalizeObject(memosRecall, {}),
    memosRecallText,
    openVikingRecall: normalizeObject(openVikingRecall, {}),
    openVikingRecallText,
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
    mainReplyPromptMode: normalizeText(input.mainReplyPromptMode || route?.meta?.mainReplyPromptMode),
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
    return attachExternalRecallToPlannerDecision(
      attachPlannerLatencyMeta(normalized, requestLatencyMeta),
      options
    );
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
    return attachExternalRecallToPlannerDecision(
      attachPlannerLatencyMeta(normalized, requestLatencyMeta),
      options
    );
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
        return attachExternalRecallToPlannerDecision(
          attachPlannerLatencyMeta(normalized, requestLatencyMeta),
          options
        );
      }
    } catch (_) {}
  }

  try {
    const plannerModelResult = await callPlannerModelWithSemanticRefinement(route, options, requestLatencyMeta);
    const plannerOutput = plannerModelResult?.output || null;
    if (plannerOutput && typeof plannerOutput === 'object') {
      const normalizeStartedAt = nowMs();
      const normalized = normalizePlannerDecisionV2(plannerOutput, route, {
        ...options,
        fallbackUsed: false,
        latencyMeta: requestLatencyMeta,
        plannerModelAttemptMeta: plannerModelResult?.attemptMeta
      });
      addPlannerLatency(requestLatencyMeta, 'planner_normalize_ms', normalizeStartedAt);
      return attachExternalRecallToPlannerDecision(
        attachPlannerLatencyMeta(
          attachPlannerModelAttemptMeta(normalized, plannerModelResult?.attemptMeta),
          requestLatencyMeta
        ),
        options
      );
    }
  } catch (_) {}

  const normalizeStartedAt = nowMs();
  const normalized = normalizePlannerDecisionV2(null, route, {
    ...options,
    fallbackUsed: true,
    latencyMeta: requestLatencyMeta
  });
  addPlannerLatency(requestLatencyMeta, 'planner_normalize_ms', normalizeStartedAt);
  return attachExternalRecallToPlannerDecision(
    attachPlannerLatencyMeta(normalized, requestLatencyMeta),
    options
  );
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
    memosRecallText: normalizeText(decision?.memosRecallText || decision?.plannerMeta?.memosRecallText || options.memosRecallText),
    openVikingRecall: normalizeObject(decision?.openVikingRecall || decision?.openvikingRecall || decision?.plannerMeta?.openVikingRecall || decision?.plannerMeta?.openvikingRecall || options.openVikingRecall, {}),
    openVikingRecallText: normalizeText(decision?.openVikingRecallText || decision?.openvikingRecallText || decision?.plannerMeta?.openVikingRecallText || decision?.plannerMeta?.openvikingRecallText || options.openVikingRecallText),
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

