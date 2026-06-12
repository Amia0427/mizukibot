const {
  applyGroupDirectStyleGuard,
  isGroupDirectChatRequest
} = require('../guards/groupDirectReplyStyleGuard');
const { isUnsafeUserFacingReply } = require('../../../utils/userFacingReplyGuards');
const {
  NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REPLY,
  getNormalUserMainReplyStreamTimeoutReply,
  isNormalUserMainReplyStreamFirstTokenTimeout
} = require('../../../utils/normalUserMainReplyStreamTimeout');
const {
  ADMIN_PRIVATE_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REPLY,
  getAdminPrivateMainReplyStreamTimeoutReply,
  isAdminPrivateMainReplyStreamFirstTokenTimeout
} = require('../../../utils/adminPrivateMainReplyStreamTimeout');
const {
  estimateMessageTokens,
  normalizeMessageContent,
  trimTextByTokenBudget
} = require('../../../utils/contextBudget');
const {
  analyzeMainReplyDegeneration,
  buildMainReplyDegenerationRepairInstruction,
  trimMainReplyDegeneratedTail
} = require('../../../utils/mainReplyDegenerationGuard');

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' ? value : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function extractReplyText(value, preferredKey = 'persisted') {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const visibleText = String(value.visibleText || '').trim();
  const persistedText = String(value.persistedText || '').trim();
  const finalReply = String(value.finalReply || '').trim();
  if (preferredKey === 'visible') {
    return visibleText || persistedText || finalReply;
  }
  return persistedText || visibleText || finalReply;
}

function isHumanizerFirstTokenTimeout(error) {
  return Boolean(
    error?.humanizerFirstTokenTimeout
    || String(error?.code || '').trim() === 'HUMANIZER_FIRST_TOKEN_TIMEOUT'
    || String(error?.reason || '').trim() === 'humanizer_first_token_timeout'
  );
}

const EMPTY_STREAM_FALLBACK_REPLY = '刚才网络有点不稳，你再发一次我接着回。';
const UNSAFE_STREAM_FALLBACK_REPLY = '刚才那句不适合直接发出来。你再叫我一次，我按现在这个语境接回去。';

function getHumanizerFailureReason(error) {
  if (isHumanizerFirstTokenTimeout(error)) return 'humanizer_first_token_timeout';
  return String(error?.code || error?.reason || error?.message || 'humanizer_failed').trim() || 'humanizer_failed';
}

