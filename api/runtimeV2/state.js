const { Annotation } = require('@langchain/langgraph');
const {
  normalizePlanStep,
  normalizeArray,
  normalizeObject,
  validatePlannerExecutionPlan
} = require('./contracts');
const { cloneTraceForMeta, normalizeRequestTrace } = require('../../utils/requestTrace');

function appendReducer(left, right) {
  const base = Array.isArray(left) ? left : [];
  const incoming = Array.isArray(right) ? right : [right];
  return base.concat(incoming.filter((item) => item !== undefined));
}

const GraphStateV2 = Annotation.Root({
  request: Annotation({
    default: () => ({})
  }),
  thread: Annotation({
    default: () => ({})
  }),
  memory: Annotation({
    default: () => ({})
  }),
  plan: Annotation({
    default: () => ({})
  }),
  execution: Annotation({
    default: () => ({})
  }),
  output: Annotation({
    default: () => ({})
  }),
  messages: Annotation({
    reducer: appendReducer,
    default: () => []
  }),
  events: Annotation({
    reducer: appendReducer,
    default: () => []
  })
});

function buildInitialPlanSlice(request = {}, options = {}) {
  const getToolPlannerExecutionPlan = typeof options.getToolPlannerExecutionPlan === 'function'
    ? options.getToolPlannerExecutionPlan
    : () => null;
  const normalizeDirectChatPlannerPlanStep = typeof options.normalizeDirectChatPlannerPlanStep === 'function'
    ? options.normalizeDirectChatPlannerPlanStep
    : ((step, index) => normalizePlanStep(step, 'direct_chat', index));
  const normalizeRoutePlanStep = typeof options.normalizeRoutePlanStep === 'function'
    ? options.normalizeRoutePlanStep
    : ((step, index) => normalizePlanStep(step, 'route', index));

  const plannerExecutionPlan = getToolPlannerExecutionPlan(request.routeMeta);
  const plannerValidation = plannerExecutionPlan
    ? validatePlannerExecutionPlan(plannerExecutionPlan, {
      allowedTools: request.allowedTools || request.routeMeta?.allowedTools || []
    })
    : {
      ok: true,
      status: 'not_applicable',
      reasons: [],
      steps: [],
      stepCount: 0,
      allowedToolNames: normalizeArray(request.allowedTools || request.routeMeta?.allowedTools)
    };
  const directPlannerSteps = plannerValidation.ok && Array.isArray(plannerExecutionPlan?.steps)
    ? plannerValidation.steps
    : [];
  const legacySteps = Array.isArray(request.routeMeta?.planSteps) ? request.routeMeta.planSteps : [];
  if (plannerExecutionPlan && !plannerValidation.ok) {
    return {
      status: 'idle',
      currentStepId: '',
      steps: [],
      planner: {
        legacyRoutePlanDetected: legacySteps.length > 0,
        directChatPlannerSingleAuthority: false,
        toolPlannerSingleAuthority: false,
        validation: plannerValidation
      },
      verification: null,
      rounds: [],
      finalPlan: {
        goal: String(request.question || '').trim(),
        need_tools: false,
        steps: []
      },
      finalExecLogs: [],
      lastRepairPlan: null
    };
  }
  const steps = directPlannerSteps.length > 0
    ? directPlannerSteps.map((step, index) => normalizeDirectChatPlannerPlanStep(step, index))
    : legacySteps.map((step, index) => normalizeRoutePlanStep(step, index));
  return {
    status: steps.length > 0 ? 'pending' : 'idle',
    currentStepId: steps[0]?.id || '',
    steps,
    planner: {
      legacyRoutePlanDetected: legacySteps.length > 0,
      directChatPlannerSingleAuthority: directPlannerSteps.length > 0,
      toolPlannerSingleAuthority: directPlannerSteps.length > 0,
      validation: plannerValidation
    },
    verification: null,
    rounds: [],
    finalPlan: null,
    finalExecLogs: [],
    lastRepairPlan: null
  };
}

function normalizeImageUrls(imageUrl = null, imageUrls = []) {
  const seen = new Set();
  const values = [];
  if (imageUrl) values.push(imageUrl);
  if (Array.isArray(imageUrls)) values.push(...imageUrls);
  return values
    .map((url) => String(url || '').trim())
    .filter((url) => {
      if (!url || seen.has(url)) return false;
      seen.add(url);
      return true;
    });
}

