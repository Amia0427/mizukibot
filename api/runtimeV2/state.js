// @ts-check
const { Annotation } = require('@langchain/langgraph');
const {
  normalizeArray,
  normalizeObject
} = require('./contracts');
const { filterAllowedToolNames } = require('../../utils/localToolAccess');
const { cloneTraceForMeta, normalizeRequestTrace } = require('../../utils/requestTrace');

function appendReducer(left, right) {
  const base = Array.isArray(left) ? left : [];
  const incoming = Array.isArray(right) ? right : [right];
  return base.concat(incoming.filter((item) => item !== undefined));
}

function replaceReducer(_left, right) {
  return right;
}

const GraphStateV2 = Annotation.Root({
  request: Annotation({
    value: replaceReducer,
    default: () => ({})
  }),
  thread: Annotation({
    value: replaceReducer,
    default: () => ({})
  }),
  memory: Annotation({
    value: replaceReducer,
    default: () => ({})
  }),
  execution: Annotation({
    value: replaceReducer,
    default: () => ({})
  }),
  output: Annotation({
    value: replaceReducer,
    default: () => ({})
  }),
  messages: Annotation({
    value: replaceReducer,
    default: () => []
  }),
  events: Annotation({
    reducer: appendReducer,
    default: () => []
  })
});

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
  const nowTs = typeof options.nowTs === 'function'
    ? options.nowTs
    : Date.now;

  const normalizedAllowedTools = filterAllowedToolNames(
    normalizeToolNames(options.allowedTools),
    normalizeToolNames(routeMeta?.allowedTools)
  );
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
    deferPersist: Boolean(options.deferPersist),
    resumePolicy: String(options.resumePolicy || 'auto').trim().toLowerCase() || 'auto',
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
      humanizerInvoked: false,
      agent: {
        initialized: false,
        completed: false,
        pendingToolCalls: [],
        toolRoundCount: 0,
        toolCallCount: 0,
        toolHistory: [],
        completedToolCallIds: [],
        forceFinal: false,
        forceFinalAfterTools: false,
        stopReason: ''
      }
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
    execution,
    output: state.output,
    messages: state.messages
  };
}

module.exports = {
  GraphStateV2,
  appendReducer,
  createInitialState,
  snapshotState
};