function createStreamingCoordinatorHelpers(deps = {}) {
  const assistantOnlyPrefix = '[Context for assistant only]';
  const {
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
    shortTermMemory,
    createEvent
  } = deps;

  function emitRuntimeEvent(state, type = '', payload = {}) {
    const request = normalizeObject(state.request, {});
    const event = typeof createEvent === 'function'
      ? createEvent(type, payload)
      : { type, ...payload };
    if (typeof request.onEvent === 'function') {
      try { request.onEvent(event); } catch (_) {}
    }
    return event;
  }

  async function emitWholeReplyAsSingleStream(state, finalReply) {
    const request = normalizeObject(state.request, {});
    const guard = applyGroupDirectStyleGuard(finalReply, request);
    const text = sanitizeUserFacingText(guard.text).trim();
    if (!request.streaming || typeof request.onDelta !== 'function' || !text) return text;
    request.onDelta(text, text);
    return text;
  }

  function createHumanizerDeltaForwarder(request, shouldGuardStreamBeforeSend) {
    const state = {
      userVisibleOutput: false,
      fullText: ''
    };
    const forward = (delta, fullText) => {
      const visibleDelta = String(delta || '');
      const visibleFullText = String(fullText || '');
      if (visibleDelta.trim() || visibleFullText.trim()) {
        state.userVisibleOutput = !shouldGuardStreamBeforeSend;
        state.fullText = visibleFullText || state.fullText;
      }
      if (!shouldGuardStreamBeforeSend && typeof request.onDelta === 'function') {
        request.onDelta(delta, fullText);
      }
    };
    return { state, forward };
  }

  function emitHumanizerFallbackEvent(state, error, stage, fallbackSource) {
    const firstTokenTimeout = isHumanizerFirstTokenTimeout(error);
    emitRuntimeEvent(state, firstTokenTimeout ? 'humanizer_first_token_timeout' : 'humanizer_failed_fallback', {
      node: 'direct_reply',
      stage,
      fallbackSource,
      reason: getHumanizerFailureReason(error)
    });
    return firstTokenTimeout;
  }

  async function repairDegeneratedStreamReply(messagesToSend, state, finalReply, stage = 'streaming_final') {
    const request = normalizeObject(state.request, {});
    const trimmedReply = trimMainReplyDegeneratedTail(finalReply);
    const rawAnalysis = analyzeMainReplyDegeneration(finalReply);
    const analysis = analyzeMainReplyDegeneration(trimmedReply || finalReply);
    if (!analysis.degenerated) {
      if (rawAnalysis.degenerated || trimmedReply !== String(finalReply || '').trim()) {
        emitRuntimeEvent(state, 'main_reply_degeneration_detected', {
          node: 'direct_reply',
          stage,
          score: rawAnalysis.score,
          reasons: rawAnalysis.reasons,
          metrics: rawAnalysis.metrics,
          repairAttempted: false,
          tailTrimmed: trimmedReply !== String(finalReply || '').trim()
        });
      }
      return {
        text: trimmedReply || String(finalReply || '').trim(),
        repaired: false,
        repairFailed: false,
        analysis
      };
    }

    emitRuntimeEvent(state, 'main_reply_degeneration_detected', {
      node: 'direct_reply',
      stage,
      score: analysis.score,
      reasons: analysis.reasons,
      metrics: analysis.metrics,
      repairAttempted: true
    });

    let repaired = '';
    try {
      const retryResult = await requestReplyImpl(
        normalizeArray(messagesToSend).concat([{
          role: 'system',
          content: buildMainReplyDegenerationRepairInstruction(analysis)
        }]),
        {
          ...request,
          dispatchBranch: 'direct_reply',
          triggerBranch: `direct_reply.${stage}_degeneration_retry`,
          disableTools: true,
          allowedTools: []
        }
      );
      repaired = sanitizeUserFacingText(extractReplyText(retryResult, 'persisted')).trim();
    } catch (_) {}

    const repairAnalysis = analyzeMainReplyDegeneration(repaired);
    const repairOk = Boolean(repaired) && !repairAnalysis.degenerated && !isUnsafeUserFacingReply(repaired);
    emitRuntimeEvent(state, 'main_reply_degeneration_repair', {
      node: 'direct_reply',
      stage,
      ok: repairOk,
      score: repairAnalysis.score,
      reasons: repairAnalysis.reasons
    });

    return {
      text: repairOk ? repaired : EMPTY_STREAM_FALLBACK_REPLY,
      repaired: repairOk,
      repairFailed: !repairOk,
      analysis: repairOk ? repairAnalysis : analysis
    };
  }

  async function streamDirectReply(messagesToSend, state) {
    const request = normalizeObject(state.request, {});
    const shouldGuardStreamBeforeSend = isGroupDirectChatRequest(request)
      || String(request.routeMeta?.chatType || request.routeMeta?.chat_type || request.chatType || '').trim().toLowerCase() === 'private';
    const useHumanizerStreaming = isHumanizerEnabledImpl() && !shouldBypassHumanizerForPolicy(request.routePolicyKey);
    const upstreamStreamOptions = useHumanizerStreaming
      ? {
          onDelta() {},
          streamHadOutput: false,
          userId: request.userId,
          requestTrace: request.requestTrace || request.routeMeta?.requestTrace,
          routeMeta: normalizeObject(request.routeMeta, {}),
          routeDebugKey: request.routeDebugKey || request.routeMeta?.routeDebugKey,
          routePolicyKey: request.routePolicyKey,
          topRouteType: request.topRouteType,
          dispatchBranch: 'direct_reply',
          triggerBranch: 'direct_reply.streaming_humanizer_upstream'
        }
      : shouldGuardStreamBeforeSend
        ? {
            ...request,
            onDelta() {},
            streamHadOutput: false,
            dispatchBranch: 'direct_reply',
            triggerBranch: 'direct_reply.streaming_guarded_upstream'
          }
      : {
          ...request,
          dispatchBranch: 'direct_reply',
          triggerBranch: 'direct_reply.streaming_upstream'
        };

    try {
      const streamedReply = await requestStreamingReplyImpl(messagesToSend, upstreamStreamOptions, request.modelConfig);
      const originalReply = sanitizeUserFacingText(extractReplyText(streamedReply, 'persisted')).trim();
      if (isUnsafeUserFacingReply(originalReply)) {
        emitRuntimeEvent(state, 'unsafe_reply_blocked', {
          node: 'direct_reply',
          stage: 'streaming_upstream',
          fallbackSource: 'unsafe_stream_reply',
          preview: originalReply.slice(0, 220)
        });
        const safeFallback = UNSAFE_STREAM_FALLBACK_REPLY;
        if (typeof request.onDelta === 'function') {
          request.onDelta(safeFallback, safeFallback);
        }
        return {
          finalReply: safeFallback,
          visibleText: safeFallback,
          persistedText: '',
          unsafeBlocked: true,
          humanizerTimedOut: false,
          humanizerFailed: false,
          humanizerFailureReason: '',
          stream: {
            ...markStreamCompleted(state.output, true),
            ...mirrorStreamingFlags(state.output, safeFallback),
            unsafeBlocked: true,
            fallbackToNonStream: false,
            mode: 'direct'
          }
        };
      }
      let finalReply = originalReply;
      let humanizerTimedOut = false;
      let humanizerFailed = false;
      let humanizerFailureReason = '';
      const humanizerForwarder = createHumanizerDeltaForwarder(request, shouldGuardStreamBeforeSend);
      if (useHumanizerStreaming) {
        try {
          finalReply = await finalizeStreamingReplyWithHumanizerImpl(originalReply, '', {
            question: request.question,
            dynamicPrompt: state.memory?.dynamicPrompt || '',
            modelConfig: request.modelConfig,
            onDelta: humanizerForwarder.forward,
            streamHadOutput: shouldGuardStreamBeforeSend ? false : Boolean(state.output?.stream?.hadOutput),
            routeMeta: normalizeObject(request.routeMeta, {}),
            routePolicyKey: request.routePolicyKey,
            routeDebugKey: request.routeDebugKey || request.routeMeta?.routeDebugKey,
            topRouteType: request.topRouteType,
            dispatchBranch: 'direct_reply',
            triggerBranch: 'direct_reply.streaming_humanizer'
          });
        } catch (error) {
          humanizerFailureReason = getHumanizerFailureReason(error);
          humanizerFailed = true;
          humanizerTimedOut = emitHumanizerFallbackEvent(state, error, 'streaming_humanizer', 'original_streamed_reply');
          finalReply = originalReply;
        }
      }
      const repairedFinal = await repairDegeneratedStreamReply(messagesToSend, state, finalReply, 'streaming_final');
      finalReply = repairedFinal.text;
      const guardedFinalReply = applyGroupDirectStyleGuard(finalReply, request).text;
      const safeFinalReply = sanitizeUserFacingText(guardedFinalReply).trim() || EMPTY_STREAM_FALLBACK_REPLY;
      if (isUnsafeUserFacingReply(safeFinalReply)) {
        emitRuntimeEvent(state, 'unsafe_reply_blocked', {
          node: 'direct_reply',
          stage: 'streaming_final',
          fallbackSource: 'unsafe_stream_final',
          preview: safeFinalReply.slice(0, 220)
        });
        const safeFallback = UNSAFE_STREAM_FALLBACK_REPLY;
        if (typeof request.onDelta === 'function') {
          request.onDelta(safeFallback, safeFallback);
        }
        return {
          finalReply: safeFallback,
          visibleText: safeFallback,
          persistedText: '',
          unsafeBlocked: true,
          humanizerTimedOut,
          humanizerFailed,
          humanizerFailureReason,
          stream: {
            ...markStreamCompleted(state.output, true),
            ...mirrorStreamingFlags(state.output, safeFallback),
            humanizerTimedOut,
            humanizerFailed,
            humanizerFailureReason,
            degenerationRepaired: repairedFinal.repaired,
            degenerationRepairFailed: repairedFinal.repairFailed,
            unsafeBlocked: true,
            fallbackToNonStream: false,
            mode: 'direct'
          }
        };
      }
      const shouldEmitFinalOnce = (
        shouldGuardStreamBeforeSend
        || humanizerTimedOut
        || (useHumanizerStreaming && !humanizerForwarder.state.userVisibleOutput)
      );
      if (shouldEmitFinalOnce && typeof request.onDelta === 'function' && safeFinalReply) {
        request.onDelta(safeFinalReply, safeFinalReply);
      }
      return {
        finalReply: safeFinalReply,
        humanizerTimedOut,
        humanizerFailed,
        humanizerFailureReason,
        stream: {
          ...markStreamCompleted(state.output, true),
          ...mirrorStreamingFlags(state.output, safeFinalReply),
          humanizerTimedOut,
          humanizerFailed,
          humanizerFailureReason,
          degenerationRepaired: repairedFinal.repaired,
          degenerationRepairFailed: repairedFinal.repairFailed,
          fallbackToNonStream: false,
          mode: 'direct'
        }
      };
    } catch (error) {
      if (isNormalUserMainReplyStreamFirstTokenTimeout(error)) {
        const safeFinalReply = sanitizeUserFacingText(
          getNormalUserMainReplyStreamTimeoutReply(error)
        ).trim() || NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REPLY;
        emitRuntimeEvent(state, 'normal_user_stream_first_token_timeout', {
          node: 'direct_reply',
          stage: 'streaming_upstream',
          fallbackSource: 'normal_user_stream_first_token_timeout',
          timeoutMs: Number(error?.timeoutMs || 0) || 0
        });
        if (typeof request.onDelta === 'function') {
          request.onDelta(safeFinalReply, safeFinalReply);
        }
        return {
          finalReply: safeFinalReply,
          visibleText: safeFinalReply,
          persistedText: safeFinalReply,
          normalUserStreamFirstTokenTimedOut: true,
          humanizerTimedOut: false,
          humanizerFailed: false,
          humanizerFailureReason: '',
          stream: {
            ...markStreamCompleted(state.output, true),
            ...mirrorStreamingFlags(state.output, safeFinalReply),
            normalUserStreamFirstTokenTimedOut: true,
            fallbackToNonStream: false,
            mode: 'direct'
          }
        };
      }
      if (isAdminPrivateMainReplyStreamFirstTokenTimeout(error)) {
        const safeFinalReply = sanitizeUserFacingText(
          getAdminPrivateMainReplyStreamTimeoutReply(error)
        ).trim() || ADMIN_PRIVATE_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REPLY;
        emitRuntimeEvent(state, 'admin_private_stream_first_token_timeout', {
          node: 'direct_reply',
          stage: 'streaming_upstream',
          fallbackSource: 'admin_private_stream_first_token_timeout',
          timeoutMs: Number(error?.timeoutMs || 0) || 0
        });
        if (typeof request.onDelta === 'function') {
          request.onDelta(safeFinalReply, safeFinalReply);
        }
        return {
          finalReply: safeFinalReply,
          visibleText: safeFinalReply,
          persistedText: safeFinalReply,
          adminPrivateStreamFirstTokenTimedOut: true,
          humanizerTimedOut: false,
          humanizerFailed: false,
          humanizerFailureReason: '',
          stream: {
            ...markStreamCompleted(state.output, true),
            ...mirrorStreamingFlags(state.output, safeFinalReply),
            adminPrivateStreamFirstTokenTimedOut: true,
            fallbackToNonStream: false,
            mode: 'direct'
          }
        };
      }
      if (String(error?.partialText || '').trim()) {
        const originalPartialReply = sanitizeUserFacingText(error.partialText).trim();
        let finalReply = originalPartialReply;
        let humanizerTimedOut = false;
        let humanizerFailed = false;
        let humanizerFailureReason = '';
        const humanizerForwarder = createHumanizerDeltaForwarder(request, shouldGuardStreamBeforeSend);
        if (useHumanizerStreaming) {
          try {
            finalReply = await finalizeStreamingReplyWithHumanizerImpl(originalPartialReply, '', {
              question: request.question,
              dynamicPrompt: state.memory?.dynamicPrompt || '',
              modelConfig: request.modelConfig,
              onDelta: humanizerForwarder.forward,
              streamHadOutput: shouldGuardStreamBeforeSend ? false : Boolean(state.output?.stream?.hadOutput),
              routeMeta: normalizeObject(request.routeMeta, {}),
              routePolicyKey: request.routePolicyKey,
              routeDebugKey: request.routeDebugKey || request.routeMeta?.routeDebugKey,
              topRouteType: request.topRouteType,
              dispatchBranch: 'direct_reply',
              triggerBranch: 'direct_reply.streaming_partial_humanizer'
            });
          } catch (humanizerError) {
            humanizerFailureReason = getHumanizerFailureReason(humanizerError);
            humanizerFailed = true;
            humanizerTimedOut = emitHumanizerFallbackEvent(state, humanizerError, 'streaming_partial_humanizer', 'original_partial_reply');
            finalReply = originalPartialReply;
          }
        }
        const repairedFinal = await repairDegeneratedStreamReply(messagesToSend, state, finalReply, 'streaming_partial');
        finalReply = repairedFinal.text;
        const guardedFinalReply = applyGroupDirectStyleGuard(finalReply, request).text;
        const safeFinalReply = sanitizeUserFacingText(guardedFinalReply).trim() || EMPTY_STREAM_FALLBACK_REPLY;
        if (isUnsafeUserFacingReply(safeFinalReply)) {
          emitRuntimeEvent(state, 'unsafe_reply_blocked', {
            node: 'direct_reply',
            stage: 'streaming_partial',
            fallbackSource: 'unsafe_stream_partial',
            preview: safeFinalReply.slice(0, 220)
          });
          const safeFallback = UNSAFE_STREAM_FALLBACK_REPLY;
          if (typeof request.onDelta === 'function') {
            request.onDelta(safeFallback, safeFallback);
          }
          return {
            finalReply: safeFallback,
            visibleText: safeFallback,
            persistedText: '',
            unsafeBlocked: true,
            humanizerTimedOut,
            humanizerFailed,
            humanizerFailureReason,
            stream: {
              ...markStreamCompleted(state.output, true),
              ...mirrorStreamingFlags(state.output, safeFallback),
              humanizerTimedOut,
              humanizerFailed,
              humanizerFailureReason,
              degenerationRepaired: repairedFinal.repaired,
              degenerationRepairFailed: repairedFinal.repairFailed,
              unsafeBlocked: true,
              fallbackToNonStream: false,
              mode: 'direct'
            }
          };
        }
        const shouldEmitFinalOnce = (
          shouldGuardStreamBeforeSend
          || humanizerTimedOut
          || (useHumanizerStreaming && !humanizerForwarder.state.userVisibleOutput)
        );
        if (shouldEmitFinalOnce && typeof request.onDelta === 'function' && safeFinalReply) {
          request.onDelta(safeFinalReply, safeFinalReply);
        }
        return {
          finalReply: safeFinalReply,
          humanizerTimedOut,
          humanizerFailed,
          humanizerFailureReason,
          stream: {
            ...markStreamCompleted(state.output, true),
            ...mirrorStreamingFlags(state.output, safeFinalReply),
            humanizerTimedOut,
            humanizerFailed,
            humanizerFailureReason,
            degenerationRepaired: repairedFinal.repaired,
            degenerationRepairFailed: repairedFinal.repairFailed,
            fallbackToNonStream: false,
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

  function isVisionLiteContextRequest(request = {}) {
    const routeMeta = normalizeObject(request.routeMeta, {});
    const routePolicyKey = String(request.routePolicyKey || routeMeta.routePolicyKey || '').trim().toLowerCase();
    const chatMode = String(routeMeta.chatMode || routeMeta.chat_mode || '').trim().toLowerCase();
    return Boolean(
      request.imageUrl
      || normalizeArray(request.imageUrls).length > 0
      || routePolicyKey === 'transform/vision-summary'
      || routePolicyKey === 'lookup/vision-answer'
      || chatMode === 'image_summary'
      || chatMode === 'image_qa'
    );
  }

  function shouldDropVisionSystemContext(message = {}) {
    const text = normalizeMessageContent(message.content);
    if (!text) return true;
    return /\[(?:RecentRawTurns|RetrievedMemoryLite|RetrievedMemory|DailyJournal|TaskMemory|GroupMemory|StyleSignals|ShortTermContinuity|MemOSRecall|OpenVikingRecall|LongTermProfile|Impression|Summary|ContinuityState|GlobalToolEvidence)\]|引用消息|quoted message|reply_quote|quoteAnchored|quote raw|raw quote/i
      .test(text);
  }

  function buildVisionLiteSystemMessages(messages = []) {
    const budget = Math.max(512, Number(config?.VISION_ROUTE_SYSTEM_CONTEXT_MAX_TOKENS || 10000) || 10000);
    const kept = normalizeArray(messages)
      .filter((item) => item && typeof item === 'object')
      .filter((item) => !shouldDropVisionSystemContext(item));
    const out = [];
    let used = 0;
    for (const message of kept) {
      const cost = estimateMessageTokens(message);
      if (used + cost <= budget) {
        out.push(message);
        used += cost;
        continue;
      }
      const remaining = Math.max(0, budget - used - 6);
      if (remaining >= 64) {
        out.push({
          ...message,
          content: trimTextByTokenBudget(normalizeMessageContent(message.content), remaining, 'head')
        });
      }
      break;
    }
    return out;
  }

  function buildVisionLiteUserMessageContent(request = {}, messageContent = '') {
    if (Array.isArray(messageContent)) return messageContent;
    const routeMeta = normalizeObject(request.routeMeta, {});
    const visualContext = normalizeObject(request.visualContext || routeMeta.visualContext, {});
    const imageCount = Math.max(
      1,
      normalizeArray(request.imageUrls || routeMeta.imageUrls).length,
      Number(visualContext?.worker?.imageCount || 0) || 0,
      normalizeArray(visualContext?.images).length
    );
    if (typeof buildVisionLiteTextContent === 'function') {
      return [{
        type: 'text',
        text: buildVisionLiteTextContent(messageContent, imageCount)
      }];
    }
    const budget = Math.max(256, Number(config?.VISION_ROUTE_USER_TEXT_MAX_TOKENS || 6000) || 6000);
    return [{
      type: 'text',
      text: trimTextByTokenBudget(normalizeMessageContent(messageContent), budget, 'tail')
    }];
  }

  function buildDirectReplyMessages(state, messageContent, systemMessages = []) {
    const request = normalizeObject(state.request, {});
    const baseMessages = normalizeArray(systemMessages)
      .filter((item) => item && typeof item === 'object');
    const assistantOnlyContextMessages = normalizeArray(state.memory?.assistantOnlyContextBlocks)
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        role: 'assistant',
        content: `${assistantOnlyPrefix}\n${String(item.content || '').trim()}`
      }))
      .filter((item) => String(item.content || '').trim() !== assistantOnlyPrefix);
    const continuityStateMessages = baseMessages.filter((item) => String(item?.content || '').includes('[ContinuityState]'));
    const globalToolEvidenceMessages = baseMessages.filter((item) => String(item?.content || '').includes('[GlobalToolEvidence]'));
    const pureSystemMessages = baseMessages.filter((item) => !globalToolEvidenceMessages.includes(item) && !continuityStateMessages.includes(item));
    const userTurnMessages = [{ role: 'user', content: messageContent }];
    const appendAssistantOnlyBeforeUserTurn = (messages = []) => {
      const base = normalizeArray(messages);
      if (assistantOnlyContextMessages.length === 0) return base;
      let lastUserIndex = -1;
      for (let index = base.length - 1; index >= 0; index -= 1) {
        if (String(base[index]?.role || '').trim().toLowerCase() === 'user') {
          lastUserIndex = index;
          break;
        }
      }
      if (lastUserIndex >= 0) {
        return [
          ...base.slice(0, lastUserIndex),
          ...assistantOnlyContextMessages,
          ...base.slice(lastUserIndex)
        ];
      }
      return [
        ...assistantOnlyContextMessages,
        ...base
      ];
    };

    if (isVisionLiteContextRequest(request)) {
      const maxOutputTokens = Number(request.modelConfig?.maxTokens || config.AI_MAX_TOKENS || config.MAIN_REPLY_DEFAULT_MAX_TOKENS || 8192);
      const inputHardLimit = Math.max(2048, Number(config.IMAGE_MODEL_INPUT_TOKEN_HARD_LIMIT || 20000) || 20000);
      const visionSystemMessages = buildVisionLiteSystemMessages(pureSystemMessages);
      const visionUserTurnMessages = [{
        role: 'user',
        content: buildVisionLiteUserMessageContent(request, messageContent)
      }];
      const canonical = buildV2CanonicalSegments(state, {
        systemPromptMessages: visionSystemMessages,
        continuityMessages: [],
        shortTermSummaryMessages: [],
        recentHistoryMessages: [],
        assistantOnlyContextMessages: [],
        userTurnMessages: visionUserTurnMessages,
        toolEvidenceMessages: [],
        modelName: resolveMainConversationModelName(request),
        modelWindowTokens: inputHardLimit + Math.max(64, maxOutputTokens || 8192),
        maxOutputTokens,
        source: 'direct_reply_vision_lite',
        disableMemoryContextSegments: true
      });
      return {
        messages: canonical.compactionPlan.compactedSegments.flatMap((segment) => segment.messages),
        systemMessages: visionSystemMessages,
        continuityStateMessages: [],
        summaryMessages: [],
        recentHistory: [],
        assistantOnlyContextMessages: [],
        userTurnMessages: visionUserTurnMessages,
        globalToolEvidenceMessages: [],
        compactionPlan: canonical.compactionPlan,
        canonicalSegments: canonical.segments,
        disableMemoryContextSegments: true,
        contextBudgetMode: 'vision_lite'
      };
    }

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
        messages: appendAssistantOnlyBeforeUserTurn(canonical.compactionPlan.compactedSegments.flatMap((segment) => segment.messages)),
        systemMessages: pureSystemMessages,
        continuityStateMessages,
        summaryMessages: [],
        recentHistory: [],
        assistantOnlyContextMessages,
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
      maxOutputTokens: Number(request.modelConfig?.maxTokens || config.AI_MAX_TOKENS || config.MAIN_REPLY_DEFAULT_MAX_TOKENS || 8192),
      source: 'direct_reply'
    });
    const trimmedRecentHistory = normalizeArray(
      canonical.compactionPlan.compactedSegments.find((segment) => segment.name === 'recent_history')?.messages
    );
    return {
      messages: appendAssistantOnlyBeforeUserTurn(canonical.compactionPlan.compactedSegments.flatMap((segment) => segment.messages)),
      systemMessages: pureSystemMessages,
      continuityStateMessages,
      summaryMessages: sessionSummaryMessages.concat(summaryMessages),
      recentHistory: trimmedRecentHistory,
      assistantOnlyContextMessages,
      userTurnMessages,
      globalToolEvidenceMessages,
      compactionPlan: canonical.compactionPlan,
      canonicalSegments: canonical.segments
    };
  }

  async function resolveToolLoopReplyWithFallback(assistantMessage, fallbackMessages, directContext, failureType, executedToolEnvelopes) {
    const result = await resolveToolLoopReply(assistantMessage, fallbackMessages, directContext, failureType, executedToolEnvelopes);
    return result;
  }

  return {
    buildDirectReplyMessages,
    emitWholeReplyAsSingleStream,
    maybeStreamFinalReply,
    resolveToolLoopReplyWithFallback,
    streamDirectReply
  };
}

module.exports = {
  createStreamingCoordinatorHelpers,
  isHumanizerFirstTokenTimeout
};
