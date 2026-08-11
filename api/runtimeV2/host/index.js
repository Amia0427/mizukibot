// Primary LangGraph runtime host. New routing, recovery, eventing, and persist
// behavior belongs here or in the neutral helper modules it composes.
const { StateGraph, END } = require('@langchain/langgraph');
const config = require('../../../config');
const { applyLangGraphV2Topology } = require('../topology');
const {
  buildDynamicPrompt,
  buildVisionMessageContent,
  buildVisionLiteTextContent,
  shouldExposeMemoryCli,
  shouldBypassHumanizerForPolicy
} = require('../context/service');
const { sanitizeUserFacingText } = require('../../../utils/userFacingText');
const {
  requestStreamingReply,
  finalizeStreamingReplyWithHumanizer,
  requestNonStreamingReply,
  requestAssistantMessage
} = require('../model/service');
const { normalizeText } = require('../contracts');
const {
  GraphStateV2,
  snapshotState
} = require('../state');
const {
  buildDirectChatToolStep,
  isExcludedDirectChatToolName,
  isDirectChatRuntimeDependentStep
} = require('../services/directChat');
const {
  createRouteAfterRoute,
  createRouteNode
} = require('../nodes/route');
const {
  createAgentDecideNode,
  createRouteAfterAgentDecide
} = require('../nodes/agentDecide');
const {
  createExecuteToolsNode
} = require('../nodes/executeTools');
const {
  createFinalValidateNode
} = require('../nodes/finalValidate');
const {
  createHumanizeNode
} = require('../nodes/humanize');
const {
  createPrepareNode
} = require('../nodes/prepare');
const {
  createEnhanceLiveStateNode
} = require('../nodes/enhanceLiveState');
const {
  createPersistNode
} = require('../nodes/persist');
const {
  getCapabilityExecutors,
  shouldRunParallel
} = require('../capabilities/scheduler');
const { normalizeToolNames } = require('../../../utils/localToolAccess');
const {
  getPolicy,
  hasPublicToolPolicy,
  resolveToolPolicy,
  enforceToolPolicy
} = require('../../../utils/toolPolicy');
const { getDynamicToolNames } = require('../../toolRegistry');
const { appendDailyJournalEntry } = require('../../../utils/dailyJournal');
const { runHumanizerAgent, isHumanizerAgentEnabled } = require('../../humanizerAgent');
const {
  chatHistory,
  shortTermMemory,
  addProfileItem
} = require('../../../utils/memory');
const {
  compressShortTermHistoryIfNeeded,
  buildShortTermContextMessages,
  appendShortTermHistory,
  rehydrateShortTermMemoryAfterRestartIfNeeded,
  resolveShortTermSessionKey,
  resolveShortTermScope,
  buildStructuredCompressionPrompt
} = require('../../../utils/shortTermMemory');
const { withSessionContextBatch } = require('../../../utils/shortTermSessionStore');
const {
  estimateMessagesTokens,
  trimMessagesByTokenBudget
} = require('../../../utils/contextBudget');
const { resolveModelTokenLimit } = require('../../../utils/contextInspector');
const { buildContextCompactionPlan } = require('../../../utils/contextCompaction');
const {
  restoreShortTermBridgeAfterRestartIfNeeded,
  persistShortTermBridgeSnapshot
} = require('../../../utils/shortTermBridgeMemory');
const { recordMemoryScope } = require('../../../utils/memoryScopeIndex');
const { learnSomethingNew } = require('../../memoryExtraction');
const { postWithRetry } = require('../../httpClient');
const { extractMessageContent } = require('../../parser');
const { isReplyFailure, classifyReplyFailure } = require('../../../utils/replyFailure');
const {
  captureToolFailure,
  learnSelfImprovement
} = require('../../../utils/selfImprovementRuntime');
const { createCheckpointStore } = require('../../../utils/langgraphV2Store');
const { createRuntimePersistence } = require('./persistence');
const { getPostReplyJobQueue } = require('../../../utils/postReplyJobQueue');
const {
  createMemoryCliTurnState,
  decideMemoryCliTurnAction,
  filterAllowedToolsForMemoryCliTurn,
  safeParseMemoryCliResult,
  updateMemoryCliTurnStateAfterError,
  updateMemoryCliTurnStateAfterResult
} = require('../../../utils/memoryCliTurnPolicy');
const {
  classifyRecallFacet,
  shouldBiasToContinuity,
  shouldPrioritizeMemoryProbe
} = require('../../../utils/recallHeuristics');
const { buildContinuityState } = require('../../../utils/continuityState');
const {
  getSessionSummaryCooldownStatus,
  saveSessionContextSummary
} = require('../../../utils/sessionContextSummaryStore');
const {
  generateSessionContextSummary
} = require('../../../utils/sessionContextSummaryRuntime');
const { createConversationContextHelpers } = require('../runtime/conversationContext');
const { createContinuityProbeHelpers } = require('../runtime/continuityProbe');
const { createEvent, emitEvents, pickRouteMetaForPostReplyJob, stableHash, summarizeToolLogValue } = require('../runtime/events');
const {
  appendRequestTraceEvent,
  nextTracePhase,
  normalizeRequestTrace
} = require('../../../utils/requestTrace');
const { createStreamingCoordinatorHelpers } = require('../runtime/streamingCoordinator');
const { createToolExecutionHelpers } = require('../runtime/toolExecution');
const { buildSecuritySystemPrompt, classifyPromptThreat, protectFinalOutput } = require('../../../utils/promptSecurity');
const {
  nowTs,
  normalizeObject,
  normalizeArray,
  buildLatencyDecision,
  buildContinuitySnapshotPayload,
  buildV2CanonicalSegments: buildV2CanonicalSegmentsWithDeps
} = require('./runtimeHelpers');
const {
  appendMemoryEvent,
  materializeMemoryViews,
  recordPersonaMemoryOutcome,
  warmMcpRegistry,
  summarizeShortTermChunk
} = require('./memoryHooks');
const {
  isReviewMode,
  isChatLikeRoute,
  shouldQueueMemoryLearningForV2,
  shouldAppendDailyJournalForV2
} = require('./routePredicates');
const {
  isSideEffectPolicy,
  createInitialState,
  normalizeMode
} = require('./requestState');

