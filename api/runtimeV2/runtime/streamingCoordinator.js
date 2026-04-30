const {
  applyGroupDirectStyleGuard,
  isGroupDirectChatRequest
} = require('../guards/groupDirectReplyStyleGuard');

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

function createStreamingCoordinatorHelpers(deps = {}) {
  const assistantOnlyPrefix = '[Context for assistant only]';
  const {
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

  async function streamDirectReply(messagesToSend, state) {
    const request = normalizeObject(state.request, {});
    const shouldGuardStreamBeforeSend = isGroupDirectChatRequest(request);
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
      let finalReply = originalReply;
      let humanizerTimedOut = false;
      if (useHumanizerStreaming) {
        try {
          finalReply = await finalizeStreamingReplyWithHumanizerImpl(streamedReply, 'The network was unstable just now. Please try again.', {
            question: request.question,
            dynamicPrompt: state.memory?.dynamicPrompt || '',
            modelConfig: request.modelConfig,
            onDelta: shouldGuardStreamBeforeSend ? (() => {}) : request.onDelta,
            streamHadOutput: shouldGuardStreamBeforeSend ? false : Boolean(state.output?.stream?.hadOutput),
            routeMeta: normalizeObject(request.routeMeta, {}),
            routePolicyKey: request.routePolicyKey,
            routeDebugKey: request.routeDebugKey || request.routeMeta?.routeDebugKey,
            topRouteType: request.topRouteType,
            dispatchBranch: 'direct_reply',
            triggerBranch: 'direct_reply.streaming_humanizer'
          });
        } catch (error) {
          if (!isHumanizerFirstTokenTimeout(error)) throw error;
          humanizerTimedOut = true;
          finalReply = originalReply;
          emitRuntimeEvent(state, 'humanizer_first_token_timeout', {
            node: 'direct_reply',
            stage: 'streaming_humanizer',
            fallbackSource: 'original_streamed_reply'
          });
        }
      }
      const guardedFinalReply = applyGroupDirectStyleGuard(finalReply, request).text;
      const safeFinalReply = sanitizeUserFacingText(guardedFinalReply).trim() || 'The network was unstable just now. Please try again.';
      if ((shouldGuardStreamBeforeSend || humanizerTimedOut) && typeof request.onDelta === 'function' && safeFinalReply) {
        request.onDelta(safeFinalReply, safeFinalReply);
      }
      return {
        finalReply: safeFinalReply,
        humanizerTimedOut,
        stream: {
          ...markStreamCompleted(state.output, true),
          ...mirrorStreamingFlags(state.output, safeFinalReply),
          humanizerTimedOut,
          fallbackToNonStream: false,
          mode: 'direct'
        }
      };
    } catch (error) {
      if (String(error?.partialText || '').trim()) {
        const originalPartialReply = sanitizeUserFacingText(error.partialText).trim();
        let finalReply = originalPartialReply;
        let humanizerTimedOut = false;
        if (useHumanizerStreaming) {
          try {
            finalReply = await finalizeStreamingReplyWithHumanizerImpl(error.partialText, 'The network was unstable just now. Please try again.', {
              question: request.question,
              dynamicPrompt: state.memory?.dynamicPrompt || '',
              modelConfig: request.modelConfig,
              onDelta: shouldGuardStreamBeforeSend ? (() => {}) : request.onDelta,
              streamHadOutput: shouldGuardStreamBeforeSend ? false : Boolean(state.output?.stream?.hadOutput),
              routeMeta: normalizeObject(request.routeMeta, {}),
              routePolicyKey: request.routePolicyKey,
              routeDebugKey: request.routeDebugKey || request.routeMeta?.routeDebugKey,
              topRouteType: request.topRouteType,
              dispatchBranch: 'direct_reply',
              triggerBranch: 'direct_reply.streaming_partial_humanizer'
            });
          } catch (humanizerError) {
            if (!isHumanizerFirstTokenTimeout(humanizerError)) throw humanizerError;
            humanizerTimedOut = true;
            finalReply = originalPartialReply;
            emitRuntimeEvent(state, 'humanizer_first_token_timeout', {
              node: 'direct_reply',
              stage: 'streaming_partial_humanizer',
              fallbackSource: 'original_partial_reply'
            });
          }
        }
        const guardedFinalReply = applyGroupDirectStyleGuard(finalReply, request).text;
        const safeFinalReply = sanitizeUserFacingText(guardedFinalReply).trim() || 'The network was unstable just now. Please try again.';
        if ((shouldGuardStreamBeforeSend || humanizerTimedOut) && typeof request.onDelta === 'function' && safeFinalReply) {
          request.onDelta(safeFinalReply, safeFinalReply);
        }
        return {
          finalReply: safeFinalReply,
          humanizerTimedOut,
          stream: {
            ...markStreamCompleted(state.output, true),
            ...mirrorStreamingFlags(state.output, safeFinalReply),
            humanizerTimedOut,
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
      maxOutputTokens: Number(request.modelConfig?.maxTokens || config.AI_MAX_TOKENS || 3500),
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