function createInitialState(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
  const inputRouteMeta = normalizeObject(options.routeMeta, null);
  const requestTrace = normalizeRequestTrace(options.requestTrace)
    || normalizeRequestTrace(inputRouteMeta?.requestTrace);
  const routeMeta = inputRouteMeta && requestTrace
    ? { ...inputRouteMeta, requestTrace: cloneTraceForMeta(requestTrace) }
    : inputRouteMeta;
  const normalizeToolNames = typeof options.normalizeToolNames === 'function'
    ? options.normalizeToolNames
    : (value) => (Array.isArray(value) ? value : []);
  const resolveShortTermSessionKey = typeof options.resolveShortTermSessionKey === 'function'
    ? options.resolveShortTermSessionKey
    : () => '';
  const resolveThreadId = typeof options.resolveThreadId === 'function'
    ? options.resolveThreadId
    : () => '';
  const shouldUseMinecraftLLM = typeof options.shouldUseMinecraftLLM === 'function'
    ? options.shouldUseMinecraftLLM
    : () => false;
  const getMinecraftModelOverrides = typeof options.getMinecraftModelOverrides === 'function'
    ? options.getMinecraftModelOverrides
    : () => null;
  const resolveShortTermScope = typeof options.resolveShortTermScope === 'function'
    ? options.resolveShortTermScope
    : () => '';
  const createMemoryCliTurnState = typeof options.createMemoryCliTurnState === 'function'
    ? options.createMemoryCliTurnState
    : (() => ({}));
  const buildInitialPlanSliceImpl = typeof options.buildInitialPlanSlice === 'function'
    ? options.buildInitialPlanSlice
    : ((request) => buildInitialPlanSlice(request, options));
  const nowTs = typeof options.nowTs === 'function'
    ? options.nowTs
    : Date.now;

  const normalizedAllowedTools = normalizeToolNames(options.allowedTools);
  const sessionKey = String(resolveShortTermSessionKey(userId, routeMeta) || '').trim();
  const threadId = resolveThreadId({
    userId,
    routePolicyKey: options.routePolicyKey,
    reviewMode: options.reviewMode,
    routeMeta,
    sessionKey,
    imageUrl,
    options
  });
  const useMinecraftModel = shouldUseMinecraftLLM(question, options.routePrompt);
  const imageUrls = normalizeImageUrls(imageUrl, options.imageUrls);
  const latencyDecision = normalizeObject(options.latencyDecision, {
    profile: 'chat_fast',
    prepareSoftBudgetMs: 600,
    memoryBudgetMs: 300,
    continuityBudgetMs: 250,
    preflightBudgetMs: 350,
    humanizeBudgetMs: 500,
    humanizeMode: 'auto',
    deferPersist: true
  });
  const request = {
    question: String(question || ''),
    runtimeQuestionText: String(options.runtimeQuestionText || routeMeta?.runtimeQuestionText || question || ''),
    persistUserText: String(options.persistUserText || routeMeta?.persistUserText || options.runtimeQuestionText || routeMeta?.runtimeQuestionText || question || ''),
    originalUserText: String(options.originalUserText || routeMeta?.originalUserText || question || ''),
    userInfo: normalizeObject(userInfo, { level: 'stranger' }),
    userId: String(userId || ''),
    customPrompt,
    imageUrl,
    imageUrls,
    routePrompt: String(options.routePrompt || '').trim(),
    routePolicyKey: String(options.routePolicyKey || '').trim(),
    routeDebugKey: String(options.routeDebugKey || routeMeta?.routeDebugKey || routeMeta?.route_debug_key || '').trim(),
    topRouteType: String(options.topRouteType || routeMeta?.topRouteType || '').trim(),
    dispatchBranch: String(options.dispatchBranch || routeMeta?.dispatchBranch || '').trim(),
    triggerBranch: String(options.triggerBranch || '').trim(),
    reviewMode: String(options.reviewMode || '').trim(),
    routeMeta,
    requestTrace: cloneTraceForMeta(requestTrace),
    visualContext: normalizeObject(options.visualContext || routeMeta?.visualContext, null),
    allowedTools: normalizedAllowedTools,
    allowTools: options.disableTools ? false : true,
    streaming: Boolean(options.streaming),
    disableStream: Boolean(options.disableStream),
    disableDirectToolLoop: Boolean(options.disableDirectToolLoop),
    deferPersist: Boolean(options.deferPersist),
    resumePolicy: String(options.resumePolicy || 'auto').trim().toLowerCase() || 'auto',
    forcePlanMode: Boolean(options.forcePlanMode),
    systemInitiated: Boolean(options.systemInitiated),
    useMinecraftModel,
    modelConfig: useMinecraftModel
      ? getMinecraftModelOverrides()
      : (options.modelConfig && typeof options.modelConfig === 'object' ? { ...options.modelConfig } : null),
    sessionKey,
    onEvent: options.onEvent,
    onDelta: options.onDelta,
    disableMemoryLearning: Boolean(options.disableMemoryLearning)
  };

  return {
    request,
    thread: {
      threadId,
      sessionKey,
      sessionScope: resolveShortTermScope(userId, routeMeta, sessionKey),
      checkpointStatus: 'idle',
      resumeUsed: false,
      currentNode: '',
      updatedAt: nowTs()
    },
    memory: {
      dynamicPrompt: '',
      stableSystemBlocks: [],
      dynamicContextBlocks: [],
      assistantOnlyContextBlocks: [],
      promptSnapshot: null,
      promptSegments: null,
      securityLabels: [],
      blockedLearningEvents: [],
      redactionEvents: [],
      affinity: null,
      context: null,
      dirty: false,
      restoredBridge: false,
      memoryScopeRecorded: false,
      persisted: false,
      learningQueued: false,
      globalToolEvidence: '',
      globalToolResults: []
    },
    plan: buildInitialPlanSliceImpl(request),
    execution: {
      status: 'idle',
      mode: '',
      currentNode: '',
      route: '',
      attempts: 0,
      toolCalls: [],
      toolResults: [],
      retryQueue: [],
      parallelExecution: false,
      memoryCliTurn: createMemoryCliTurnState(),
      resumedFromNode: '',
      pendingInterrupt: false,
      latencyDecision,
      pendingReplySnapshot: {
        finalReply: '',
        activeTopic: '',
        openLoops: [],
        assistantCommitments: [],
        userConstraints: [],
        toolSummary: ''
      },
      cacheStats: {
        promptCacheHit: false,
        memoryCacheHit: false,
        toolCacheHitCount: 0
      },
      latencyBreakdown: {},
      deferredJobs: [],
      firstAssistantReused: false,
      humanizerInvoked: false
    },
    output: {
      draftReply: '',
      finalReply: '',
      streamText: '',
      failure: null,
      stream: {
        hadOutput: Boolean(options.streamHadOutput),
        completed: false,
        fallbackToNonStream: false,
        mode: options.streaming ? (imageUrl ? 'none' : 'direct') : 'none'
      }
    },
    messages: [],
    events: []
  };
}

