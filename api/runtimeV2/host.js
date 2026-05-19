// Primary LangGraph runtime host. New routing, recovery, eventing, and persist
// behavior belongs here or in the neutral helper modules it composes.
const { StateGraph, END } = require('@langchain/langgraph');
const config = require('../../config');
const { applyLangGraphV2Topology } = require('./topology');
const {
  buildDynamicPrompt,
  buildVisionMessageContent,
  mergeAllowedToolsWithMemoryCli,
  shouldExposeMemoryCli,
  shouldBypassHumanizerForPolicy
} = require('./context/service');
const {
  buildPlan,
  synthesizeFromPlan,
  requiresToolEvidence
} = require('./planning/service');
const { sanitizeUserFacingText } = require('../../utils/userFacingText');
const {
  requestStreamingReply,
  finalizeStreamingReplyWithHumanizer,
  requestNonStreamingReply,
  requestAssistantMessage
} = require('./model/service');
const {
  buildToolEvidenceBundle,
  normalizeExecutionEnvelope,
  normalizeText
} = require('./contracts');
const {
  GraphStateV2,
  buildExecLogsFromSteps,
  buildReplyOnlyPlan,
  findEvidenceEnvelope,
  isCompletedSideEffectStep,
  normalizePlanForResume,
  rebuildFinalPlanFromSteps,
  snapshotState
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
const { createCheckpointStore } = require('../../utils/langgraphV2Store');
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
const {
  getSessionSummaryCooldownStatus,
  saveSessionContextSummary
} = require('../../utils/sessionContextSummaryStore');
const {
  generateSessionContextSummary
} = require('../../utils/sessionContextSummaryRuntime');
const { createConversationContextHelpers } = require('./runtime/conversationContext');
const { createContinuityProbeHelpers } = require('./runtime/continuityProbe');
const { createDirectToolLoopHelpers } = require('./runtime/directToolLoop');
const { createEvent, emitEvents, pickRouteMetaForPostReplyJob, stableHash, summarizeToolLogValue } = require('./runtime/events');
const {
  appendRequestTraceEvent,
  nextTracePhase,
  normalizeRequestTrace
} = require('../../utils/requestTrace');
const { createStreamingCoordinatorHelpers } = require('./runtime/streamingCoordinator');
const { createToolExecutionHelpers } = require('./runtime/toolExecution');
const { buildSecuritySystemPrompt, classifyPromptThreat, protectFinalOutput } = require('../../utils/promptSecurity');
const {
  nowTs,
  normalizeObject,
  normalizeArray,
  buildLatencyDecision,
  buildContinuitySnapshotPayload,
  buildV2CanonicalSegments: buildV2CanonicalSegmentsWithDeps
} = require('./host/runtimeHelpers');
const {
  appendMemoryEvent,
  materializeMemoryViews,
  recordPersonaMemoryOutcome,
  warmMcpRegistry,
  summarizeShortTermChunk
} = require('./host/memoryHooks');
const {
  isReviewMode,
  isChatLikeRoute,
  isDirectChatRequest,
  shouldQueueMemoryLearningForV2,
  shouldAppendDailyJournalForV2
} = require('./host/routePredicates');
const {
  isSideEffectPolicy,
  getRouteToolPlanner,
  getToolPlannerExecutionPlan,
  isPlannerSingleAuthorityEnabled,
  createInitialState,
  normalizeMode,
  translatePlan
} = require('./host/requestState');

function buildV2CanonicalSegments(state, input = {}) {
  return buildV2CanonicalSegmentsWithDeps(state, input, {
    resolveModelTokenLimit,
    buildContextCompactionPlan
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

  let mcpWarmPromise = null;
  if (config.MCP_WARM_ON_RUNTIME_INIT) {
    mcpWarmPromise = warmMcpRegistry({ source: 'runtime_init' });
    if (!config.MCP_WARM_BLOCKING) {
      mcpWarmPromise.catch((error) => {
        console.error('[mcp] runtime warmup failed:', error?.message || error);
      });
    }
  }

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

  const {
    buildAssistantOnlyContextMessages,
    buildContinuitySystemMessage,
    computeEffectiveAllowedTools,
    getMainConversationSystemMessages,
    resolveMainConversationModelName,
    resolveMainConversationTokenLimit,
    stripMemoryCliInstruction
  } = createConversationContextHelpers({
    config,
    normalizeToolNames,
    filterAllowedToolsForMemoryCliTurn,
    mergeAllowedToolsWithMemoryCli,
    isPlannerSingleAuthorityEnabled,
    getRouteToolPlanner,
    resolveModelTokenLimit,
    buildSecuritySystemPrompt
  });

  function buildMainConversationContextSnapshot(state, segmentedMessages = {}, options = {}) {
    const request = normalizeObject(state.request, {});
    const routeMeta = normalizeObject(request.routeMeta, {});
    const affinity = normalizeObject(options.affinity, state.memory?.affinity);
    const canonical = buildV2CanonicalSegments(state, {
      systemPromptMessages: normalizeArray(segmentedMessages.systemMessages),
      routePromptMessages: [],
      continuityMessages: normalizeArray(segmentedMessages.continuityStateMessages),
      shortTermSummaryMessages: normalizeArray(segmentedMessages.summaryMessages),
      recentHistoryMessages: normalizeArray(segmentedMessages.recentHistory),
      assistantOnlyContextMessages: normalizeArray(segmentedMessages.assistantOnlyContextMessages),
      userTurnMessages: normalizeArray(segmentedMessages.userTurnMessages),
      toolEvidenceMessages: normalizeArray(segmentedMessages.globalToolEvidenceMessages),
      plannerArtifactMessages: normalizeArray(options.plannerArtifactMessages),
      modelName: resolveMainConversationModelName(request),
      modelWindowTokens: resolveMainConversationTokenLimit(request, affinity),
      maxOutputTokens: Number(request.modelConfig?.maxTokens || config.AI_MAX_TOKENS || config.MAIN_REPLY_DEFAULT_MAX_TOKENS || 8192),
      source: String(options.source || 'direct_reply').trim() || 'direct_reply'
    });
    return {
      modelName: resolveMainConversationModelName(request),
      tokenLimit: resolveMainConversationTokenLimit(request, affinity),
      routeMeta,
      allowedTools: normalizeArray(options.allowedTools || request.allowedTools),
      snapshotMeta: {
        routePolicyKey: String(request.routePolicyKey || '').trim(),
        routeDebugKey: String(request.routeDebugKey || routeMeta.routeDebugKey || '').trim(),
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

  function buildMainConversationSnapshotSignature(state, options = {}) {
    const request = normalizeObject(state.request, {});
    const routeMeta = normalizeObject(request.routeMeta, {});
    const memory = normalizeObject(state.memory, {});
    const execution = normalizeObject(state.execution, {});
    const fingerprintPromptBlocks = (blocks = []) => normalizeArray(blocks).map((item) => ({
      id: String(item?.id || '').trim(),
      lane: String(item?.lane || item?.cacheLane || '').trim(),
      contentHash: stableHash(String(item?.content || '').trim())
    }));
    return stableHash({
      sessionKey: String(request.sessionKey || state.thread?.sessionKey || '').trim(),
      question: String(request.question || '').trim(),
      imageUrl: String(request.imageUrl || '').trim(),
      imageUrls: normalizeArray(request.imageUrls).map((url) => String(url || '').trim()).filter(Boolean),
      routePolicyKey: String(request.routePolicyKey || '').trim(),
      routeDebugKey: String(request.routeDebugKey || routeMeta.routeDebugKey || '').trim(),
      topRouteType: String(request.topRouteType || '').trim(),
      reviewMode: String(request.reviewMode || '').trim(),
      groupId: String(routeMeta.groupId || routeMeta.group_id || '').trim(),
      allowedTools: normalizeArray(options.allowedTools || request.allowedTools),
      source: String(options.source || 'direct_reply').trim() || 'direct_reply',
      memoryCliTurn: execution.memoryCliTurn,
      promptFingerprint: normalizeText(memory.promptSnapshot?.cacheFriendlyFingerprint),
      dynamicPromptHash: stableHash(fingerprintPromptBlocks(memory.dynamicContextBlocks)),
      assistantOnlyHash: stableHash(fingerprintPromptBlocks(memory.assistantOnlyContextBlocks)),
      toolEvidence: String(memory.globalToolEvidence || '').trim()
    });
  }

  function buildPreparedMainConversationContext(state, options = {}) {
    const request = normalizeObject(state.request, {});
    const isReviewRoute = isReviewMode(request.reviewMode);
    const messageContent = request.imageUrl
      ? buildVisionMessageContent(request.question || '', request.imageUrl, request.imageUrls)
      : (request.question || '');
    const baseSystemMessages = getMainConversationSystemMessages(state, { isReviewRoute });
    const directReplyPayload = buildDirectReplyMessages(state, messageContent, baseSystemMessages);
    const mainConversationSnapshot = buildMainConversationContextSnapshot(state, directReplyPayload, {
      affinity: options.affinity || state.memory?.affinity,
      allowedTools: options.allowedTools || request.allowedTools,
      source: String(options.source || 'prepare').trim() || 'prepare',
      plannerArtifactMessages: normalizeArray(options.plannerArtifactMessages)
    });
    return {
      messages: normalizeArray(directReplyPayload.messages),
      assistantOnlyContextMessages: normalizeArray(directReplyPayload.assistantOnlyContextMessages),
      canonicalSegments: directReplyPayload.canonicalSegments || null,
      compactionPlan: directReplyPayload.compactionPlan || null,
      mainConversationSnapshot,
      contextStats: {
        usageRatio: Number(mainConversationSnapshot?.snapshotMeta?.compactionDiagnostics?.usageRatio || 0) || 0,
        compactionLevel: String(mainConversationSnapshot?.snapshotMeta?.compactionDiagnostics?.level || 'normal').trim() || 'normal'
      },
      signature: buildMainConversationSnapshotSignature(state, options)
    };
  }

  function buildLiveMainConversationSnapshot(state, options = {}) {
    const prepared = normalizeObject(state.memory?.preparedMainConversationContext, {});
    const preparedSnapshot = prepared.mainConversationSnapshot && typeof prepared.mainConversationSnapshot === 'object'
      ? prepared.mainConversationSnapshot
      : (state.memory?.mainConversationSnapshot && typeof state.memory.mainConversationSnapshot === 'object'
        ? state.memory.mainConversationSnapshot
        : null);
    const nextSignature = buildMainConversationSnapshotSignature(state, options);
    const preparedSignature = String(prepared.signature || state.memory?.mainConversationSnapshotSignature || '').trim();
    if (preparedSnapshot && preparedSignature && preparedSignature === nextSignature) {
      return preparedSnapshot;
    }
    const request = normalizeObject(state.request, {});
    const isReviewRoute = isReviewMode(request.reviewMode);
    const messageContent = request.imageUrl
      ? buildVisionMessageContent(request.question || '', request.imageUrl, request.imageUrls)
      : (request.question || '');
    const baseSystemMessages = getMainConversationSystemMessages(state, { isReviewRoute });
    const assistantOnlyContextMessages = buildAssistantOnlyContextMessages(state);
    const directReplyPayload = buildDirectReplyMessages(state, messageContent, baseSystemMessages);
    if (assistantOnlyContextMessages.length > 0) {
      directReplyPayload.messages = []
        .concat(normalizeArray(directReplyPayload.messages))
        .concat(assistantOnlyContextMessages);
      directReplyPayload.assistantOnlyContextMessages = assistantOnlyContextMessages;
    }
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

  function shouldRetryWithoutToolsForMarkupOnly({
    assistantMessage = null,
    executedToolEnvelopes = []
  } = {}) {
    const content = String(assistantMessage?.content || '').trim();
    if (!isPureToolCallMarkup(content)) return false;
    return normalizeArray(executedToolEnvelopes).length === 0;
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
    if (failureType === 'provider_quota') {
      return '上游模型额度不足，暂时没法正常回答。';
    }
    if (failureType === 'provider_blocked') {
      return 'request was blocked by upstream safety';
    }
    return '我刚才没有稳定组织出回复。你可以直接再说一次，或者把需求说得更具体一点。';
  }

  function classifyDirectReplyError(error) {
    if (error?.isContextHardBlock) return 'context_overflow';
    const failure = classifyReplyFailure(String(error?.message || error || ''));
    if (failure.type !== 'none') return failure.type;
    const responseText = summarizeDirectReplyError(error);
    const responseFailure = classifyReplyFailure(responseText);
    if (responseFailure.type !== 'none') return responseFailure.type;
    const status = Number(error?.response?.status || 0);
    if (status === 401 || status === 403) return 'provider_auth';
    return 'generic_model_failure';
  }

  function summarizeDirectReplyError(error) {
    if (!error) return '';
    const directMessage = String(error?.message || error || '').replace(/\s+/g, ' ').trim();
    const status = Number(error?.response?.status || 0);
    const responseData = error?.response?.data;
    const responseText = typeof responseData === 'string'
      ? responseData.replace(/\s+/g, ' ').trim()
      : (responseData && typeof responseData === 'object'
        ? JSON.stringify(responseData).replace(/\s+/g, ' ').trim()
        : '');
    const parts = [];
    if (Number.isFinite(status) && status > 0) parts.push(`status=${status}`);
    if (directMessage) parts.push(`message=${directMessage}`);
    if (responseText) parts.push(`response=${responseText.slice(0, 400)}`);
    return parts.join(' | ').slice(0, 800);
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
    executedToolEnvelopes = [],
    options = {}
  ) {
    const telemetry = normalizeObject(options.telemetry);
    const primaryReply = String(assistantMessage?.content || '').trim();
    if (isStableDirectReplyText(primaryReply)) {
      return {
        text: primaryReply,
        source: 'assistant'
      };
    }

    if (shouldRetryWithoutToolsForMarkupOnly({
      assistantMessage,
      executedToolEnvelopes
    })) {
      try {
        const retryMessages = normalizeArray(fallbackMessages).concat([{
          role: 'system',
          content: [
            'Do not emit any <tool_calls> markup or function/tool call JSON.',
            'No tool is available for this turn.',
            'Reply with plain natural language only.'
          ].join(' ')
        }]);
        const retryReply = String(await requestReplyImpl(retryMessages, {
          ...directContext,
          disableTools: true,
          allowedTools: []
        }) || '').trim();
        if (isStableDirectReplyText(retryReply)) {
          return {
            text: retryReply,
            source: 'markup_only_retry'
          };
        }
      } catch (error) {
        if (typeof telemetry.onEvent === 'function') {
          telemetry.onEvent(createEvent('direct_reply_failure', {
            node: 'direct_reply',
            stage: 'markup_only_retry',
            failureType,
            fallbackSource: 'markup_only_retry',
            rawErrorMessage: summarizeDirectReplyError(error)
          }));
        }
      }
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
      } catch (error) {
        if (typeof telemetry.onEvent === 'function') {
          telemetry.onEvent(createEvent('direct_reply_failure', {
            node: 'direct_reply',
            stage: 'tool_result_synthesis',
            failureType,
            fallbackSource: 'tool_result_synthesis',
            rawErrorMessage: summarizeDirectReplyError(error)
          }));
        }
      }
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
    } catch (error) {
      if (typeof telemetry.onEvent === 'function') {
        telemetry.onEvent(createEvent('direct_reply_failure', {
          node: 'direct_reply',
          stage: 'non_stream_fallback',
          failureType,
          fallbackSource: 'non_stream_fallback',
          rawErrorMessage: summarizeDirectReplyError(error)
        }));
      }
    }

    const toolEvidenceFallback = buildDirectToolEvidenceFallback(executedToolEnvelopes);
    if (toolEvidenceFallback) {
      if (typeof telemetry.onEvent === 'function') {
        telemetry.onEvent(createEvent('direct_reply_failure', {
          node: 'direct_reply',
          stage: 'tool_result_fallback',
          failureType,
          fallbackSource: 'tool_result_fallback',
          rawErrorMessage: ''
        }));
      }
      return {
        text: toolEvidenceFallback,
        source: 'tool_result_fallback'
      };
    }

    if (typeof telemetry.onEvent === 'function') {
      telemetry.onEvent(createEvent('direct_reply_failure', {
        node: 'direct_reply',
        stage: 'controlled_failure',
        failureType,
        fallbackSource: 'controlled_failure',
        rawErrorMessage: normalizeText(telemetry.rawErrorMessage || '', 800)
      }));
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
    const requestTrace = normalizeRequestTrace(state?.request?.requestTrace)
      || normalizeRequestTrace(state?.request?.routeMeta?.requestTrace);
    if (threadId) {
      store.appendEvents(threadId, normalized);
    }
    if (requestTrace) {
      for (const event of normalized) {
        appendRequestTraceEvent(nextTracePhase(requestTrace, `runtime_v2_${String(event?.type || 'event').trim() || 'event'}`, {
          tracePhase: `runtime_v2_${String(event?.type || 'event').trim() || 'event'}`,
          stage: String(event?.type || 'runtime_v2_event').trim() || 'runtime_v2_event',
          source: 'runtimeV2',
          node: String(event?.node || state?.thread?.currentNode || '').trim(),
          routePolicyKey: String(state?.request?.routePolicyKey || state?.request?.routeMeta?.routePolicyKey || '').trim(),
          routeDebugKey: String(state?.request?.routeDebugKey || state?.request?.routeMeta?.routeDebugKey || '').trim(),
          topRouteType: String(state?.request?.topRouteType || state?.request?.routeMeta?.topRouteType || '').trim(),
          dispatchBranch: String(state?.request?.dispatchBranch || event?.dispatchBranch || '').trim(),
          triggerBranch: String(event?.triggerBranch || '').trim(),
          durationMs: Number.isFinite(Number(event?.durationMs)) ? Math.max(0, Math.floor(Number(event.durationMs))) : null,
          finalErrorCode: String(event?.finalErrorCode || event?.errorCode || '').trim(),
          error: String(event?.error || event?.rawErrorMessage || '').trim().slice(0, 400)
        }));
      }
    }
    emitEvents(normalized, state?.request || {});
  }

  function withLatencyBreakdown(state, nodeName, meta = {}) {
    const nextState = {
      ...state,
      execution: {
        ...normalizeObject(state.execution, {}),
        latencyBreakdown: {
          ...normalizeObject(state.execution?.latencyBreakdown, {}),
          [String(nodeName || 'unknown').trim() || 'unknown']: {
            ...(normalizeObject(state.execution?.latencyBreakdown?.[nodeName], {})),
            ...normalizeObject(meta, {})
          }
        }
      }
    };
    return nextState;
  }

  function saveAndEmit(state, nodeName, status = 'running', events = []) {
    const nextState = withLatencyBreakdown(state, nodeName, {
      completedAt: nowTs()
    });
    appendRuntimeEvents(nextState, events);
    persistCheckpoint(nextState, nodeName, status);
    return nextState;
  }

  const {
    buildBlockedToolEnvelope,
    buildToolContext,
    canRunStepsInParallel,
    computeToolEnvelope,
    isSideEffectPolicy,
    logToolExecution,
    maybeCaptureToolFailure,
    runToolStep
  } = createToolExecutionHelpers({
    config,
    stableHash,
    summarizeToolLogValue,
    getPolicy,
    enforceToolPolicy,
    shouldRunParallel,
    capabilityRegistry,
    buildLiveMainConversationSnapshot,
    computeEffectiveAllowedTools,
    createMemoryCliTurnState,
    updateMemoryCliTurnStateAfterError,
    updateMemoryCliTurnStateAfterResult,
    decideMemoryCliTurnAction,
    safeParseMemoryCliResult,
    captureToolFailure,
    isPlannerSingleAuthorityEnabled,
    toolExecutors
  });

  const {
    maybeRunAutoContinuityProbe
  } = createContinuityProbeHelpers({
    config,
    createEvent,
    buildContinuityState,
    chatHistory,
    shortTermMemory,
    computeEffectiveAllowedTools,
    classifyRecallFacet,
    runToolStep,
    safeParseMemoryCliResult,
    shouldBiasToContinuity,
    shouldPrioritizeMemoryProbe
  });

  const {
    buildDirectReplyMessages,
    emitWholeReplyAsSingleStream,
    maybeStreamFinalReply,
    streamDirectReply
  } = createStreamingCoordinatorHelpers({
    sanitizeUserFacingText,
    isChatLikeRoute,
    buildVisionMessageContent,
    buildV2CanonicalSegments,
    buildShortTermContextMessages,
    resolveShortTermSessionKey,
    resolveMainConversationModelName,
    requestStreamingReplyImpl,
    finalizeStreamingReplyWithHumanizerImpl,
    isHumanizerEnabledImpl,
    shouldBypassHumanizerForPolicy,
    ensureOutputStream,
    mirrorStreamingFlags,
    requestReplyImpl,
    markStreamCompleted,
    resolveToolLoopReply,
    config,
    chatHistory,
    shortTermMemory
  });

  const {
    cloneDirectToolLoopState,
    runDirectChatToolLoop
  } = createDirectToolLoopHelpers({
    createEvent,
    normalizeMessageForToolLoop,
    requestAssistantMessageImpl,
    buildDirectChatToolStep,
    buildDirectChatExecutionBatches,
    parseToolCallArgs,
    isExcludedDirectChatToolName,
    computeEffectiveAllowedTools,
    createMemoryCliTurnState,
    updateMemoryCliTurnStateAfterError,
    runToolStep,
    computeToolEnvelope,
    getPolicy,
    logToolExecution,
    resolveToolLoopReply
  });

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
    protectFinalOutput,
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
    buildToolEvidenceBundle,
    normalizeExecutionEnvelope,
    synthesizeImpl,
    saveAndEmit
  });

  const humanizeNode = createHumanizeNode({
    normalizeObject,
    createEvent,
    appendRequestTraceEvent,
    normalizeRequestTrace,
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
    compressShortTermHistoryIfNeeded,
    summarizeShortTermChunk,
    getSessionSummaryCooldownStatus,
    saveSessionContextSummary,
    generateSessionContextSummary,
    appendShortTermHistory,
    persistShortTermBridgeSnapshot,
    recordPersonaMemoryOutcome,
    appendMemoryEvent,
    materializeMemoryViews,
    addProfileItem,
    pickRouteMetaForPostReplyJob,
    stableHash,
    postReplyJobQueue,
    appendRequestTraceEvent,
    nextTracePhase,
    normalizeRequestTrace,
    chatHistory,
    shortTermMemory,
    logPostReplyEnqueueError(error) {
      console.error('[post-reply] enqueue failed:', error?.message || error);
    },
    config,
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
    summarizeShortTermChunk,
    buildStructuredCompressionPrompt,
    postWithRetry,
    extractMessageContent,
    isChatLikeRoute,
    persistShortTermBridgeSnapshot,
    appendMemoryEvent,
    materializeMemoryViews,
    maybeRunAutoContinuityProbe,
    buildContinuityState,
    createMemoryCliTurnState,
    computeEffectiveAllowedTools,
    runCapabilityPreflight,
    buildDynamicPromptImpl,
    buildPreparedMainConversationContext,
    classifyPromptThreat,
    getToolPlannerExecutionPlan,
    isPlannerSingleAuthorityEnabled,
    normalizePlanForResume,
    normalizeMode,
    ensureOutputStream,
    buildLatencyDecision,
    withSoftTimeout(taskFactory, timeoutMs, fallbackValue) {
      const budget = Math.max(0, Number(timeoutMs) || 0);
      if (!budget) return Promise.resolve().then(() => taskFactory());
      return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve(typeof fallbackValue === 'function' ? fallbackValue() : fallbackValue);
        }, budget);
        Promise.resolve()
          .then(() => taskFactory())
          .then((value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
          })
          .catch(() => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(typeof fallbackValue === 'function' ? fallbackValue() : fallbackValue);
          });
      });
    },
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
    summarizeDirectReplyError,
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
    buildExecutionBatches,
    buildLiveMainConversationSnapshot,
    computeEffectiveAllowedTools,
    createMemoryCliTurnState,
    persistCheckpoint,
    appendRuntimeEvents,
    updatePlanStepsWithEnvelope,
    getPolicy,
    isSideEffectPolicy,
    runCapabilityPreflight,
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
    normalizeExecutionEnvelope,
    rebuildFinalPlanFromSteps,
    buildExecLogsFromSteps,
    mergeAllowedToolsWithMemoryCli,
    requiresToolEvidence,
    saveAndEmit,
    config
  });

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
        runtimeBinding: Object.prototype.hasOwnProperty.call(envelope, 'runtimeBinding')
          ? (envelope.runtimeBinding === null ? null : normalizeObject(envelope.runtimeBinding, {}))
          : step.runtimeBinding,
        batchId,
        batchIndex
      };
    });
  }

  const graph = new StateGraph(GraphStateV2);
  applyLangGraphV2Topology(graph, {
    end: END,
    nodes: {
      prepare: prepareNodeImpl,
      route: routeNode,
      direct_reply: directReplyNodeImpl,
      planner: plannerNode,
      dispatch: dispatchNodeImpl,
      validate: validateNode,
      repair_or_continue: repairNode,
      draft_reply: draftReplyNode,
      humanize: humanizeNode,
      final_validate: finalValidateNode,
      persist: persistNode
    },
    routers: {
      routeAfterRoute,
      routeAfterDirectReply: routeAfterDirectReplyImpl,
      routeAfterValidate,
      routeAfterRepair,
      routeAfterDraftReply
    }
  });

  const app = graph.compile();

  // Public entry preserves the legacy askAI signature while forcing V2 callers
  // through the compiled graph, checkpoint store, and event stream.
  async function askAIByGraphV2(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
    const requestOptions = {
      ...options,
      streaming: Boolean(!options.disableStream && typeof options.onDelta === 'function')
    };
    const requestTrace = normalizeRequestTrace(requestOptions.requestTrace)
      || normalizeRequestTrace(requestOptions.routeMeta?.requestTrace);
    if (requestTrace && requestOptions.routeMeta && typeof requestOptions.routeMeta === 'object') {
      requestOptions.routeMeta = {
        ...requestOptions.routeMeta,
        requestTrace
      };
    }
    const init = createInitialState(question, userInfo, userId, customPrompt, imageUrl, requestOptions);
    const mcpWarmWaitStartedAt = Date.now();
    if (config.MCP_WARM_BLOCKING && mcpWarmPromise) {
      try {
        await mcpWarmPromise;
      } catch (_) {}
    }
    const mcpWarmWaitMs = Math.max(0, Date.now() - mcpWarmWaitStartedAt);
    init.execution = {
      ...normalizeObject(init.execution, {}),
      latencyBreakdown: {
        ...normalizeObject(init.execution?.latencyBreakdown, {}),
        prepare: {
          ...normalizeObject(init.execution?.latencyBreakdown?.prepare, {}),
          mcp_warm_wait_ms: mcpWarmWaitMs
        }
      }
    };
    const out = await app.invoke(init);
    options.streamHadOutput = Boolean(out?.output?.stream?.hadOutput);
    options.streamCompleted = Boolean(out?.output?.stream?.completed);
    options.streamFallbackToNonStream = Boolean(out?.output?.stream?.fallbackToNonStream);
    options.persistedReplyText = String(out?.output?.persistedReplyText || out?.output?.finalReply || out?.output?.draftReply || '').trim();
    options.displayReplyText = String(out?.output?.displayReply || '').trim();
    const finalReply = sanitizeUserFacingText(out?.output?.displayReply || out?.output?.finalReply || out?.output?.draftReply || '', {
      preserveThink: requestOptions?.cotDisplayOnce === true
    }).trim();
    return finalReply || '刚才网络有点不稳，你再发一次我接着回。';
  }

  async function runPersistInBackgroundFromCheckpoint(threadId = '') {
    const normalizedThreadId = String(threadId || '').trim();
    if (!normalizedThreadId) return null;
    const checkpoint = store.loadCheckpoint(normalizedThreadId);
    const state = checkpoint?.state && typeof checkpoint.state === 'object' ? checkpoint.state : null;
    if (!state) return null;
    return persistNode({
      ...state,
      request: {
        ...(state.request || {}),
        deferPersist: false
      },
      execution: {
        ...(state.execution || {}),
        latencyDecision: {
          ...normalizeObject(state.execution?.latencyDecision, {}),
          deferPersist: false
        }
      }
    });
  }

  return {
    app,
    askAIByGraphV2,
    createInitialState,
    routeMode: routeAfterRoute,
    store,
    runPersistInBackgroundFromCheckpoint,
    mcpWarmPromise
  };
}

let runtimeSingleton = null;

function getRuntime() {
  if (!runtimeSingleton) {
    runtimeSingleton = createRuntime();
  }
  return runtimeSingleton;
}

function resetRuntime() {
  runtimeSingleton = null;
  return getRuntime();
}

async function askAIByGraphV2(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
  return getRuntime().askAIByGraphV2(question, userInfo, userId, customPrompt, imageUrl, options);
}

module.exports = {
  askAIByGraphV2,
  createRuntime,
  createInitialState,
  getRuntime,
  resetRuntime
};