function buildV2CanonicalSegments(state, input = {}) {
  return buildV2CanonicalSegmentsWithDeps(state, input, {
    resolveModelTokenLimit,
    buildContextCompactionPlan
  });
}

function cloneStatusBarContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');
  return content.map((part) => {
    if (typeof part === 'string') return part;
    return part && typeof part === 'object' ? { ...part } : String(part || '');
  });
}

function captureStatusBarContext(out = {}, options = {}) {
  const memory = normalizeObject(out.memory, {});
  const prepared = normalizeObject(memory.preparedMainConversationContext, {});
  options.statusBarSystemMessages = normalizeArray(prepared.messages)
    .filter((message) => message && (message.role === 'system' || message.role === 'developer'))
    .map((message) => ({
      role: message.role,
      content: cloneStatusBarContent(message.content)
    }))
    .filter((message) => String(message.content || '').trim() || Array.isArray(message.content));
  const snapshot = normalizeObject(memory.affinity?.variableSnapshot, null);
  options.statusBarVariableSnapshot = snapshot
    ? {
      ...snapshot,
        relationship: { ...normalizeObject(snapshot.relationship, {}) },
        character: { ...normalizeObject(snapshot.character, {}) }
      }
    : null;
}

function applyRuntimeReplyOutput(out = {}, options = {}, sanitize = sanitizeUserFacingText) {
  const output = normalizeObject(out.output, {});
  const stream = normalizeObject(output.stream, {});
  options.streamHadOutput = Boolean(stream.hadOutput);
  options.streamCompleted = Boolean(stream.completed);
  options.streamFallbackToNonStream = Boolean(stream.fallbackToNonStream);
  options.persistedReplyText = String(output.persistedReplyText || output.finalReply || output.draftReply || '').trim();
  options.displayReplyText = String(output.displayReply || '').trim();
  options.reasoningText = String(output.reasoningText || '').trim();
  options.reasoningForwardText = String(output.reasoningForwardText || '').trim();
  captureStatusBarContext(out, options);

  const rawReply = output.displayReply || output.finalReply || output.draftReply || '';
  const sanitized = sanitize(rawReply, { returnMeta: true });
  const finalReply = String(typeof sanitized === 'object' ? sanitized.text : sanitized).trim();
  const pendingAuthorizations = [];
  const seenTicketIds = new Set();
  const addPendingAuthorization = (envelope = {}) => {
    if (String(envelope.status || '').trim() !== 'confirmation_required') return;
    const authorization = normalizeObject(envelope.authorization, null);
    const ticketId = String(authorization?.ticketId || '').trim();
    if (!ticketId || seenTicketIds.has(ticketId)) return;
    seenTicketIds.add(ticketId);
    pendingAuthorizations.push({ ...authorization });
  };
  normalizeArray(out.execution?.toolResults).forEach(addPendingAuthorization);
  normalizeArray(out.plan?.steps).forEach((step) => {
    normalizeArray(step?.evidence).forEach(addPendingAuthorization);
  });
  options.pendingToolAuthorizations = pendingAuthorizations;
  options.hasSafetyRestriction = Boolean(
    output.hasSafetyRestriction === true
    || (typeof sanitized === 'object' && sanitized.hasSafetyRestriction === true)
  );
  const replyText = finalReply || '刚才网络有点不稳，你再发一次我接着回。';
  if (pendingAuthorizations.length === 0) return replyText;
  const commands = pendingAuthorizations.map((authorization) => [
    `确认执行：/tool-confirm ${authorization.ticketId}`,
    `取消执行：/tool-cancel ${authorization.ticketId}`
  ].join('\n'));
  return `${replyText}\n\n${commands.join('\n\n')}`;
}