function snapshotState(state) {
  const memory = normalizeObject(state.memory, {});
  const execution = normalizeObject(state.execution, {});
  const promptSnapshot = normalizeObject(memory.promptSnapshot, null);
  const promptSegments = normalizeObject(memory.promptSegments, null);
  const contextStats = normalizeObject(memory.contextStats, null);
  const mainConversationSnapshot = normalizeObject(memory.mainConversationSnapshot, null);
  const compactContextStats = contextStats || (mainConversationSnapshot
    ? {
        usageRatio: Number(mainConversationSnapshot?.snapshotMeta?.compactionDiagnostics?.usageRatio || 0) || 0,
        compactionLevel: String(mainConversationSnapshot?.snapshotMeta?.compactionDiagnostics?.level || 'normal').trim() || 'normal'
      }
    : null);

  return {
    request: state.request,
    thread: state.thread,
    memory: {
      dynamicPrompt: String(memory.dynamicPrompt || ''),
      stableSystemBlocks: normalizeArray(memory.stableSystemBlocks),
      dynamicContextBlocks: normalizeArray(memory.dynamicContextBlocks),
      assistantOnlyContextBlocks: normalizeArray(memory.assistantOnlyContextBlocks),
      promptSnapshot: promptSnapshot
        ? {
            stableBlockIds: normalizeArray(promptSnapshot.stableBlockIds),
            dynamicBlockIds: normalizeArray(promptSnapshot.dynamicBlockIds),
            assistantOnlyBlockIds: normalizeArray(promptSnapshot.assistantOnlyBlockIds),
            cacheFriendlyFingerprint: String(promptSnapshot.cacheFriendlyFingerprint || '').trim(),
            cacheMeta: normalizeObject(promptSnapshot.cacheMeta, {}),
            freshness: normalizeObject(promptSnapshot.freshness, {}),
            dynamicPromptPlan: normalizeObject(promptSnapshot.dynamicPromptPlan, null)
          }
        : null,
      promptSegments: promptSegments
        ? {
            cacheMeta: normalizeObject(promptSegments.cacheMeta, {}),
            freshness: normalizeObject(promptSegments.freshness, {}),
            securityLabels: normalizeArray(promptSegments.securityLabels),
            activatedPersonaModules: normalizeArray(promptSegments.activatedPersonaModules),
            personaModuleCandidates: normalizeArray(promptSegments.personaModuleCandidates)
          }
        : null,
      securityLabels: normalizeArray(memory.securityLabels),
      blockedLearningEvents: normalizeArray(memory.blockedLearningEvents),
      redactionEvents: normalizeArray(memory.redactionEvents),
      affinity: memory.affinity || null,
      context: memory.context || null,
      personaMemoryState: memory.personaMemoryState || null,
      dirty: Boolean(memory.dirty),
      restoredBridge: Boolean(memory.restoredBridge),
      memoryScopeRecorded: Boolean(memory.memoryScopeRecorded),
      persisted: Boolean(memory.persisted),
      learningQueued: Boolean(memory.learningQueued),
      globalToolEvidence: String(memory.globalToolEvidence || ''),
      globalToolResults: normalizeArray(memory.globalToolResults),
      globalToolMemoryCliTurn: memory.globalToolMemoryCliTurn || null,
      continuityState: memory.continuityState || null,
      contextStats: compactContextStats,
      pendingReplySnapshot: memory.pendingReplySnapshot || null,
      checkpointCompacted: true
    },
    plan: state.plan,
    execution: {
      ...execution,
      directChatToolCompile: execution.directChatToolCompile
        ? {
            enabled: Boolean(execution.directChatToolCompile.enabled),
            assistantMessage: execution.directChatToolCompile.assistantMessage || null,
            directContext: execution.directChatToolCompile.directContext || null
          }
        : undefined
    },
    output: state.output,
    messages: state.messages
  };
}

