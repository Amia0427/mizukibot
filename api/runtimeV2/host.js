// Primary LangGraph runtime host. New routing, recovery, eventing, and persist
// behavior belongs here or in the neutral helper modules it composes.
const crypto = require('crypto');
const { StateGraph, END } = require('@langchain/langgraph');
const config = require('../../config');
const { getToolExecutors } = require('../toolRegistry');
const {
  buildDynamicPrompt,
  buildVisionMessageContent,
  mergeAllowedToolsWithMemoryCli,
  shouldExposeMemoryCli,
  shouldBypassHumanizerForPolicy
} = require('./context/service');
const {
  buildPlan,
  synthesizeFromPlan
} = require('./planning/service');
const { sanitizeUserFacingText } = require('../../utils/userFacingText');
const {
  requestStreamingReply,
  finalizeStreamingReplyWithHumanizer,
  requestNonStreamingReply,
  requestAssistantMessage
} = require('./model/service');
const {
  normalizeArray: normalizeContractArray,
  normalizeExecutionEnvelope,
  normalizeObject: normalizeContractObject,
  normalizePlanStep,
  normalizeStepId: contractNormalizeStepId,
  normalizeText
} = require('./contracts');
const {
  GraphStateV2,
  buildInitialPlanSlice: buildInitialPlanSliceBase,
  buildExecLogsFromSteps,
  buildReplyOnlyPlan,
  createInitialState: createInitialStateBase,
  findEvidenceEnvelope,
  isCompletedSideEffectStep,
  normalizePlanForResume,
  rebuildFinalPlanFromSteps,
  snapshotState,
  translatePlan: translatePlanBase
} = require('./state');
const {
  buildDirectChatExecutionBatches,
  buildDirectChatToolStep,
  compileDirectChatToolCallsToPlan,
  isExcludedDirectChatToolName,
  parseToolCallArgs
} = require('./services/directChat');
const {
  createRouteAfterRoute,
  createRouteNode
} = require('./nodes/route');
const {
  createPlannerNode
} = require('./nodes/planner');
const {
  createFinalValidateNode
} = require('./nodes/finalValidate');
const {
  createDraftReplyNode,
  createRouteAfterDraftReply
} = require('./nodes/draftReply');
const {
  createDirectReplyNode,
  createRouteAfterDirectReply
} = require('./nodes/directReply');
const {
  createDispatchNode
} = require('./nodes/dispatch');
const {
  createHumanizeNode
} = require('./nodes/humanize');
const {
  createPrepareNode
} = require('./nodes/prepare');
const {
  createPersistNode
} = require('./nodes/persist');
const {
  createRepairOrContinueNode,
  createRouteAfterRepair
} = require('./nodes/repairOrContinue');
const {
  createRouteAfterValidate,
  createValidateNode
} = require('./nodes/validate');
const {
  buildExecutionBatches,
  executeBatch: executeCapabilityBatch,
  getCapabilityExecutors,
  resolveCapability,
  runCapabilityPreflight,
  shouldRunParallel
} = require('./capabilities/scheduler');
const { normalizeToolNames } = require('../../utils/localToolAccess');
const { getPolicy, enforceToolPolicy } = require('../../utils/toolPolicy');
const { shouldUseMinecraftLLM, getMinecraftModelOverrides } = require('../../utils/minecraftRouting');
const { appendDailyJournalEntry } = require('../../utils/dailyJournal');
const { runHumanizerAgent, isHumanizerAgentEnabled } = require('../humanizerAgent');
const {
  chatHistory,
  shortTermMemory,
  addProfileItem
} = require('../../utils/memory');
const {
  compressShortTermHistoryIfNeeded,
  buildShortTermContextMessages,
  appendShortTermHistory,
  rehydrateShortTermMemoryAfterRestartIfNeeded,
  resolveShortTermSessionKey,
  resolveShortTermScope,
  buildStructuredCompressionPrompt
} = require('../../utils/shortTermMemory');
const {
  estimateMessagesTokens,
  trimMessagesByTokenBudget
} = require('../../utils/contextBudget');
const { resolveModelTokenLimit } = require('../../utils/contextInspector');
const { buildContextCompactionPlan } = require('../../utils/contextCompaction');
const {
  restoreShortTermBridgeAfterRestartIfNeeded,
  persistShortTermBridgeSnapshot
} = require('../../utils/shortTermBridgeMemory');
const { recordMemoryScope } = require('../../utils/memoryScopeIndex');
const { learnSomethingNew } = require('../memoryExtraction');
const { postWithRetry } = require('../httpClient');
const { extractMessageContent } = require('../parser');
const { isReplyFailure, classifyReplyFailure } = require('../../utils/replyFailure');
const { verifyExecutionResult, buildRepairPlan } = require('../../utils/agentLoop');
const {
  captureToolFailure,
  learnSelfImprovement
} = require('../../utils/selfImprovementRuntime');
const { createCheckpointStore, resolveThreadId } = require('../../utils/langgraphV2Store');
const { getPostReplyJobQueue } = require('../../utils/postReplyJobQueue');
const {
  createMemoryCliTurnState,
  decideMemoryCliTurnAction,
  filterAllowedToolsForMemoryCliTurn,
  safeParseMemoryCliResult,
  updateMemoryCliTurnStateAfterError,
  updateMemoryCliTurnStateAfterResult
} = require('../../utils/memoryCliTurnPolicy');
const {
  classifyRecallFacet,
  shouldBiasToContinuity,
  shouldPrioritizeMemoryProbe
} = require('../../utils/recallHeuristics');
const { buildContinuityState } = require('../../utils/continuityState');