function createRuntime(options = {}) {
  const store = createCheckpointStore(options.storeOptions || {});
  const persistNodeFactory = options.createPersistNodeOverride || createPersistNode;
  const runtimeOptions = normalizeObject(options, {});
  const capabilityRuntime = getCapabilityExecutors(runtimeOptions);
  const capabilityRegistry = capabilityRuntime.registry;
  const toolExecutors = normalizeObject(capabilityRuntime.executors, {});
  const buildDynamicPromptImpl = runtimeOptions.buildDynamicPrompt || buildDynamicPrompt;
  const requestReplyImpl = runtimeOptions.requestNonStreamingReply || requestNonStreamingReply;
  const requestStreamingReplyImpl = runtimeOptions.requestStreamingReply || requestStreamingReply;
  const requestAssistantMessageImpl = runtimeOptions.requestAssistantMessage || requestAssistantMessage;
  const finalizeStreamingReplyWithHumanizerImpl = runtimeOptions.finalizeStreamingReplyWithHumanizer || finalizeStreamingReplyWithHumanizer;
  const runHumanizerImpl = runtimeOptions.runHumanizerAgent || runHumanizerAgent;
  const isHumanizerEnabledImpl = runtimeOptions.isHumanizerAgentEnabled || isHumanizerAgentEnabled;
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
    resolveMainConversationTokenLimit
  } = createConversationContextHelpers({
    config,
    normalizeToolNames,
    filterAllowedToolsForMemoryCliTurn,
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
      disableMemoryContextSegments: segmentedMessages.disableMemoryContextSegments === true || options.disableMemoryContextSegments === true,
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
    });
    return {
      messages: normalizeArray(directReplyPayload.messages),
      assistantOnlyContextMessages: normalizeArray(directReplyPayload.assistantOnlyContextMessages),
      canonicalSegments: directReplyPayload.canonicalSegments || null,
      compactionPlan: directReplyPayload.compactionPlan || null,
      disableMemoryContextSegments: directReplyPayload.disableMemoryContextSegments === true,
      contextBudgetMode: String(directReplyPayload.contextBudgetMode || '').trim(),
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
      content: message?.content,
      reasoningText: String(message?.reasoningText || '').trim()
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
      return '记忆那边刚刚绕住了。你把想找的点再捏具体一点，我接着翻。';
    }
    if (failureType === 'tool_error') {
      return '刚刚翻记忆没翻稳。换个更具体的关键词问我，我再捞一次。';
    }
    if (failureType === 'post_tool_empty_reply') {
      return '翻完以后那句空掉了。你把要问的点再收窄一点，我重新接。';
    }
    if (failureType === 'context_overflow') {
      return '上下文塞得太满啦。你从最近那一步接着问，或者把范围缩小一点。';
    }
    if (failureType === 'provider_auth') {
      return '这边配置像是没扣好，先检查一下模型钥匙吧。';
    }
    if (failureType === 'provider_quota') {
      return '模型额度好像见底了。先换个模型或者补一下额度，我再继续。';
    }
    if (failureType === 'provider_blocked') {
      return '刚刚那句被卡掉了。你换个更短更明确的说法，我马上接。';
    }
    return '刚刚那句没组织稳。你再发一次，我继续接。';
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

  function normalizeToolEvidenceSnippet(text = '', maxChars = 480) {
    const compact = String(text || '').replace(/\s+/g, ' ').trim();
    if (!compact) return '';
    return compact.slice(0, Math.max(80, Number(maxChars) || 480));
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
            'Ignore the previous structured tool-call markup.',
            'Reply to the user in plain natural language.',
            'Do not mention tools, tool availability, or internal routing.'
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
  const {
    appendRuntimeEvents,
    saveTransition
  } = createRuntimePersistence({
    appendRequestTraceEvent,
    emitEvents,
    nextTracePhase,
    normalizeRequestTrace,
    nowTs,
    snapshotState,
    store
  });

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
    saveTransition(nextState, nodeName, status, events);
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
    resolveToolPolicy,
    hasPublicToolPolicy,
    isDynamicToolRegistered(toolName) {
      return getDynamicToolNames().includes(String(toolName || '').trim());
    },
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
    buildVisionLiteTextContent,
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

  const routeNode = createRouteNode({
    createEvent,
    normalizeMode,
    saveAndEmit
  });

  const routeAfterRoute = createRouteAfterRoute({
    normalizeMode
  });

  const finalValidateNode = createFinalValidateNode({
    createEvent,
    isReplyFailure,
    classifyReplyFailure,
    protectFinalOutput,
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

  const persistNode = persistNodeFactory({
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
    withSessionContextBatch,
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
    buildDynamicPromptImpl,
    buildPreparedMainConversationContext,
    classifyPromptThreat,
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

  const enhanceLiveStateNodeImpl = createEnhanceLiveStateNode({
    createEvent,
    saveAndEmit
  });

  const agentDecideNodeImpl = createAgentDecideNode({
    createEvent,
    saveAndEmit,
    normalizeMessageForToolLoop,
    buildVisionMessageContent,
    getMainConversationSystemMessages,
    buildDirectReplyMessages,
    isReviewMode,
    streamDirectReply,
    requestReplyImpl,
    requestAssistantMessageImpl,
    resolveToolLoopReply,
    isPureToolCallMarkup,
    ensureOutputStream,
    classifyDirectReplyError,
    summarizeDirectReplyError,
    getControlledFailureReply,
    getMaxToolRounds() {
      return Math.max(1, Math.min(3, Number(config.AGENT_MAX_ROUNDS) || 3));
    },
    getMaxToolCalls() {
      return Math.max(1, Math.min(4, Number(config.DIRECT_TOOL_MAX_CALLS_PER_TURN) || 4));
    }
  });

  const executeToolsNodeImpl = createExecuteToolsNode({
    createEvent,
    saveAndEmit,
    saveTransition,
    buildDirectChatToolStep,
    isExcludedDirectChatToolName,
    isDirectChatRuntimeDependentStep,
    canRunStepsInParallel,
    getPolicy,
    isSideEffectPolicy,
    runToolStep
  });

  const routeAfterAgentDecide = createRouteAfterAgentDecide();

  const graph = new StateGraph(GraphStateV2);
  applyLangGraphV2Topology(graph, {
    end: END,
    nodes: {
      prepare: prepareNodeImpl,
      enhance_live_state: enhanceLiveStateNodeImpl,
      route: routeNode,
      agent_decide: agentDecideNodeImpl,
      execute_tools: executeToolsNodeImpl,
      humanize: humanizeNode,
      final_validate: finalValidateNode,
      persist: persistNode
    },
    routers: {
      routeAfterRoute,
      routeAfterAgentDecide
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
    return applyRuntimeReplyOutput(out, options);
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
  if (runtimeSingleton) runtimeSingleton.store.close();
  runtimeSingleton = null;
  return getRuntime();
}

async function askAIByGraphV2(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
  return getRuntime().askAIByGraphV2(question, userInfo, userId, customPrompt, imageUrl, options);
}

module.exports = {
  applyRuntimeReplyOutput,
  askAIByGraphV2,
  createRuntime,
  createInitialState,
  getRuntime,
  resetRuntime
};