function normalizePlanForResume(plan = {}) {
  const steps = normalizeArray(plan.steps).map((step, index) => normalizePlanStep(step, String(step?.source || 'planner').trim() || 'planner', index));

  return {
    ...normalizeObject(plan, {}),
    status: String(plan?.status || (steps.length > 0 ? 'pending' : 'idle')).trim() || 'idle',
    currentStepId: String(plan?.currentStepId || steps[0]?.id || '').trim(),
    steps,
    planner: normalizeObject(plan?.planner, {}),
    verification: plan?.verification ? normalizeObject(plan.verification, {}) : null,
    rounds: normalizeArray(plan?.rounds),
    finalPlan: plan?.finalPlan ? normalizeObject(plan.finalPlan, {}) : null,
    finalExecLogs: normalizeArray(plan?.finalExecLogs),
    lastRepairPlan: plan?.lastRepairPlan ? normalizeObject(plan.lastRepairPlan, {}) : null
  };
}

function translatePlan(rawPlan = {}, options = {}) {
  const normalizePlannedStep = typeof options.normalizePlannedStep === 'function'
    ? options.normalizePlannedStep
    : ((step, index) => normalizePlanStep(step, 'planner', index));
  const steps = normalizeArray(rawPlan?.steps).map((step, index) => normalizePlannedStep(step, index));
  return {
    status: steps.length > 0 ? 'planned' : 'idle',
    currentStepId: steps[0]?.id || '',
    steps,
    planner: {
      rawPlan
    },
    verification: null,
    rounds: [],
    finalPlan: {
      goal: String(rawPlan?.goal || '').trim(),
      need_tools: Boolean(rawPlan?.need_tools),
      steps: steps.map((step) => ({
        id: step.id,
        action: step.kind === 'reply' ? 'reply' : step.tool,
        args: step.inputs || {},
        purpose: step.instruction || step.successCriteria || '',
        dependsOn: normalizeArray(step.dependsOn),
        parallelGroup: String(step.parallelGroup || '').trim(),
        sideEffect: Boolean(step.sideEffect),
        evidenceRequirement: normalizeObject(step.evidenceRequirement, {}),
        repairPolicy: normalizeObject(step.repairPolicy, {}),
        runtimeBinding: step.runtimeBinding === null ? null : normalizeObject(step.runtimeBinding, {})
      }))
    },
    finalExecLogs: [],
    lastRepairPlan: null
  };
}