function nowTs() {
  return Date.now();
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' ? value : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
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

function buildV2CanonicalSegments(state, input = {}) {
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
  const maxOutputTokens = Math.max(64, Number(input.maxOutputTokens || request.modelConfig?.maxTokens || config.AI_MAX_TOKENS || 3500) || 3500);

  const segments = {
    system_prompt: systemPromptMessages,
    route_prompt: routePromptMessages,
    continuity_state: continuityMessages,
    short_term_summary: shortTermSummaryMessages,
    recent_history: recentHistoryMessages,
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

function pickRouteMetaForPostReplyJob(routeMeta = {}) {
  const source = normalizeObject(routeMeta, {});
  return {
    groupId: String(source.groupId || source.group_id || '').trim(),
    sessionId: String(source.sessionId || source.session_id || '').trim(),
    taskType: String(source.taskType || source.task_type || '').trim(),
    agentName: String(source.agentName || source.agent_name || '').trim(),
    toolName: String(source.toolName || source.tool_name || '').trim(),
    channelId: String(source.channelId || source.channel_id || '').trim(),
    topRouteType: String(source.topRouteType || '').trim()
  };
}

function lastNonEmpty(items = []) {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const value = String(items[i] || '').trim();
    if (value) return value;
  }
  return '';
}

function isReviewMode(reviewMode = '') {
  return Boolean(String(reviewMode || '').trim());
}

function isChatLikeRoute(request = {}) {
  const routeMeta = normalizeObject(request.routeMeta, {});
  const routePolicyKey = String(request.routePolicyKey || '').trim().toLowerCase();
  const topRouteType = String(request.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
  if (request.systemInitiated) return false;
  if (isReviewMode(request.reviewMode)) return false;
  if (!topRouteType && !routePolicyKey) return true;
  return (
    topRouteType === 'direct_chat'
    || routePolicyKey.startsWith('direct_chat/')
  );
}

function isDirectChatRequest(request = {}) {
  const routeMeta = normalizeObject(request.routeMeta, {});
  const routePolicyKey = String(request.routePolicyKey || '').trim().toLowerCase();
  const topRouteType = String(request.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
  return topRouteType === 'direct_chat' || routePolicyKey.startsWith('direct_chat/');
}

function shouldQueueMemoryLearningForV2(request = {}, finalReply = '') {
  if (!config.MEMORY_LEARNING_ENABLED) return false;
  if (request.disableMemoryLearning) return false;
  if (request.systemInitiated) return false;
  if (String(request.customPrompt || '').trim()) return false;
  if (isReviewMode(request.reviewMode)) return false;

  const uid = String(request.userId || '').trim();
  const q = String(request.question || '').trim();
  const a = String(finalReply || '').trim();
  if (!uid || !q || !a) return false;
  if (isReplyFailure(a, { emptyIsFailure: true })) return false;

  const routeMeta = normalizeObject(request.routeMeta, {});
  const routePolicyKey = String(request.routePolicyKey || '').trim().toLowerCase();
  const topRouteType = String(request.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
  if (!topRouteType && !routePolicyKey) return true;
  if (new Set(['admin', 'ignore', 'refuse']).has(topRouteType || '')) return false;

  const hasGroupId = Boolean(String(routeMeta.groupId || routeMeta.group_id || '').trim());
  const hasTaskContext = Boolean(
    String(routeMeta.taskType || routeMeta.task_type || '').trim()
    || String(routeMeta.toolName || routeMeta.tool_name || '').trim()
    || String(routeMeta.agentName || routeMeta.agent_name || '').trim()
  );

  if (topRouteType === 'direct_chat') return true;
  if (hasGroupId) return true;
  if (hasTaskContext) return true;
  return routePolicyKey.startsWith('direct_chat/');
}

function shouldAppendDailyJournalForV2(request = {}, finalReply = '') {
  if (!config.DAILY_JOURNAL_ENABLED) return false;
  if (request.disableDailyJournal) return false;
  if (request.systemInitiated) return false;
  if (String(request.customPrompt || '').trim()) return false;

  const uid = String(request.userId || '').trim();
  const q = String(request.question || '').trim();
  const a = String(finalReply || '').trim();
  if (!uid || !q || !a) return false;
  if (isReplyFailure(a, { emptyIsFailure: true })) return false;

  const routeMeta = normalizeObject(request.routeMeta, {});
  const routePolicyKey = String(request.routePolicyKey || '').trim().toLowerCase();
  const topRouteType = String(request.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
  if (!topRouteType && !routePolicyKey) return true;
  if (topRouteType) return topRouteType === 'direct_chat';
  return routePolicyKey.startsWith('direct_chat/');
}

function createEvent(type, payload = {}) {
  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: nowTs(),
    type: String(type || 'event').trim() || 'event',
    ...payload
  };
}

function emitEvents(events = [], request = {}) {
  if (typeof request.onEvent !== 'function') return;
  for (const event of normalizeArray(events)) {
    try {
      request.onEvent(event);
    } catch (_) {}
  }
}

function summarizeToolLogValue(value, maxLen = 160) {
  if (value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function stableHash(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value || {})).digest('hex').slice(0, 16);
}

function isWriteLikeCapability(capability = '') {
  return /write/i.test(String(capability || ''));
}

function isSideEffectPolicy(policy = {}) {
  return isWriteLikeCapability(policy.capability) || String(policy.risk || '').trim().toLowerCase() === 'high';
}

function inferStepKindFromTool(toolName = '') {
  const normalized = String(toolName || '').trim();
  if (!normalized) return 'reply';
  if (normalized === 'memory_cli') return 'memory_cli';
  if (normalized === 'humanizer') return 'humanizer';
  return normalized === 'reply' ? 'reply' : 'tool';
}

function normalizeStepId(step = {}, fallbackPrefix = 'step', index = 0) {
  return contractNormalizeStepId(step, fallbackPrefix, index);
}

function normalizeRoutePlanStep(step = {}, index = 0) {
  return normalizePlanStep(step, 'route', index);
}

function normalizePlannedStep(step = {}, index = 0) {
  return normalizePlanStep(step, 'planner', index);
}

function normalizeDirectChatPlannerPlanStep(step = {}, index = 0) {
  return normalizePlanStep(step, 'direct_chat', index);
}

function buildInitialPlanSlice(request = {}, options = {}) {
  return buildInitialPlanSliceBase(request, {
    ...normalizeObject(options, {}),
    getToolPlannerExecutionPlan,
    normalizeDirectChatPlannerPlanStep,
    normalizeRoutePlanStep
  });
}

function getRouteToolPlanner(routeMeta = {}) {
  const meta = normalizeObject(routeMeta, {});
  if (meta.toolPlanner && typeof meta.toolPlanner === 'object') return meta.toolPlanner;
  if (meta.directChatPlanner && typeof meta.directChatPlanner === 'object') return meta.directChatPlanner;
  return null;
}

function getToolPlannerExecutionPlan(routeMeta = {}) {
  const planner = getRouteToolPlanner(routeMeta);
  const executionPlan = planner?.executionPlan && typeof planner.executionPlan === 'object'
    ? planner.executionPlan
    : null;
  return executionPlan;
}

function isPlannerSingleAuthorityEnabled() {
  return config.PLANNER_SINGLE_AUTHORITY_ENABLED === true;
}

function createInitialState(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
  return createInitialStateBase(question, userInfo, userId, customPrompt, imageUrl, {
    ...normalizeObject(options, {}),
    resolveThreadId,
    resolveShortTermSessionKey,
    resolveShortTermScope,
    normalizeToolNames,
    shouldUseMinecraftLLM,
    getMinecraftModelOverrides,
    createMemoryCliTurnState,
    buildInitialPlanSlice,
    nowTs
  });
}

function shouldPlanRequest(request = {}) {
  if (request.forcePlanMode) return true;
  const plannerSteps = normalizeArray(getToolPlannerExecutionPlan(request.routeMeta)?.steps);
  if (isPlannerSingleAuthorityEnabled()) {
    return plannerSteps.length > 0;
  }
  if (normalizeArray(request.routeMeta?.planSteps).length > 0) return true;
  if (plannerSteps.length > 0) return true;
  if (String(request.reviewMode || '').trim()) return false;
  const topRouteType = String(request.topRouteType || '').trim().toLowerCase();
  const routePolicyKey = String(request.routePolicyKey || '').trim().toLowerCase();
  if (
    topRouteType === 'direct_chat'
    || routePolicyKey.startsWith('direct_chat/')
  ) {
    return plannerSteps.length > 0;
  }
  return normalizeArray(request.allowedTools).length > 0;
}

function normalizeMode(request = {}) {
  const topRouteType = String(request.topRouteType || request.routeMeta?.topRouteType || '').trim().toLowerCase();
  const routePolicyKey = String(request.routePolicyKey || '').trim().toLowerCase();
  if (request.systemInitiated || topRouteType === 'proactive' || routePolicyKey === 'proactive/default') return 'proactive';
  if (String(request.reviewMode || '').trim()) return 'review';
  if (request.imageUrl) return 'image';
  if (request.useMinecraftModel) return 'minecraft';
  return shouldPlanRequest(request) ? 'tool_plan' : 'chat';
}

function translatePlan(rawPlan = {}) {
  return translatePlanBase(rawPlan, {
    normalizePlannedStep
  });
}

function createRuntime(options = {}) {
  const store = createCheckpointStore(options.storeOptions || {});
  const runtimeOptions = normalizeObject(options, {});
  const capabilityRuntime = getCapabilityExecutors(runtimeOptions);
  const capabilityRegistry = capabilityRuntime.registry;
  const toolExecutors = normalizeObject(capabilityRuntime.executors, {});
  const buildPlanImpl = runtimeOptions.buildPlan || buildPlan;
  const buildDynamicPromptImpl = runtimeOptions.buildDynamicPrompt || buildDynamicPrompt;
  const requestReplyImpl = runtimeOptions.requestNonStreamingReply || requestNonStreamingReply;
  const requestStreamingReplyImpl = runtimeOptions.requestStreamingReply || requestStreamingReply;
  const requestAssistantMessageImpl = runtimeOptions.requestAssistantMessage || requestAssistantMessage;
  const finalizeStreamingReplyWithHumanizerImpl = runtimeOptions.finalizeStreamingReplyWithHumanizer || finalizeStreamingReplyWithHumanizer;
  const synthesizeImpl = runtimeOptions.synthesizeFromPlan || synthesizeFromPlan;
  const runHumanizerImpl = runtimeOptions.runHumanizerAgent || runHumanizerAgent;
  const isHumanizerEnabledImpl = runtimeOptions.isHumanizerAgentEnabled || isHumanizerAgentEnabled;
  const verifyExecutionImpl = runtimeOptions.verifyExecutionResult || verifyExecutionResult;
  const buildRepairPlanImpl = runtimeOptions.buildRepairPlan || buildRepairPlan;
  const postReplyJobQueue = runtimeOptions.postReplyJobQueue || getPostReplyJobQueue();

  function ensureOutputStream(output = {}, mode = 'none') {
    const current = normalizeObject(output.stream, {});
    return {
      hadOutput: Boolean(current.hadOutput),
      completed: Boolean(current.completed),
      fallbackToNonStream: Boolean(current.fallbackToNonStream),
      mode: String(current.mode || mode || 'none').trim() || 'none'
    };
  }

  function withOutputStream(state, patch = {}) {
    const current = ensureOutputStream(state.output, patch.mode);
    return {
      ...state.output,
      stream: {
        ...current,
        ...patch
      }
    };
  }

  function mirrorStreamingFlags(output, text = '') {
    const hasOutput = Boolean(String(text || '').trim());
    if (!hasOutput) return ensureOutputStream(output);
    return {
      ...ensureOutputStream(output),
      hadOutput: true
    };
  }

  function computeEffectiveAllowedTools(request = {}, memoryCliTurn = null) {
    if (isPlannerSingleAuthorityEnabled()) {
      const planner = getRouteToolPlanner(request.routeMeta);
      const plannedTools = normalizeToolNames(
        Array.isArray(planner?.allowedToolNames) ? planner.allowedToolNames : []
      );
      return filterAllowedToolsForMemoryCliTurn(plannedTools, memoryCliTurn);
    }
    return mergeAllowedToolsWithMemoryCli(request.allowedTools, {
      ...request,
      disableTools: !request.allowTools,
      memoryCliTurn
    });
  }

  function resolveMainConversationModelName(request = {}) {
    const modelConfig = normalizeObject(request.modelConfig, {});
    return String(modelConfig.model || config.AI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4';
  }

  function resolveMainConversationTokenLimit(request = {}, affinity = null) {
    const normalizedAffinity = normalizeObject(affinity, {});
    const fallbackLimit = Math.max(
      1,
      Number(normalizedAffinity.contextWindowTokens || config.CONTEXT_WINDOW_MAX_TOKENS || 32000) || 32000
    );
    return resolveModelTokenLimit(resolveMainConversationModelName(request), fallbackLimit);
  }

  function buildContinuitySystemMessage(state) {
    if (!config.CONTINUITY_STATE_PROMPT_ENABLED) return null;
    const text = String(state.memory?.continuityState?.text || '').trim();
    if (!text) return null;
    return { role: 'system', content: text };
  }

  function buildSilentContinuityProbeSystemMessage(state) {
    const probe = normalizeObject(state.memory?.continuityState?.probe, {});
    if (probe.skipped || !String(probe.facet || '').trim()) return null;
    return {
      role: 'system',
      content: [
        '[ContinuityProbePolicy]',
        'A read-only continuity probe may already have run before this reply.',
        'Use any continuity digest silently as background context.',
        'Do not mention tools, tool calls, tool results, memory_cli, probe steps, search commands, or retrieved snippets in the final answer.',
        'Do not narrate hidden retrieval or command execution. Reply as if you already know the carry-over context.'
      ].join('\n')
    };
  }

  function stripMemoryCliInstruction(text = '') {
    const raw = String(text || '');
    if (!raw.includes('[MemoryCLI]')) return raw;
    const lines = raw.split(/\r?\n/);
    const kept = [];
    let skipping = false;
    for (const line of lines) {
      if (line.startsWith('[MemoryCLI]')) {
        skipping = true;
        continue;
      }
      if (skipping && /^\[[A-Za-z]/.test(line)) {
        skipping = false;
      }
      if (!skipping) kept.push(line);
    }
    return kept.join('\n').trim();
  }

  function getMainConversationSystemMessages(state, options = {}) {
    const request = normalizeObject(state.request, {});
    const isReviewRoute = Boolean(options.isReviewRoute);
    const dynamicPrompt = Boolean(options.disableMemoryCliInstruction)
      ? stripMemoryCliInstruction(String(state.memory?.dynamicPrompt || ''))
      : String(state.memory?.dynamicPrompt || '').trim();
    const continuityMessage = buildContinuitySystemMessage(state);
    const continuityProbePolicyMessage = buildSilentContinuityProbeSystemMessage(state);
    return [
      ...(dynamicPrompt ? [{ role: 'system', content: dynamicPrompt }] : []),
      ...(continuityMessage ? [continuityMessage] : []),
      ...(continuityProbePolicyMessage ? [continuityProbePolicyMessage] : []),
      ...((request.routePrompt && !isReviewRoute) ? [{ role: 'system', content: request.routePrompt }] : []),
      ...(state.memory?.globalToolEvidence ? [{ role: 'system', content: state.memory.globalToolEvidence }] : [])
    ];
  }

  function isContinuityProbeEligible(request = {}, mode = '') {
    const routeMeta = normalizeObject(request.routeMeta, {});
    const topRouteType = String(request.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
    const routePolicyKey = String(request.routePolicyKey || '').trim().toLowerCase();
    const normalizedMode = String(mode || '').trim().toLowerCase();
    const question = String(request.question || '').trim();
    const facet = classifyRecallFacet(question);
    const explicitContinuityCue = /(where did we leave off|what were we(?: just)? talking about|what were we doing|before|earlier|last time|continue|resume|pick back up|next step|next steps|\u4e0a\u6b21|\u521a\u624d|\u4e4b\u524d|\u7ee7\u7eed|\u63a5\u7740|\u505a\u5230\u54ea|\u804a\u5230\u54ea)/i.test(question);
    if (!config.CONTINUITY_AUTO_PROBE_ENABLED) return false;
    if (request.systemInitiated) return false;
    if (String(request.customPrompt || '').trim()) return false;
    if (request.imageUrl) return false;
    if (isReviewMode(request.reviewMode)) return false;
    if (!String(request.userId || '').trim() || !question) return false;
    if (!new Set(['chat', 'tool_plan']).has(normalizedMode)) return false;
    if (topRouteType === 'admin' || topRouteType === 'ignore' || topRouteType === 'refuse') return false;
    if (topRouteType === 'vision' || routePolicyKey.startsWith('vision/')) return false;
    if (!explicitContinuityCue && facet !== 'task_or_plan' && facet !== 'recent_continuity') return false;

    return shouldPrioritizeMemoryProbe({
      rawText: question,
      cleanText: question,
      facets: routeMeta.facets,
      intent: routeMeta.intent,
      meta: routeMeta.meta
    });
  }

  function buildAutoContinuityProbeCommand(question = '') {
    const facet = classifyRecallFacet(question);
    const maxResults = Math.max(1, Math.min(8, Number(config.CONTINUITY_AUTO_PROBE_MAX_RESULTS) || 4));
    if (facet === 'recent_continuity' || facet === 'default_continuity') {
      return {
        facet,
        command: `mem search --query ${JSON.stringify('where did we leave off')} --source recent --limit ${maxResults}`
      };
    }
    if (facet === 'task_or_plan') {
      return {
        facet,
        command: `mem search --query ${JSON.stringify(String(question || '').trim())} --source all --limit ${Math.max(6, maxResults)}`
      };
    }
    return { facet, command: '' };
  }

  async function maybeRunAutoContinuityProbe(state, runtimeOptions = {}) {
    const request = normalizeObject(state.request, {});
    const mode = String(state.execution?.mode || normalizeMode(request)).trim().toLowerCase();
    if (request.allowTools === false) {
      return {
        skipped: true,
        reason: 'tools_disabled',
        probeResult: null,
        probeMeta: null,
        events: [createEvent('continuity_probe_skipped', { node: 'prepare', reason: 'tools_disabled', mode })]
      };
    }
    if (!isContinuityProbeEligible(request, mode)) {
      return {
        skipped: true,
        reason: 'route_not_eligible',
        probeResult: null,
        probeMeta: null,
        events: [createEvent('continuity_probe_skipped', { node: 'prepare', reason: 'route_not_eligible', mode })]
      };
    }

    const seeded = buildContinuityState({
      request,
      thread: state.thread,
      shortTermMemory,
      chatHistory,
      maxChars: config.CONTINUITY_STATE_PROMPT_MAX_CHARS
    });
    if (seeded.hasSufficientEvidence) {
      return {
        skipped: true,
        reason: 'local_evidence_sufficient',
        probeResult: null,
        probeMeta: null,
        events: [createEvent('continuity_probe_skipped', { node: 'prepare', reason: 'local_evidence_sufficient', mode })]
      };
    }

    const allowedTools = computeEffectiveAllowedTools(request, state.execution?.memoryCliTurn);
    if (!normalizeArray(allowedTools).includes('memory_cli')) {
      return {
        skipped: true,
        reason: 'memory_cli_unavailable',
        probeResult: null,
        probeMeta: null,
        events: [createEvent('continuity_probe_skipped', { node: 'prepare', reason: 'memory_cli_unavailable', mode })]
      };
    }

    const probeMeta = buildAutoContinuityProbeCommand(request.question || '');
    if (!probeMeta.command || !shouldBiasToContinuity(probeMeta.facet)) {
      return {
        skipped: true,
        reason: 'facet_not_supported',
        probeResult: null,
        probeMeta,
        events: [createEvent('continuity_probe_skipped', { node: 'prepare', reason: 'facet_not_supported', facet: probeMeta.facet, mode })]
      };
    }

    const probeStep = {
      id: `continuity_probe_${Date.now()}`,
      kind: 'memory_cli',
      tool: 'memory_cli',
      instruction: 'read-only continuity probe before reply generation',
      inputs: { command: probeMeta.command },
      successCriteria: 'continuity digest available',
      attempts: 0,
      evidence: [],
      blockingReason: ''
    };
    const startEvents = [
      createEvent('continuity_probe_triggered', {
        node: 'prepare',
        facet: probeMeta.facet,
        mode,
        command: probeMeta.command
      })
    ];

    try {
      const envelope = await runToolStep(probeStep, state, runtimeOptions);
      const parsed = safeParseMemoryCliResult(envelope?.result);
      return {
        skipped: false,
        reason: String(envelope?.status || '').trim() === 'completed' ? 'completed' : 'failed',
        probeResult: String(envelope?.status || '').trim() === 'completed' ? parsed : null,
        probeMeta,
        events: startEvents.concat([
          createEvent('continuity_probe_result', {
            node: 'prepare',
            facet: probeMeta.facet,
            ok: String(envelope?.status || '').trim() === 'completed',
            resultCount: Number(parsed?.count || normalizeArray(parsed?.results).length || 0) || 0
          })
        ])
      };
    } catch (error) {
      return {
        skipped: false,
        reason: 'error',
        probeResult: null,
        probeMeta,
        events: startEvents.concat([
          createEvent('continuity_probe_result', {
            node: 'prepare',
            facet: probeMeta.facet,
            ok: false,
            error: String(error?.message || error).slice(0, 180)
          })
        ])
      };
    }
  }

  function buildMainConversationContextSnapshot(state, segmentedMessages = {}, options = {}) {
    const request = normalizeObject(state.request, {});
    const affinity = normalizeObject(options.affinity, state.memory?.affinity);
    const canonical = buildV2CanonicalSegments(state, {
      systemPromptMessages: normalizeArray(segmentedMessages.systemMessages),
      routePromptMessages: [],
      continuityMessages: normalizeArray(segmentedMessages.continuityStateMessages),
      shortTermSummaryMessages: normalizeArray(segmentedMessages.summaryMessages),
      recentHistoryMessages: normalizeArray(segmentedMessages.recentHistory),
      userTurnMessages: normalizeArray(segmentedMessages.userTurnMessages),
      toolEvidenceMessages: normalizeArray(segmentedMessages.globalToolEvidenceMessages),
      plannerArtifactMessages: normalizeArray(options.plannerArtifactMessages),
      modelName: resolveMainConversationModelName(request),
      modelWindowTokens: resolveMainConversationTokenLimit(request, affinity),
      maxOutputTokens: Number(request.modelConfig?.maxTokens || config.AI_MAX_TOKENS || 3500),
      source: String(options.source || 'direct_reply').trim() || 'direct_reply'
    });
    return {
      modelName: resolveMainConversationModelName(request),
      tokenLimit: resolveMainConversationTokenLimit(request, affinity),
      routeMeta: normalizeObject(request.routeMeta, {}),
      allowedTools: normalizeArray(options.allowedTools || request.allowedTools),
      snapshotMeta: {
        routePolicyKey: String(request.routePolicyKey || '').trim(),
        topRouteType: String(request.topRouteType || '').trim(),
        source: String(options.source || 'direct_reply').trim() || 'direct_reply',
        compactionDiagnostics: canonical.compactionPlan.diagnostics
      },
      segments: canonical.compactionPlan.compactedSegments.map((segment) => ({
        name: segment.name,
        messages: normalizeArray(segment.messages)
      }))
    };
  }

  function buildLiveMainConversationSnapshot(state, options = {}) {
    const request = normalizeObject(state.request, {});
    const isReviewRoute = isReviewMode(request.reviewMode);
    const messageContent = request.imageUrl
      ? buildVisionMessageContent(request.question || '', request.imageUrl)
      : (request.question || '');
    const baseSystemMessages = getMainConversationSystemMessages(state, { isReviewRoute });
    const directReplyPayload = buildDirectReplyMessages(state, messageContent, baseSystemMessages);
    return buildMainConversationContextSnapshot(state, directReplyPayload, {
      affinity: options.affinity,
      allowedTools: options.allowedTools,
      source: String(options.source || 'direct_reply').trim() || 'direct_reply',
      plannerArtifactMessages: normalizeArray(options.plannerArtifactMessages)
    });
  }

  function normalizeMessageForToolLoop(message = {}) {
    const parseToolCallsFromMarkup = (content = '') => {
      const raw = String(content || '').trim();
      if (!raw) return [];
      const unwrapped = raw
        .replace(/^```xml\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      const rootMatch = unwrapped.match(/^<tool_calls>([\s\S]*)<\/tool_calls>$/i);
      if (!rootMatch) return [];

      const body = String(rootMatch[1] || '');
      const toolCalls = [];
      const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
      let toolCallMatch = toolCallRegex.exec(body);
      while (toolCallMatch) {
        const block = String(toolCallMatch[1] || '');
        const nameMatch = block.match(/<name>([\s\S]*?)<\/name>/i);
        const argsMatch = block.match(/<arguments>([\s\S]*?)<\/arguments>/i);
        const idMatch = block.match(/<id>([\s\S]*?)<\/id>/i);
        const name = String(nameMatch?.[1] || '').trim();
        if (name) {
          const rawArgs = String(argsMatch?.[1] || '').trim();
          let serializedArgs = '{}';
          if (rawArgs) {
            try {
              serializedArgs = JSON.stringify(JSON.parse(rawArgs));
            } catch (_) {
              serializedArgs = JSON.stringify({ command: rawArgs });
            }
          }
          toolCalls.push({
            id: String(idMatch?.[1] || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`).trim(),
            type: 'function',
            function: {
              name,
              arguments: serializedArgs
            }
          });
        }
        toolCallMatch = toolCallRegex.exec(body);
      }
      return toolCalls;
    };

    const normalized = {
      role: String(message?.role || 'assistant').trim() || 'assistant',
      content: message?.content
    };
    const toolCalls = normalizeArray(message?.tool_calls)
      .concat(parseToolCallsFromMarkup(message?.content))
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        ...item,
        id: String(item.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
        type: String(item.type || 'function').trim() || 'function',
        function: {
          name: String(item?.function?.name || item?.name || '').trim(),
          arguments: typeof item?.function?.arguments === 'string'
            ? item.function.arguments
            : JSON.stringify(item?.function?.arguments || item?.args || {})
        }
      }))
      .filter((item) => item.function.name);
    if (toolCalls.length > 0) {
      normalized.tool_calls = toolCalls;
    }
    return normalized;
  }

  function isPureToolCallMarkup(text = '') {
    const raw = String(text || '').trim();
    if (!raw) return false;
    return /^<tool_calls>[\s\S]*<\/tool_calls>$/i.test(raw)
      || /^```xml\s*<tool_calls>[\s\S]*<\/tool_calls>\s*```$/i.test(raw)
      || /^```[\s\S]*<tool_calls>[\s\S]*<\/tool_calls>[\s\S]*```$/i.test(raw);
  }

  function getControlledFailureReply(failureType = 'generic_model_failure') {
    if (failureType === 'tool_loop_limit') {
      return 'Model invocation failed: tool loop limit reached after the direct memory turn. Please ask again with a more specific memory target.';
    }
    if (failureType === 'tool_error') {
      return 'Tool error: direct memory lookup could not produce a stable answer just now.';
    }
    if (failureType === 'post_tool_empty_reply') {
      return 'Model reply was empty after the direct memory tool path. Please retry with a more specific request.';
    }
    if (failureType === 'context_overflow') {
      return 'The assembled context is too large to answer safely right now. Please narrow the request or continue from the latest step.';
    }
    if (failureType === 'provider_auth') {
      return 'invalid api key';
    }
    if (failureType === 'provider_blocked') {
      return 'request was blocked by upstream safety';
    }
    return 'Tool error: tool call markup was returned without executing any tool.';
  }

  function classifyDirectReplyError(error) {
    if (error?.isContextHardBlock) return 'context_overflow';
    const failure = classifyReplyFailure(String(error?.message || error || ''));
    if (failure.type !== 'none') return failure.type;
    const status = Number(error?.response?.status || 0);
    if (status === 401 || status === 403) return 'provider_auth';
    return 'generic_model_failure';
  }

  function isStableDirectReplyText(text = '') {
    const trimmed = String(text || '').trim();
    if (!trimmed) return false;
    if (isPureToolCallMarkup(trimmed)) return false;
    return !isReplyFailure(trimmed, { emptyIsFailure: true });
  }

  function buildDirectToolLoopExecLogs(executedToolEnvelopes = []) {
    return normalizeArray(executedToolEnvelopes)
      .map((envelope, index) => {
        const toolName = String(envelope?.tool_name || 'tool').trim() || 'tool';
        const ok = String(envelope?.status || '').trim() === 'completed';
        return {
          id: String(envelope?.step_id || `direct_tool_${index + 1}`).trim() || `direct_tool_${index + 1}`,
          action: toolName,
          args: {},
          purpose: `use ${toolName} result to answer the user`,
          ok,
          result: ok ? String(envelope?.result || '') : '',
          error: ok ? '' : String(envelope?.result || envelope?.blockedReason || 'tool failed')
        };
      })
      .filter((row) => row.result || row.error);
  }

  function buildDirectToolLoopPlan(question = '', execLogs = []) {
    return {
      goal: String(question || '').trim() || 'answer the user from collected tool results',
      need_tools: false,
      steps: normalizeArray(execLogs).map((row, index) => ({
        id: String(row?.id || `direct_tool_${index + 1}`).trim() || `direct_tool_${index + 1}`,
        action: String(row?.action || 'reply').trim() || 'reply',
        args: normalizeObject(row?.args, {}),
        purpose: String(row?.purpose || '').trim() || 'answer the user directly from tool evidence'
      }))
    };
  }

  function normalizeToolEvidenceSnippet(text = '', maxChars = 480) {
    const compact = String(text || '').replace(/\s+/g, ' ').trim();
    if (!compact) return '';
    return compact.slice(0, Math.max(80, Number(maxChars) || 480));
  }

  function cloneDirectToolLoopState(statePatch = {}) {
    return {
      messages: normalizeArray(statePatch.messages).map((item) => ({ ...normalizeObject(item, {}) })),
      events: normalizeArray(statePatch.events).map((item) => ({ ...normalizeObject(item, {}) })),
      memoryCliTurn: createMemoryCliTurnState(statePatch.memoryCliTurn),
      executedToolEnvelopes: normalizeArray(statePatch.executedToolEnvelopes).map((item) => ({ ...normalizeObject(item, {}) })),
      effectiveAllowedTools: normalizeArray(statePatch.effectiveAllowedTools)
    };
  }

  function shouldAttemptMemoryRecovery(question = '', allowedTools = []) {
    const text = String(question || '').trim().toLowerCase();
    if (!text) return false;
    if (!normalizeArray(allowedTools).includes('memory_cli')) return false;
    return /(where did we leave off|what were we(?: just)? talking about|what were we doing|before|earlier|last time|continue|resume|pick back up|next step|next steps|remember|前几天|记不记得|记得|记不清|事情|上次|刚才|之前|继续|接着|做到哪|聊到哪)/i.test(text);
  }

  function buildMemoryRecoveryCommand(question = '') {
    const text = String(question || '').trim();
    if (!text) return 'mem search --query "where did we leave off" --source recent';
    if (/(where did we leave off|what were we(?: just)? talking about|what were we doing|before|earlier|last time|continue|resume|pick back up|next step|next steps|remember|前几天|记不记得|记得|记不清|事情|上次|刚才|之前|继续|接着|做到哪|聊到哪)/i.test(text)) {
      return `mem search --query ${JSON.stringify('where did we leave off')} --source recent`;
    }
    return `mem search --query ${JSON.stringify(text)} --source recent`;
  }

  async function attemptDirectMemoryRecovery(state, directContext, runtimeOptions = {}, currentLoopState = {}) {
    const request = normalizeObject(state.request, {});
    const loopState = cloneDirectToolLoopState(currentLoopState);
    const availableTools = normalizeArray(loopState.effectiveAllowedTools);
    if (!shouldAttemptMemoryRecovery(directContext.question, availableTools)) return null;

    const memoryStep = {
      id: `direct_memory_recovery_${Date.now()}`,
      kind: 'memory_cli',
      tool: 'memory_cli',
      instruction: 'recover recent memory context for direct chat answer',
      inputs: {
        command: buildMemoryRecoveryCommand(directContext.question)
      },
      successCriteria: 'memory result available',
      attempts: 0,
      evidence: [],
      blockingReason: ''
    };

    const envelope = await runToolStep(memoryStep, {
      ...state,
      request: {
        ...request,
        allowedTools: availableTools
      },
      execution: {
        ...state.execution,
        memoryCliTurn: loopState.memoryCliTurn
      }
    }, runtimeOptions);

    if (String(envelope?.status || '').trim() !== 'completed') return null;

    const nextMemoryCliTurn = envelope.memoryCliTurn
      ? createMemoryCliTurnState(envelope.memoryCliTurn)
      : createMemoryCliTurnState(loopState.memoryCliTurn);
    const nextAllowedTools = computeEffectiveAllowedTools(request, nextMemoryCliTurn);
    const executedToolEnvelopes = normalizeArray(loopState.executedToolEnvelopes).concat([{ ...envelope }]);
    const loopMessages = normalizeArray(loopState.messages).concat([{
      role: 'tool',
      tool_call_id: String(envelope.tool_call_id || '').trim() || `memory_recovery_${Date.now()}`,
      content: String(envelope.result || '')
    }]);
    const loopEvents = normalizeArray(loopState.events).concat([
      createEvent('tool_result', {
        ...envelope,
        node: 'direct_reply',
        tool_call_id: String(envelope.tool_call_id || '').trim() || `memory_recovery_${Date.now()}`
      }),
      createEvent('memoryCliTurn', {
        node: 'direct_reply',
        memoryCliTurn: nextMemoryCliTurn
      }),
      createEvent('effectiveAllowedTools', {
        node: 'direct_reply',
        allowedTools: nextAllowedTools
      }),
      createEvent('tool_loop_forced_answer', {
        node: 'direct_reply',
        reason: 'memory_recovery_after_model_error',
        allowedTools: nextAllowedTools
      })
    ]);

    const replyResolution = await resolveToolLoopReply(
      { role: 'assistant', content: '' },
      loopMessages,
      directContext,
      'post_tool_empty_reply',
      executedToolEnvelopes
    );

    return {
      reply: replyResolution.text,
      memoryCliTurn: nextMemoryCliTurn,
      effectiveAllowedTools: nextAllowedTools,
      events: loopEvents,
      executedToolEnvelopes
    };
  }

  function buildDirectToolEvidenceFallback(executedToolEnvelopes = []) {
    const snippets = normalizeArray(executedToolEnvelopes)
      .filter((envelope) => String(envelope?.status || '').trim() === 'completed')
      .map((envelope, index) => {
        const body = normalizeToolEvidenceSnippet(
          envelope?.result,
          index === 0 ? 900 : 420
        );
        if (!body) return '';
        const toolName = String(envelope?.tool_name || '').trim();
        return toolName
          ? `${index + 1}. [${toolName}] ${body}`
          : `${index + 1}. ${body}`;
      })
      .filter(Boolean)
      .slice(0, 3);

    if (snippets.length === 0) return '';
    return [
      '\u6211\u5df2\u7ecf\u62ff\u5230\u5de5\u5177\u7ed3\u679c\uff0c\u4f46\u521a\u624d\u6574\u7406\u6700\u7ec8\u56de\u590d\u65f6\u6ca1\u6709\u751f\u6210\u7a33\u5b9a\u6b63\u6587\u3002\u5148\u628a\u5df2\u67e5\u5230\u7684\u5185\u5bb9\u7ed9\u4f60\uff1a',
      snippets.join('\n')
    ].join('\n');
  }

  async function resolveToolLoopReply(
    assistantMessage,
    fallbackMessages,
    directContext,
    failureType = 'tool_error',
    executedToolEnvelopes = []
  ) {
    const primaryReply = String(assistantMessage?.content || '').trim();
    if (isStableDirectReplyText(primaryReply)) {
      return {
        text: primaryReply,
        source: 'assistant'
      };
    }

    const directExecLogs = buildDirectToolLoopExecLogs(executedToolEnvelopes);
    if (directExecLogs.length > 0) {
      try {
        const synthesizedReply = String(await synthesizeImpl(
          directContext.question || '',
          directContext.dynamicPrompt || '',
          buildDirectToolLoopPlan(directContext.question, directExecLogs),
          directExecLogs,
          {
            done: directExecLogs.some((row) => row.ok),
            confidence: directExecLogs.every((row) => row.ok) ? 0.72 : 0.48,
            missing: []
          },
          directContext.modelConfig
        ) || '').trim();
        if (isStableDirectReplyText(synthesizedReply)) {
          return {
            text: synthesizedReply,
            source: 'tool_result_synthesis'
          };
        }
      } catch (_) {}
    }

    try {
      const fallbackReply = String(await requestReplyImpl(fallbackMessages, {
        ...directContext,
        disableTools: true,
        allowedTools: []
      }) || '').trim();
      if (isStableDirectReplyText(fallbackReply)) {
        return {
          text: fallbackReply,
          source: 'non_stream_fallback'
        };
      }
    } catch (_) {}

    const toolEvidenceFallback = buildDirectToolEvidenceFallback(executedToolEnvelopes);
    if (toolEvidenceFallback) {
      return {
        text: toolEvidenceFallback,
        source: 'tool_result_fallback'
      };
    }

    return {
      text: getControlledFailureReply(failureType),
      source: 'controlled_failure'
    };
  }

  function shouldAllowDirectToolCall(toolCall = {}, allowedTools = []) {
    const toolName = String(toolCall?.function?.name || '').trim();
    if (!toolName) return false;
    if (isExcludedDirectChatToolName(toolName)) return false;
    return normalizeArray(allowedTools).includes(toolName);
  }

  function markStreamCompleted(output, completed = true) {
    return {
      ...ensureOutputStream(output),
      completed: Boolean(completed)
    };
  }

  // Tool-plan answers still converge to one final text. When the graph is
  // streaming, emit only that final text so callers never see draft + final.
  async function emitWholeReplyAsSingleStream(state, finalReply) {
    const request = normalizeObject(state.request, {});
    const text = sanitizeUserFacingText(finalReply).trim();
    if (!request.streaming || typeof request.onDelta !== 'function' || !text) return text;
    request.onDelta(text, text);
    return text;
  }

  async function streamDirectReply(messagesToSend, state) {
    const request = normalizeObject(state.request, {});
    // Direct routes can reuse the mature V1 streaming helper. If humanizer is
    // enabled, suppress raw deltas and let the humanized stream be the only
    // user-visible output.
    const useHumanizerStreaming = isHumanizerEnabledImpl() && !shouldBypassHumanizerForPolicy(request.routePolicyKey);
    const upstreamStreamOptions = useHumanizerStreaming
      ? {
          onDelta() {},
          streamHadOutput: false,
          userId: request.userId,
          routeMeta: normalizeObject(request.routeMeta, {})
        }
      : request;

    try {
      const streamedReply = await requestStreamingReplyImpl(messagesToSend, upstreamStreamOptions, request.modelConfig);
      const finalReply = useHumanizerStreaming
        ? await finalizeStreamingReplyWithHumanizerImpl(streamedReply, 'The network was unstable just now. Please try again.', {
            question: request.question,
            dynamicPrompt: state.memory?.dynamicPrompt || '',
            modelConfig: request.modelConfig,
            onDelta: request.onDelta,
            streamHadOutput: Boolean(state.output?.stream?.hadOutput)
          })
        : sanitizeUserFacingText(streamedReply).trim();
      const safeFinalReply = sanitizeUserFacingText(finalReply).trim() || 'The network was unstable just now. Please try again.';
      return {
        finalReply: safeFinalReply,
        stream: {
          ...markStreamCompleted(state.output, true),
          ...mirrorStreamingFlags(state.output, safeFinalReply),
          mode: 'direct'
        }
      };
    } catch (error) {
      if (String(error?.partialText || '').trim()) {
        const finalReply = useHumanizerStreaming
          ? await finalizeStreamingReplyWithHumanizerImpl(error.partialText, 'The network was unstable just now. Please try again.', {
              question: request.question,
              dynamicPrompt: state.memory?.dynamicPrompt || '',
              modelConfig: request.modelConfig,
              onDelta: request.onDelta,
              streamHadOutput: Boolean(state.output?.stream?.hadOutput)
            })
          : sanitizeUserFacingText(error.partialText).trim();
        const safeFinalReply = sanitizeUserFacingText(finalReply).trim() || 'The network was unstable just now. Please try again.';
        return {
          finalReply: safeFinalReply,
          stream: {
            ...markStreamCompleted(state.output, true),
            ...mirrorStreamingFlags(state.output, safeFinalReply),
            mode: 'direct'
          }
        };
      }
      error.outputStream = {
        ...ensureOutputStream(state.output, 'direct'),
        fallbackToNonStream: true,
        completed: false
      };
      throw error;
    }
  }

  async function maybeStreamFinalReply(state, finalReply) {
    const request = normalizeObject(state.request, {});
    if (!request.streaming || typeof request.onDelta !== 'function') {
      return String(finalReply || '').trim();
    }
    return emitWholeReplyAsSingleStream(state, finalReply);
  }

  function buildDirectReplyMessages(state, messageContent, systemMessages = []) {
    const request = normalizeObject(state.request, {});
    const baseMessages = normalizeArray(systemMessages)
      .filter((item) => item && typeof item === 'object');
    const continuityStateMessages = baseMessages.filter((item) => String(item?.content || '').includes('[ContinuityState]'));
    const globalToolEvidenceMessages = baseMessages.filter((item) => String(item?.content || '').includes('[GlobalToolEvidence]'));
    const pureSystemMessages = baseMessages.filter((item) => !globalToolEvidenceMessages.includes(item) && !continuityStateMessages.includes(item));
    const userTurnMessages = [{ role: 'user', content: messageContent }];

    if (!isChatLikeRoute(request) || request.systemInitiated || String(request.customPrompt || '').trim()) {
      const canonical = buildV2CanonicalSegments(state, {
        systemPromptMessages: pureSystemMessages,
        continuityMessages: continuityStateMessages,
        shortTermSummaryMessages: [],
        recentHistoryMessages: [],
        userTurnMessages,
        toolEvidenceMessages: globalToolEvidenceMessages,
        source: 'direct_reply'
      });
      return {
        messages: canonical.compactionPlan.compactedSegments.flatMap((segment) => segment.messages),
        systemMessages: pureSystemMessages,
        continuityStateMessages,
        summaryMessages: [],
        recentHistory: [],
        userTurnMessages,
        globalToolEvidenceMessages,
        compactionPlan: canonical.compactionPlan,
        canonicalSegments: canonical.segments
      };
    }

    const routeMeta = normalizeObject(request.routeMeta, {});
    const sessionKey = String(
      request.sessionKey
      || state.thread?.sessionKey
      || resolveShortTermSessionKey(request.userId, routeMeta)
      || ''
    ).trim();
    const recentContext = buildShortTermContextMessages(request.userId, request.userInfo, {
      chatHistory,
      shortTermMemory,
      routeMeta,
      sessionKey
    });
    const affinity = normalizeObject(state.memory, {}).affinity;
    const sessionSummaryMessages = normalizeArray(recentContext.sessionSummaryMessages);
    const summaryMessages = recentContext.summaryMessage ? [recentContext.summaryMessage] : [];
    const recentHistory = normalizeArray(recentContext.recentHistory);
    const canonical = buildV2CanonicalSegments(state, {
      systemPromptMessages: pureSystemMessages,
      routePromptMessages: [],
      continuityMessages: continuityStateMessages,
      shortTermSummaryMessages: sessionSummaryMessages.concat(summaryMessages),
      recentHistoryMessages: recentHistory,
      userTurnMessages,
      toolEvidenceMessages: globalToolEvidenceMessages,
      modelName: resolveMainConversationModelName(request),
      modelWindowTokens: Math.max(2048, Number(affinity?.contextWindowTokens || 0) || 2048),
      maxOutputTokens: Number(request.modelConfig?.maxTokens || config.AI_MAX_TOKENS || 3500),
      source: 'direct_reply'
    });
    const trimmedRecentHistory = normalizeArray(
      canonical.compactionPlan.compactedSegments.find((segment) => segment.name === 'recent_history')?.messages
    );
    return {
      messages: canonical.compactionPlan.compactedSegments.flatMap((segment) => segment.messages),
      systemMessages: pureSystemMessages,
      continuityStateMessages,
      summaryMessages: sessionSummaryMessages.concat(summaryMessages),
      recentHistory: trimmedRecentHistory,
      userTurnMessages,
      globalToolEvidenceMessages,
      compactionPlan: canonical.compactionPlan,
      canonicalSegments: canonical.segments
    };
  }

  function persistCheckpoint(state, nodeName, status = 'running') {
    const threadId = String(state?.thread?.threadId || '').trim();
    if (!threadId) return;
    store.saveCheckpoint(threadId, {
      status,
      node: nodeName,
      updatedAt: nowTs(),
      state: snapshotState(state)
    });
  }

  function appendRuntimeEvents(state, events = []) {
    const normalized = normalizeArray(events).filter(Boolean);
    if (normalized.length === 0) return;
    const threadId = String(state?.thread?.threadId || '').trim();
    if (threadId) {
      store.appendEvents(threadId, normalized);
    }
    emitEvents(normalized, state?.request || {});
  }

  function saveAndEmit(state, nodeName, status = 'running', events = []) {
    appendRuntimeEvents(state, events);
    persistCheckpoint(state, nodeName, status);
    return state;
  }

  const routeNode = createRouteNode({
    createEvent,
    normalizeMode,
    saveAndEmit
  });

  const routeAfterRoute = createRouteAfterRoute({
    normalizeMode
  });

  const plannerNode = createPlannerNode({
    normalizeObject,
    normalizeArray,
    createEvent,
    isPlannerSingleAuthorityEnabled,
    getToolPlannerExecutionPlan,
    buildPlanImpl,
    translatePlan,
    rebuildFinalPlanFromSteps,
    saveAndEmit
  });

  const validateNode = createValidateNode({
    createEvent,
    normalizeObject,
    normalizeArray,
    rebuildFinalPlanFromSteps,
    buildExecLogsFromSteps,
    verifyExecutionImpl,
    getMaxRounds() {
      return Math.max(1, Math.min(3, Number(config.AGENT_MAX_ROUNDS) || 3));
    },
    saveAndEmit
  });

  const routeAfterValidate = createRouteAfterValidate({
    normalizeArray,
    getMaxRounds() {
      return Math.max(1, Math.min(3, Number(config.AGENT_MAX_ROUNDS) || 3));
    }
  });

  const repairNode = createRepairOrContinueNode({
    rebuildFinalPlanFromSteps,
    normalizeObject,
    normalizeArray,
    buildRepairPlanImpl,
    isCompletedSideEffectStep,
    createEvent,
    saveAndEmit
  });

  const routeAfterRepair = createRouteAfterRepair({
    normalizeArray
  });

  const finalValidateNode = createFinalValidateNode({
    createEvent,
    isReplyFailure,
    classifyReplyFailure,
    saveAndEmit
  });

  const routeAfterDraftReply = createRouteAfterDraftReply();

  const draftReplyNode = createDraftReplyNode({
    normalizeObject,
    normalizeArray,
    createEvent,
    buildDynamicPromptImpl,
    rebuildFinalPlanFromSteps,
    buildContinuitySystemMessage,
    isReviewMode,
    getMainConversationSystemMessages,
    buildDirectReplyMessages,
    buildVisionMessageContent,
    normalizeMessageForToolLoop,
    requestAssistantMessageImpl,
    compileDirectChatToolCallsToPlan,
    computeEffectiveAllowedTools,
    resolveToolLoopReply,
    synthesizeImpl,
    saveAndEmit
  });

  const humanizeNode = createHumanizeNode({
    normalizeObject,
    createEvent,
    isReviewMode,
    isReplyFailure,
    isHumanizerEnabledImpl,
    shouldBypassHumanizerForPolicy,
    maybeStreamFinalReply,
    ensureOutputStream,
    mirrorStreamingFlags,
    runHumanizerImpl,
    getMaxSegments() {
      return Number(config.AI_STREAM_MAX_SEGMENTS) || 3;
    },
    saveAndEmit
  });

  const persistNode = createPersistNode({
    normalizeObject,
    normalizeArray,
    createEvent,
    isReviewMode,
    isChatLikeRoute,
    shouldAppendDailyJournalForV2,
    shouldQueueMemoryLearningForV2,
    shouldLearnSelfImprovement(request = {}, finalReply = '') {
      return Boolean(
        config.SELF_IMPROVEMENT_ENABLED
        && config.SELF_IMPROVEMENT_EXTRACTION_ENABLED
        && !request.systemInitiated
        && !String(request.customPrompt || '').trim()
        && !isReviewMode(request.reviewMode)
        && String(request.userId || '').trim()
        && String(request.question || '').trim()
        && finalReply
        && !isReplyFailure(finalReply, { emptyIsFailure: true })
      );
    },
    appendShortTermHistory,
    persistShortTermBridgeSnapshot,
    addProfileItem,
    pickRouteMetaForPostReplyJob,
    stableHash,
    postReplyJobQueue,
    chatHistory,
    shortTermMemory,
    logPostReplyEnqueueError(error) {
      console.error('[post-reply] enqueue failed:', error?.message || error);
    },
    saveAndEmit
  });

  const prepareNodeImpl = createPrepareNode({
    normalizeObject,
    normalizeArray,
    createEvent,
    loadCheckpoint(threadId) {
      return store.loadCheckpoint(threadId);
    },
    shouldExposeMemoryCli,
    recordMemoryScope,
    restoreShortTermBridgeAfterRestartIfNeeded,
    rehydrateShortTermMemoryAfterRestartIfNeeded,
    compressShortTermHistoryIfNeeded,
    buildStructuredCompressionPrompt,
    postWithRetry,
    extractMessageContent,
    isChatLikeRoute,
    persistShortTermBridgeSnapshot,
    maybeRunAutoContinuityProbe,
    buildContinuityState,
    createMemoryCliTurnState,
    computeEffectiveAllowedTools,
    runCapabilityPreflight,
    buildDynamicPromptImpl,
    getToolPlannerExecutionPlan,
    isPlannerSingleAuthorityEnabled,
    normalizePlanForResume,
    normalizeMode,
    ensureOutputStream,
    nowTs,
    saveAndEmit,
    config,
    chatHistory,
    shortTermMemory,
    toolExecutors,
    runtimeOptions
  });

  const routeAfterDirectReplyImpl = createRouteAfterDirectReply();

  const directReplyNodeImpl = createDirectReplyNode({
    normalizeObject,
    normalizeArray,
    createEvent,
    isReviewMode,
    shouldBypassHumanizerForPolicy,
    computeEffectiveAllowedTools,
    getToolPlannerExecutionPlan,
    isPlannerSingleAuthorityEnabled,
    getRouteToolPlanner,
    buildVisionMessageContent,
    stripMemoryCliInstruction,
    getMainConversationSystemMessages,
    buildDirectReplyMessages,
    buildLiveMainConversationSnapshot,
    ensureOutputStream,
    createMemoryCliTurnState,
    cloneDirectToolLoopState,
    normalizeMessageForToolLoop,
    requestAssistantMessageImpl,
    compileDirectChatToolCallsToPlan,
    saveAndEmit,
    mirrorStreamingFlags,
    isPureToolCallMarkup,
    streamDirectReply,
    requestReplyImpl,
    classifyDirectReplyError,
    attemptDirectMemoryRecovery,
    getControlledFailureReply,
    updateMemoryCliTurnStateAfterError,
    classifyReplyFailure
  });

  const dispatchNodeImpl = createDispatchNode({
    normalizeObject,
    normalizeArray,
    createEvent,
    stableHash,
    isCompletedSideEffectStep,
    findEvidenceEnvelope,
    isDirectChatRequest,
    buildDirectChatExecutionBatches,
    canRunStepsInParallel,
    buildLiveMainConversationSnapshot,
    computeEffectiveAllowedTools,
    createMemoryCliTurnState,
    persistCheckpoint,
    appendRuntimeEvents,
    updatePlanStepsWithEnvelope,
    getPolicy,
    isSideEffectPolicy,
    executeBatch(steps, dispatchState, runtimeContext) {
      return executeCapabilityBatch(steps, dispatchState, {
        ...runtimeContext,
        registry: capabilityRegistry,
        executors: toolExecutors,
        helpers: {
          stableHash,
          buildLiveMainConversationSnapshot,
          computeEffectiveAllowedTools,
          enforceToolPolicy,
          captureToolFailure
        }
      });
    },
    rebuildFinalPlanFromSteps,
    buildExecLogsFromSteps,
    mergeAllowedToolsWithMemoryCli,
    saveAndEmit,
    config
  });


  function computeToolEnvelope(step = {}, rawResult = '', policy = {}) {
    const normalizedInputs = normalizeObject(step.inputs, {});
    const argsHash = stableHash(normalizedInputs);
    const resultText = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
    const batchId = String(step.batchId || step.batch_id || '').trim();
    const batchIndex = Number.isFinite(Number(step.batchIndex ?? step.batch_index))
      ? Number(step.batchIndex ?? step.batch_index)
      : null;
    const status = !resultText
      ? 'failed'
      : /^Tool error:/i.test(resultText) || /^Unknown tool:/i.test(resultText) || /^Tool not allowed:/i.test(resultText)
        ? 'failed'
        : 'completed';
    return {
      tool_call_id: `${step.id}_${argsHash}_${Date.now()}`,
      step_id: String(step.id || '').trim(),
      tool_name: String(step.tool || '').trim(),
      args_hash: argsHash,
      args: normalizedInputs,
      status,
      result: resultText,
      side_effect: isSideEffectPolicy(policy),
      retryable: status !== 'completed',
      attempt: Number(step.attempts || 0) + 1,
      ...(batchId ? { batch_id: batchId } : {}),
      ...(batchIndex !== null ? { batch_index: batchIndex } : {})
    };
  }

  function canRunStepsInParallel(steps = []) {
    return shouldRunParallel(steps, capabilityRegistry);
  }

  function parseSearchResultRows(resultText = '') {
    const rows = [];
    const text = String(resultText || '').trim();
    if (!text) return rows;
    const blocks = text.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
    for (const block of blocks) {
      const lines = block.split('\n').map((item) => item.trim()).filter(Boolean);
      const urlLine = lines.find((line) => /^https?:\/\//i.test(line));
      if (!urlLine) continue;
      const titleLine = lines.find((line) => /^\d+\.\s+/.test(line)) || '';
      const title = titleLine.replace(/^\d+\.\s+/, '').trim();
      const desc = lines.find((line) => line !== titleLine && line !== urlLine) || '';
      rows.push({ title, url: urlLine, desc });
    }
    return rows;
  }

  function extractPreferredDomains(question = '') {
    const text = String(question || '').trim();
    const domains = new Set();
    const matches = text.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/ig) || [];
    for (const item of matches) {
      const domain = String(item || '').trim().toLowerCase();
      if (domain) domains.add(domain);
    }
    return [...domains];
  }

  function scoreSearchCandidate(row = {}, question = '', preferredDomains = []) {
    const url = String(row?.url || '').trim().toLowerCase();
    const title = String(row?.title || '').trim().toLowerCase();
    const desc = String(row?.desc || '').trim().toLowerCase();
    const text = String(question || '').trim().toLowerCase();
    let score = 0;
    if (preferredDomains.some((domain) => url.includes(domain))) score += 100;
    if (/(\u5b98\u7f51|\u5b98\u65b9|official)/i.test(text) && /(official|docs|developer|help|support|api)/i.test(`${url} ${title}`)) score += 30;
    if (/(\u6587\u6863|docs?|documentation|api)/i.test(text) && /(docs|doc|developer|api)/i.test(`${url} ${title}`)) score += 25;
    if (/(latest|\u6700\u65b0|news|\u65b0\u95fb)/i.test(text) && /(news|blog|release|changelog|announc)/i.test(`${url} ${title} ${desc}`)) score += 10;
    if (/^https?:\/\//i.test(url)) score += 5;
    return score;
  }

  function resolveWebFetchArgs(step = {}, state = {}) {
    const stepInputs = normalizeObject(step?.inputs, {});
    const existingUrl = String(stepInputs.url || '').trim();
    if (existingUrl) return stepInputs;

    const previousEnvelopes = normalizeArray(state.execution?.toolResults);
    const previousSteps = normalizeArray(state.plan?.steps);
    const webSearchResult = [...previousEnvelopes].reverse().find((item) => String(item?.tool_name || '').trim() === 'web_search' && String(item?.status || '').trim() === 'completed')
      || previousSteps
        .filter((candidate) => String(candidate?.tool || '').trim() === 'web_search')
        .flatMap((candidate) => normalizeArray(candidate?.evidence))
        .reverse()
        .find((item) => String(item?.status || '').trim() === 'completed');
    const rows = parseSearchResultRows(webSearchResult?.result || '');
    if (rows.length === 0) {
      throw new Error('web_fetch could not resolve url from previous web_search result');
    }

    const question = String(state.request?.question || '').trim();
    const preferredDomains = extractPreferredDomains(question);
    const ranked = rows
      .map((row, index) => ({ ...row, score: scoreSearchCandidate(row, question, preferredDomains), index }))
      .sort((left, right) => right.score - left.score || left.index - right.index);
    const selected = ranked[0] || null;
    if (!selected?.url) {
      throw new Error('web_fetch could not find a usable url from search results');
    }
    return {
      ...stepInputs,
      url: selected.url
    };
  }

  function buildToolContext(state, overrides = {}) {
    const request = normalizeObject(state.request, {});
    const routeMeta = normalizeObject(request.routeMeta, {});
    const toolName = String(overrides.toolName || '').trim();
    const fallbackMainConversationSnapshot = toolName === 'get_context_stats'
      ? buildLiveMainConversationSnapshot(state, {
        affinity: state.memory?.affinity,
        allowedTools: computeEffectiveAllowedTools(request, state.execution?.memoryCliTurn),
        source: String(overrides.snapshotSource || 'tool_context').trim() || 'tool_context'
      })
      : null;
    return {
      userId: String(request.userId || '').trim(),
      routePolicyKey: String(request.routePolicyKey || '').trim(),
      topRouteType: String(request.topRouteType || '').trim(),
      routeMeta,
      reviewMode: String(request.reviewMode || '').trim(),
      taskType: String(routeMeta.taskType || routeMeta.task_type || '').trim(),
      sessionId: String(routeMeta.sessionId || routeMeta.session_id || '').trim(),
      channelId: String(routeMeta.channelId || routeMeta.channel_id || '').trim(),
      groupId: String(routeMeta.groupId || routeMeta.group_id || '').trim(),
      mainConversationSnapshot: overrides.mainConversationSnapshot
        && typeof overrides.mainConversationSnapshot === 'object'
        && Array.isArray(overrides.mainConversationSnapshot.segments)
        ? { ...overrides.mainConversationSnapshot }
        : fallbackMainConversationSnapshot
    };
  }

  function logToolExecution(envelope = {}, step = {}, state = {}, extra = {}) {
    const request = normalizeObject(state.request, {});
    const routeMeta = normalizeObject(request.routeMeta, {});
    const args = normalizeObject(envelope.args, normalizeObject(step.inputs, {}));
    const sanitizedArgs = { ...args };
    delete sanitizedArgs.__context;
    console.log('[graph-tool]', {
      node: String(extra.node || state.execution?.currentNode || '').trim() || 'unknown',
      topRouteType: String(request.topRouteType || routeMeta.topRouteType || '').trim(),
      routePolicyKey: String(request.routePolicyKey || '').trim(),
      toolName: String(envelope.tool_name || step.tool || '').trim(),
      stepId: String(envelope.step_id || step.id || '').trim(),
      status: String(envelope.status || '').trim(),
      batchId: String(envelope.batch_id || step.batchId || '').trim(),
      batchIndex: Number.isFinite(Number(envelope.batch_index))
        ? Number(envelope.batch_index)
        : (Number.isFinite(Number(step.batchIndex)) ? Number(step.batchIndex) : null),
      userId: String(request.userId || '').trim(),
      groupId: String(routeMeta.groupId || routeMeta.group_id || '').trim(),
      allowedTools: normalizeArray(extra.allowedTools || request.allowedTools),
      argsPreview: summarizeToolLogValue(sanitizedArgs),
      resultPreview: summarizeToolLogValue(envelope.result),
      blockedReason: String(envelope.blockedReason || '').trim(),
      retryable: Boolean(envelope.retryable)
    });
  }

  function maybeCaptureToolFailure(envelope = {}, step = {}, state = {}) {
    if (!config.SELF_IMPROVEMENT_ENABLED) return;
    const status = String(envelope?.status || '').trim().toLowerCase();
    if (status === 'completed') return;
    const request = normalizeObject(state.request, {});
    const routeMeta = normalizeObject(request.routeMeta, {});
    try {
      captureToolFailure({
        envelope,
        purpose: String(step?.instruction || step?.successCriteria || '').trim(),
        details: String(step?.successCriteria || '').trim(),
        routePolicyKey: String(request.routePolicyKey || '').trim(),
        topRouteType: String(request.topRouteType || routeMeta.topRouteType || '').trim(),
        toolName: String(envelope.tool_name || step?.tool || routeMeta.toolName || routeMeta.tool_name || '').trim(),
        taskType: String(routeMeta.taskType || routeMeta.task_type || '').trim(),
        sessionId: String(routeMeta.sessionId || routeMeta.session_id || '').trim(),
        channelId: String(routeMeta.channelId || routeMeta.channel_id || '').trim(),
        groupId: String(routeMeta.groupId || routeMeta.group_id || '').trim(),
        userId: String(request.userId || '').trim(),
        evidence: [
          { label: 'tool_result', excerpt: String(envelope?.result || '').trim() }
        ]
      });
    } catch (error) {
      console.error('[self-improvement] tool failure capture failed:', error?.message || error);
    }
  }

  function buildBlockedToolEnvelope(step = {}, memoryCliTurn = null, reason = 'tool_not_allowed') {
    const toolName = String(step?.tool || '').trim();
    const policy = getPolicy(toolName);
    const blockedResult = `Tool not allowed: ${toolName || 'unknown'}`;
    let nextMemoryCliTurn = createMemoryCliTurnState(memoryCliTurn);
    let invalidateMemoryPrompt = false;
    if (toolName === 'memory_cli') {
      nextMemoryCliTurn = createMemoryCliTurnState(
        updateMemoryCliTurnStateAfterError(nextMemoryCliTurn, 'tool_error')
      );
      invalidateMemoryPrompt = true;
    }
    const baseEnvelope = computeToolEnvelope(step, blockedResult, policy);
    const directToolCallId = String(step?.directToolCallId || step?.toolCallId || '').trim();
    return {
      ...baseEnvelope,
      ...(directToolCallId ? { tool_call_id: directToolCallId } : {}),
      status: 'blocked',
      retryable: false,
      result: blockedResult,
      ...(toolName === 'memory_cli' ? { memoryCliTurn: nextMemoryCliTurn, invalidateMemoryPrompt } : {}),
      blockedReason: String(reason || 'tool_not_allowed').trim() || 'tool_not_allowed'
    };
  }

  async function runToolStep(step, state, runtimeOptions = {}) {
    const toolName = String(step.tool || '').trim();
    const policy = getPolicy(toolName);
    const executionState = normalizeObject(state.execution, {});
    const toolContextOverrides = {
      ...runtimeOptions,
      toolName
    };

    if (
      String(step?.source || '').trim() === 'direct_chat'
      && String(step?.blockingReason || '').trim() === 'tool_not_allowed'
    ) {
      const envelope = buildBlockedToolEnvelope(step, executionState.memoryCliTurn, 'tool_not_allowed');
      maybeCaptureToolFailure(envelope, step, state);
      logToolExecution(envelope, step, state, {
        node: runtimeOptions.node || state.execution?.currentNode || 'unknown',
        allowedTools: state.request?.allowedTools
      });
      return envelope;
    }

    try {
      let preparedArgs = step.inputs || {};
      if (toolName === 'web_fetch') {
        preparedArgs = resolveWebFetchArgs({
          ...step,
          inputs: preparedArgs
        }, state);
      }
      let normalizedArgs = enforceToolPolicy(toolName, preparedArgs, {
        userId: state.request.userId
      });
      if (toolName === 'memory_cli') {
        if (isPlannerSingleAuthorityEnabled()) {
          const commandText = String(normalizedArgs.command || '').trim();
          if (/^mem open --ref\s+"mc_ref:planner_pending:/i.test(commandText)) {
            const previousEnvelope = normalizeArray(state.plan?.steps)
              .find((candidate) => String(candidate.id || '').trim() !== String(step.id || '').trim() && normalizeArray(candidate.evidence).length > 0);
            const previousEvidence = normalizeArray(previousEnvelope?.evidence).slice(-1)[0] || null;
            const previousResult = safeParseMemoryCliResult(previousEvidence?.result);
            const previousRef = String(previousResult?.results?.[0]?.ref || '').trim();
            if (previousRef) {
              normalizedArgs = {
                ...normalizedArgs,
                command: `mem open --ref ${JSON.stringify(previousRef)}`
              };
            }
          }
        }
        const decision = decideMemoryCliTurnAction(normalizedArgs.command, executionState.memoryCliTurn);
        if (!decision.ok) {
          const result = typeof decision.result === 'string' ? decision.result : JSON.stringify(decision.result);
          const envelope = {
            ...computeToolEnvelope({ ...step, inputs: { ...normalizedArgs, command: decision.preparedCommand || normalizedArgs.command } }, result, policy),
            status: 'blocked',
            retryable: decision.errorType !== 'tool_error',
            result,
            memoryCliTurn: decision.nextState,
            invalidateMemoryPrompt: true,
            repairApplied: Boolean(decision.repairApplied),
            repairStrategy: normalizeArray(decision.repairStrategy),
            blockedReason: String(decision.reason || '').trim()
          };
          maybeCaptureToolFailure(envelope, { ...step, inputs: normalizedArgs }, state);
          return envelope;
        }

        const executor = toolExecutors[toolName];
        if (!executor) {
          const envelope = {
            ...computeToolEnvelope(step, `Unknown tool: ${toolName}`, policy),
            memoryCliTurn: executionState.memoryCliTurn
          };
          maybeCaptureToolFailure(envelope, step, state);
          return envelope;
        }

        const out = await executor({
          ...normalizedArgs,
          command: decision.preparedCommand || normalizedArgs.command,
          __context: buildToolContext(state, toolContextOverrides)
        });
        const envelope = computeToolEnvelope({
          ...step,
          inputs: {
            ...normalizedArgs,
            command: decision.preparedCommand || normalizedArgs.command
          }
        }, out, policy);
        const resultEnvelope = {
          ...envelope,
          memoryCliTurn: createMemoryCliTurnState(
            updateMemoryCliTurnStateAfterResult(executionState.memoryCliTurn, decision.parsed, out)
          ),
          invalidateMemoryPrompt: true,
          repairApplied: Boolean(decision.repairApplied),
          repairStrategy: normalizeArray(decision.repairStrategy)
        };
        maybeCaptureToolFailure(resultEnvelope, { ...step, inputs: normalizedArgs }, state);
        logToolExecution(resultEnvelope, { ...step, inputs: normalizedArgs }, state, {
          node: runtimeOptions.node || state.execution?.currentNode || 'unknown',
          allowedTools: state.request?.allowedTools
        });
        return resultEnvelope;
      }

      const executor = toolExecutors[toolName];
      if (!executor) {
        const envelope = computeToolEnvelope(step, `Unknown tool: ${toolName}`, policy);
        maybeCaptureToolFailure(envelope, step, state);
        return envelope;
      }

      const out = await executor({
        ...normalizedArgs,
        __context: buildToolContext(state, toolContextOverrides)
      });
      const envelope = computeToolEnvelope({ ...step, inputs: normalizedArgs }, out, policy);
      maybeCaptureToolFailure(envelope, { ...step, inputs: normalizedArgs }, state);
      logToolExecution(envelope, { ...step, inputs: normalizedArgs }, state, {
        node: runtimeOptions.node || state.execution?.currentNode || 'unknown',
        allowedTools: state.request?.allowedTools
      });
      return envelope;
    } catch (error) {
      const base = computeToolEnvelope(step, `Tool error: ${error.message}`, policy);
      maybeCaptureToolFailure(base, step, state);
      logToolExecution(base, step, state, {
        node: runtimeOptions.node || state.execution?.currentNode || 'unknown',
        allowedTools: state.request?.allowedTools
      });
      if (toolName === 'memory_cli') {
        return {
          ...base,
          memoryCliTurn: createMemoryCliTurnState(
            updateMemoryCliTurnStateAfterError(executionState.memoryCliTurn, 'tool_error')
          ),
          invalidateMemoryPrompt: true
        };
      }
      return base;
    }
  }

  async function runDirectChatToolLoop(messagesToSend, state, directContext, runtimeOptions = {}) {
    const request = normalizeObject(state.request, {});
    const initialAllowedTools = computeEffectiveAllowedTools(request, state.execution?.memoryCliTurn);
    let nextMemoryCliTurn = createMemoryCliTurnState(state.execution?.memoryCliTurn);
    let effectiveAllowedTools = initialAllowedTools;
    let loopMessages = normalizeArray(messagesToSend).map((message) => ({ ...message }));
    const loopEvents = [
      createEvent('effectiveAllowedTools', {
        node: 'direct_reply',
        allowedTools: effectiveAllowedTools
      }),
      createEvent('memoryCliTurn', {
        node: 'direct_reply',
        memoryCliTurn: nextMemoryCliTurn
      })
    ];
    const executedToolEnvelopes = [];

    function throwWithDirectToolLoopState(error) {
      const nextError = error instanceof Error ? error : new Error(String(error || ''));
      nextError.directToolLoopState = cloneDirectToolLoopState({
        messages: loopMessages,
        events: loopEvents,
        memoryCliTurn: nextMemoryCliTurn,
        executedToolEnvelopes,
        effectiveAllowedTools
      });
      throw nextError;
    }

    async function requestAssistantMessageForLoop(options = {}) {
      try {
        return normalizeMessageForToolLoop(await requestAssistantMessageImpl(loopMessages, {
          ...directContext,
          ...normalizeObject(options, {})
        }));
      } catch (error) {
        throwWithDirectToolLoopState(error);
      }
    }

    const firstAssistantMessage = runtimeOptions.firstAssistantMessage
      ? normalizeMessageForToolLoop(runtimeOptions.firstAssistantMessage)
      : await requestAssistantMessageForLoop({
        disableTools: effectiveAllowedTools.length === 0,
        allowedTools: effectiveAllowedTools
      });
    loopMessages.push(firstAssistantMessage);

    let assistantMessage = firstAssistantMessage;
    let toolCalls = normalizeArray(firstAssistantMessage.tool_calls);

    if (toolCalls.length === 0) {
      const replyResolution = await resolveToolLoopReply(firstAssistantMessage, loopMessages, directContext, 'tool_error', executedToolEnvelopes);
      return {
        reply: replyResolution.text,
        noToolCalls: true,
        messages: loopMessages,
        events: loopEvents,
        memoryCliTurn: nextMemoryCliTurn,
        executedToolEnvelopes,
        effectiveAllowedTools
      };
    }

    for (const toolCall of toolCalls) {
      loopEvents.push(createEvent('tool_call_detected', {
        node: 'direct_reply',
        tool_name: String(toolCall?.function?.name || '').trim(),
        tool_call_id: String(toolCall?.id || '').trim()
      }));
    }

    const toolCallItems = toolCalls.map((toolCall, index) => {
      const built = buildDirectChatToolStep(toolCall, index + 1);
      return {
        index,
        toolCall,
        parsedArgs: built.parsedArgs,
        toolName: built.toolName,
        step: built.step,
        allowed: shouldAllowDirectToolCall(toolCall, effectiveAllowedTools)
      };
    });
    const allowedToolCallItems = toolCallItems.filter((item) => item.allowed);

    const assignBatchMetaToItem = (item, batch = {}) => ({
      ...item,
      step: {
        ...normalizeObject(item?.step, {}),
        ...(String(batch.batchId || '').trim() ? { batchId: String(batch.batchId).trim() } : {}),
        ...(Number.isFinite(Number(batch.batchIndex)) ? { batchIndex: Number(batch.batchIndex) } : {})
      }
    });

    const recordDirectToolEnvelope = (envelope, toolCall) => {
      const toolCallId = String(toolCall?.id || envelope?.tool_call_id || '').trim() || envelope?.tool_call_id;
      const normalizedEnvelope = {
        ...envelope,
        tool_call_id: toolCallId
      };
      logToolExecution(normalizedEnvelope, {}, {
        ...state,
        request: {
          ...request,
          allowedTools: effectiveAllowedTools
        },
        execution: {
          ...state.execution,
          currentNode: 'direct_reply'
        }
      }, {
        node: 'direct_reply',
        allowedTools: effectiveAllowedTools
      });
      executedToolEnvelopes.push(normalizedEnvelope);
      if (normalizedEnvelope.memoryCliTurn) {
        nextMemoryCliTurn = createMemoryCliTurnState(normalizedEnvelope.memoryCliTurn);
      }
      effectiveAllowedTools = computeEffectiveAllowedTools(request, nextMemoryCliTurn);
      loopEvents.push(createEvent('tool_result', {
        ...normalizedEnvelope,
        node: 'direct_reply',
        tool_call_id: toolCallId
      }));
      loopEvents.push(createEvent('memoryCliTurn', {
        node: 'direct_reply',
        memoryCliTurn: nextMemoryCliTurn
      }));
      loopEvents.push(createEvent('effectiveAllowedTools', {
        node: 'direct_reply',
        allowedTools: effectiveAllowedTools
      }));
      loopMessages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: String(normalizedEnvelope.result || '')
      });
      return normalizedEnvelope;
    };

    const createBlockedDirectToolEnvelope = (item, failureType = 'tool_error') => {
      const toolName = String(item?.toolName || '').trim();
      const policy = getPolicy(toolName);
      const blockedResult = `Tool not allowed: ${toolName || 'unknown'}`;
      const baseEnvelope = computeToolEnvelope(item?.step || {}, blockedResult, policy);
      if (toolName === 'memory_cli') {
        nextMemoryCliTurn = createMemoryCliTurnState(
          updateMemoryCliTurnStateAfterError(nextMemoryCliTurn, failureType)
        );
      }
      return {
        ...baseEnvelope,
        status: 'blocked',
        retryable: false,
        result: blockedResult,
        memoryCliTurn: nextMemoryCliTurn,
        invalidateMemoryPrompt: toolName === 'memory_cli',
        blockedReason: 'tool_not_allowed'
      };
    };

    const runOneDirectTool = async (item) => {
      const envelope = await runToolStep(item.step, {
        ...state,
        request: {
          ...request,
          allowedTools: effectiveAllowedTools
        },
        execution: {
          ...state.execution,
          memoryCliTurn: nextMemoryCliTurn
        }
      }, runtimeOptions);
      return recordDirectToolEnvelope(envelope, item.toolCall);
    };

    const executeDirectToolBatch = async (items = []) => {
      const ordered = [];
      for (const item of normalizeArray(items)) {
        if (!item?.allowed) {
          ordered.push(recordDirectToolEnvelope(createBlockedDirectToolEnvelope(item), item.toolCall));
          continue;
        }
        ordered.push(item);
      }
      const allowedItems = ordered.filter((item) => item && !item.tool_call_id);
      if (allowedItems.length === 0) return ordered;
      if (allowedItems.length === 1) {
        const envelope = await runOneDirectTool(allowedItems[0]);
        return ordered.map((item) => (item === allowedItems[0] ? envelope : item));
      }
      const settled = await Promise.allSettled(allowedItems.map((item) => runToolStep(item.step, {
        ...state,
        request: {
          ...request,
          allowedTools: effectiveAllowedTools
        },
        execution: {
          ...state.execution,
          memoryCliTurn: nextMemoryCliTurn
        }
      }, runtimeOptions)));
      let allowedIndex = 0;
      return ordered.map((item) => {
        if (item && item.tool_call_id) return item;
        const settledItem = settled[allowedIndex];
        const sourceItem = allowedItems[allowedIndex];
        allowedIndex += 1;
        const envelope = settledItem?.status === 'fulfilled'
          ? settledItem.value
          : computeToolEnvelope(sourceItem.step, `Tool error: ${settledItem?.reason?.message || 'unknown error'}`, getPolicy(sourceItem.toolName));
        return recordDirectToolEnvelope(envelope, sourceItem.toolCall);
      });
    };

    let hadBlockedToolCall = false;
    const directBatches = buildDirectChatExecutionBatches(toolCallItems, (item) => item.step);
    const directBatchResults = [];
    for (const batch of directBatches) {
      const batchItems = normalizeArray(batch.items).map((item) => assignBatchMetaToItem(item, batch));
      const results = await executeDirectToolBatch(batchItems);
      directBatchResults.push(...results);
      if (results.some((item) => String(item?.status || '').trim() === 'blocked')) {
        hadBlockedToolCall = true;
      }
    }

    if (allowedToolCallItems.length === 0) {
      if (!hadBlockedToolCall) {
        nextMemoryCliTurn = createMemoryCliTurnState(
          updateMemoryCliTurnStateAfterError(nextMemoryCliTurn, 'tool_error')
        );
        effectiveAllowedTools = computeEffectiveAllowedTools(request, nextMemoryCliTurn);
      }
      loopEvents.push(createEvent('tool_loop_forced_answer', {
        node: 'direct_reply',
        reason: 'tool_not_allowed',
        allowedTools: effectiveAllowedTools
      }));
      assistantMessage = await requestAssistantMessageForLoop({
        disableTools: true,
        allowedTools: []
      });
      loopMessages.push(assistantMessage);
      const replyResolution = await resolveToolLoopReply(assistantMessage, loopMessages.slice(0, -1), directContext, 'tool_error', executedToolEnvelopes);
      return {
        reply: replyResolution.text,
        noToolCalls: false,
        messages: loopMessages,
        events: loopEvents,
        memoryCliTurn: nextMemoryCliTurn,
        executedToolEnvelopes,
        effectiveAllowedTools
      };
    }

    const firstAllowedToolCall = allowedToolCallItems[0]?.toolCall || null;
    const firstAllowedEnvelope = directBatchResults.find((item) => String(item?.status || '').trim() !== 'blocked') || null;
    const firstToolName = String(firstAllowedToolCall?.function?.name || '').trim();
    if (firstToolName === 'get_context_stats' && allowedToolCallItems.length === 1) {
      assistantMessage = await requestAssistantMessageForLoop({
        disableTools: true,
        allowedTools: []
      });
      loopMessages.push(assistantMessage);
      const replyResolution = await resolveToolLoopReply(assistantMessage, loopMessages.slice(0, -1), directContext, 'tool_error', executedToolEnvelopes);
      loopEvents.push(createEvent('tool_loop_forced_answer', {
        node: 'direct_reply',
        reason: 'single_read_only_tool_complete',
        allowedTools: []
      }));
      return {
        reply: replyResolution.text,
        noToolCalls: false,
        messages: loopMessages,
        events: loopEvents,
        memoryCliTurn: nextMemoryCliTurn,
        executedToolEnvelopes,
        effectiveAllowedTools
      };
    }
    const firstCommandWasSearch = String(nextMemoryCliTurn.lastSuccessCommand || '').trim() === 'search';
    const mayOpenOneMoreTime = firstAllowedEnvelope && firstAllowedEnvelope.status === 'completed'
      && firstCommandWasSearch
      && nextMemoryCliTurn.lastResultHadHits
      && !nextMemoryCliTurn.mustAnswer
      && nextMemoryCliTurn.openCount < 1
      && effectiveAllowedTools.includes('memory_cli');

    assistantMessage = await requestAssistantMessageForLoop({
      disableTools: !mayOpenOneMoreTime,
      allowedTools: mayOpenOneMoreTime ? effectiveAllowedTools : []
    });
    loopMessages.push(assistantMessage);

    if (!mayOpenOneMoreTime) {
      const replyResolution = await resolveToolLoopReply(assistantMessage, loopMessages.slice(0, -1), directContext, 'post_tool_empty_reply', executedToolEnvelopes);
      loopEvents.push(createEvent('tool_loop_forced_answer', {
        node: 'direct_reply',
        reason: nextMemoryCliTurn.mustAnswer ? 'must_answer' : 'single_tool_complete',
        allowedTools: [],
        failureType: replyResolution.source === 'controlled_failure' ? 'post_tool_empty_reply' : ''
      }));
      return {
        reply: replyResolution.text,
        noToolCalls: false,
        messages: loopMessages,
        events: loopEvents,
        memoryCliTurn: nextMemoryCliTurn,
        executedToolEnvelopes,
        effectiveAllowedTools
      };
    }

    toolCalls = normalizeArray(assistantMessage.tool_calls);
    if (toolCalls.length === 0) {
      const replyResolution = await resolveToolLoopReply(assistantMessage, loopMessages.slice(0, -1), directContext, 'tool_error', executedToolEnvelopes);
      loopEvents.push(createEvent('tool_loop_forced_answer', {
        node: 'direct_reply',
        reason: 'no_followup_tool_call',
        allowedTools: effectiveAllowedTools
      }));
      return {
        reply: replyResolution.text,
        noToolCalls: false,
        messages: loopMessages,
        events: loopEvents,
        memoryCliTurn: nextMemoryCliTurn,
        executedToolEnvelopes,
        effectiveAllowedTools
      };
    }

    for (const toolCall of toolCalls) {
      loopEvents.push(createEvent('tool_call_detected', {
        node: 'direct_reply',
        tool_name: String(toolCall?.function?.name || '').trim(),
        tool_call_id: String(toolCall?.id || '').trim()
      }));
    }

    const secondToolCall = toolCalls[0] || null;
    const secondArgs = parseToolCallArgs(secondToolCall);
    const secondCommand = String(secondArgs?.command || '').trim().toLowerCase();
    const secondIsOpen = shouldAllowDirectToolCall(secondToolCall, effectiveAllowedTools)
      && secondCommand.startsWith('mem open');

    if (secondIsOpen) {
      await executeDirectToolBatch([{
        index: 0,
        toolCall: secondToolCall,
        parsedArgs: secondArgs,
        toolName: String(secondToolCall?.function?.name || '').trim(),
        step: buildDirectChatToolStep(secondToolCall, 2).step,
        allowed: true
      }]);
    } else {
      nextMemoryCliTurn = createMemoryCliTurnState(
        updateMemoryCliTurnStateAfterError(nextMemoryCliTurn, 'tool_loop_limit')
      );
      effectiveAllowedTools = computeEffectiveAllowedTools(request, nextMemoryCliTurn);
      loopEvents.push(createEvent('tool_loop_forced_answer', {
        node: 'direct_reply',
        reason: 'followup_not_open',
        allowedTools: effectiveAllowedTools
      }));
    }

    assistantMessage = await requestAssistantMessageForLoop({
      disableTools: true,
      allowedTools: []
    });
    loopMessages.push(assistantMessage);
    const replyResolution = await resolveToolLoopReply(assistantMessage, loopMessages.slice(0, -1), directContext, 'tool_error', executedToolEnvelopes);
    loopEvents.push(createEvent('tool_loop_forced_answer', {
      node: 'direct_reply',
      reason: 'final_answer_required',
      allowedTools: []
    }));

    return {
      reply: replyResolution.text,
      noToolCalls: false,
      messages: loopMessages,
      events: loopEvents,
      memoryCliTurn: nextMemoryCliTurn,
      executedToolEnvelopes,
      effectiveAllowedTools
    };
  }

  function updatePlanStepsWithEnvelope(steps = [], envelope = {}) {
    return normalizeArray(steps).map((step) => {
      if (String(step.id || '').trim() !== String(envelope.step_id || '').trim()) return { ...step };
      const evidence = normalizeArray(step.evidence).concat([envelope]);
      const batchId = String(envelope.batch_id || step.batchId || '').trim();
      const batchIndex = Number.isFinite(Number(envelope.batch_index))
        ? Number(envelope.batch_index)
        : (Number.isFinite(Number(step.batchIndex)) ? Number(step.batchIndex) : null);
      return {
        ...step,
        inputs: envelope.args && typeof envelope.args === 'object' && !Array.isArray(envelope.args)
          ? { ...envelope.args }
          : step.inputs,
        attempts: Number(step.attempts || 0) + 1,
        status: envelope.status === 'completed' ? 'completed' : 'failed',
        evidence,
        blockingReason: envelope.status === 'completed'
          ? ''
          : String(envelope.blockedReason || envelope.result || '').slice(0, 240),
        batchId,
        batchIndex
      };
    });
  }

  // Fixed V2 topology:
  // prepare -> route -> direct_reply | planner -> dispatch -> validate
  // -> repair_or_continue -> draft_reply -> humanize -> final_validate -> persist
  const graph = new StateGraph(GraphStateV2);
  graph.addNode('prepare', prepareNodeImpl);
  graph.addNode('route', routeNode);
  graph.addNode('direct_reply', directReplyNodeImpl);
  graph.addNode('planner', plannerNode);
  graph.addNode('dispatch', dispatchNodeImpl);
  graph.addNode('validate', validateNode);
  graph.addNode('repair_or_continue', repairNode);
  graph.addNode('draft_reply', draftReplyNode);
  graph.addNode('humanize', humanizeNode);
  graph.addNode('final_validate', finalValidateNode);
  graph.addNode('persist', persistNode);

  graph.setEntryPoint('prepare');
  graph.addEdge('prepare', 'route');
  graph.addConditionalEdges('route', routeAfterRoute, {
    chat: 'direct_reply',
    proactive: 'direct_reply',
    review: 'direct_reply',
    image: 'direct_reply',
    minecraft: 'direct_reply',
    tool_plan: 'planner'
  });
  graph.addConditionalEdges('direct_reply', routeAfterDirectReplyImpl, {
    planner: 'planner',
    persist: 'persist'
  });
  graph.addEdge('planner', 'dispatch');
  graph.addEdge('dispatch', 'validate');
  graph.addConditionalEdges('validate', routeAfterValidate, {
    answer: 'draft_reply',
    repair: 'repair_or_continue'
  });
  graph.addConditionalEdges('repair_or_continue', routeAfterRepair, {
    dispatch: 'dispatch',
    answer: 'draft_reply'
  });
  graph.addConditionalEdges('draft_reply', routeAfterDraftReply, {
    dispatch: 'dispatch',
    humanize: 'humanize'
  });
  graph.addEdge('humanize', 'final_validate');
  graph.addEdge('final_validate', 'persist');
  graph.addEdge('persist', END);

  const app = graph.compile();

  // Public entry preserves the legacy askAI signature while forcing V2 callers
  // through the compiled graph, checkpoint store, and event stream.
  async function askAIByGraphV2(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
    const requestOptions = {
      ...options,
      streaming: Boolean(!options.disableStream && typeof options.onDelta === 'function')
    };
    const init = createInitialState(question, userInfo, userId, customPrompt, imageUrl, requestOptions);
    const out = await app.invoke(init);
    options.streamHadOutput = Boolean(out?.output?.stream?.hadOutput);
    options.streamCompleted = Boolean(out?.output?.stream?.completed);
    options.streamFallbackToNonStream = Boolean(out?.output?.stream?.fallbackToNonStream);
    const finalReply = sanitizeUserFacingText(out?.output?.finalReply || out?.output?.draftReply || '').trim();
    return finalReply || 'The network was unstable just now. Please try again.';
  }

  return {
    app,
    askAIByGraphV2,
    createInitialState,
    routeMode: routeAfterRoute,
    store
  };
}

let runtimeSingleton = null;

function getRuntime() {
  if (!runtimeSingleton) {
    runtimeSingleton = createRuntime();
  }
  return runtimeSingleton;
}

async function askAIByGraphV2(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
  return getRuntime().askAIByGraphV2(question, userInfo, userId, customPrompt, imageUrl, options);
}

module.exports = {
  askAIByGraphV2,
  createRuntime,
  createInitialState,
  getRuntime
};