function rebuildFinalPlanFromSteps(state) {
  const request = normalizeObject(state.request, {});
  const planSteps = normalizeArray(state.plan?.steps);
  return {
    goal: String(state.plan?.finalPlan?.goal || request.question || '').trim(),
    need_tools: planSteps.some((step) => step.kind !== 'reply'),
    steps: planSteps.map((step) => ({
      id: step.id,
      action: step.kind === 'reply' ? 'reply' : step.tool,
      args: step.inputs || {},
      purpose: step.instruction || step.successCriteria || '',
      dependsOn: normalizeArray(step.dependsOn),
      parallelGroup: String(step.parallelGroup || '').trim(),
      sideEffect: Boolean(step.sideEffect),
      evidenceRequirement: normalizeObject(step.evidenceRequirement, {}),
      repairPolicy: normalizeObject(step.repairPolicy, {}),
      runtimeBinding: step.runtimeBinding === null ? null : normalizeObject(step.runtimeBinding, {})
    }))
  };
}

function buildReplyOnlyPlan(question = '', planner = {}) {
  return {
    status: 'planned',
    currentStepId: '',
    steps: [],
    planner: normalizeObject(planner, {}),
    verification: null,
    rounds: [],
    finalPlan: {
      goal: String(question || '').trim(),
      need_tools: false,
      steps: []
    },
    finalExecLogs: [],
    lastRepairPlan: null
  };
}

function buildExecLogsFromSteps(steps = []) {
  const logs = [];
  for (const step of normalizeArray(steps)) {
    if (step.kind === 'reply') {
      logs.push({
        id: step.id,
        action: 'reply',
        args: step.inputs || {},
        purpose: step.instruction || step.successCriteria || '',
        ok: true,
        result: 'No tool execution required for this step',
        error: '',
        batchId: String(step.batchId || '').trim(),
        batchIndex: Number.isFinite(Number(step.batchIndex)) ? Number(step.batchIndex) : null
      });
      continue;
    }

    const latestEnvelope = normalizeArray(step.evidence).slice(-1)[0] || null;
    logs.push({
      id: step.id,
      action: step.tool,
      args: step.inputs || {},
      purpose: step.instruction || step.successCriteria || '',
      ok: latestEnvelope ? latestEnvelope.status === 'completed' : false,
      result: latestEnvelope && latestEnvelope.status === 'completed' ? String(latestEnvelope.result || '') : '',
      error: latestEnvelope && latestEnvelope.status !== 'completed'
        ? String(latestEnvelope.result || step.blockingReason || 'tool failed')
        : '',
      unsatisfiedRequirement: String(latestEnvelope?.unsatisfiedRequirement || '').trim(),
      runtimeBinding: latestEnvelope?.runtimeBinding === null ? null : normalizeObject(latestEnvelope?.runtimeBinding, step.runtimeBinding),
      dependsOn: normalizeArray(step.dependsOn),
      evidenceRequirement: normalizeObject(step.evidenceRequirement, {}),
      repairPolicy: normalizeObject(step.repairPolicy, {}),
      batchId: String(latestEnvelope?.batch_id || step.batchId || '').trim(),
      batchIndex: Number.isFinite(Number(latestEnvelope?.batch_index))
        ? Number(latestEnvelope.batch_index)
        : (Number.isFinite(Number(step.batchIndex)) ? Number(step.batchIndex) : null)
    });
  }
  return logs;
}

function findEvidenceEnvelope(step = {}, argsHash = '') {
  const evidences = normalizeArray(step?.evidence);
  for (let index = evidences.length - 1; index >= 0; index -= 1) {
    const item = evidences[index];
    if (String(item?.args_hash || '').trim() === String(argsHash || '').trim()) {
      return item;
    }
  }
  return null;
}

function isCompletedSideEffectStep(step = {}) {
  const evidences = normalizeArray(step?.evidence);
  if (String(step?.status || '').trim() !== 'completed' || evidences.length === 0) return false;
  const latest = evidences[evidences.length - 1];
  return Boolean(latest?.side_effect) && String(latest?.status || '').trim() === 'completed';
}

module.exports = {
  GraphStateV2,
  appendReducer,
  buildInitialPlanSlice,
  buildExecLogsFromSteps,
  buildReplyOnlyPlan,
  createInitialState,
  findEvidenceEnvelope,
  isCompletedSideEffectStep,
  normalizePlanForResume,
  rebuildFinalPlanFromSteps,
  snapshotState,
  translatePlan
};
