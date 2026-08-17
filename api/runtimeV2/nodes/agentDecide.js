const {
  filterAllowedToolNames,
  normalizeToolNames
} = require('../../../utils/localToolAccess');

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function extractAssistantText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    return typeof part?.text === 'string' ? part.text : '';
  }).join('').trim();
}

function createRouteAfterAgentDecide() {
  return function routeAfterAgentDecide(state) {
    return normalizeArray(state.execution?.agent?.pendingToolCalls).length > 0
      ? 'execute_tools'
      : 'humanize';
  };
}

function createAgentDecideNode(deps = {}) {
  const createEvent = typeof deps.createEvent === 'function'
    ? deps.createEvent
    : ((type, payload = {}) => ({ type, ...payload }));
  const saveAndEmit = typeof deps.saveAndEmit === 'function'
    ? deps.saveAndEmit
    : ((state) => state);
  const normalizeMessage = typeof deps.normalizeMessageForToolLoop === 'function'
    ? deps.normalizeMessageForToolLoop
    : ((message) => message);
  const getMaxToolRounds = typeof deps.getMaxToolRounds === 'function'
    ? deps.getMaxToolRounds
    : (() => 3);
  const getMaxToolCalls = typeof deps.getMaxToolCalls === 'function'
    ? deps.getMaxToolCalls
    : (() => 4);

  function buildModelContext(state, allowedTools) {
    const request = normalizeObject(state.request);
    return {
      question: request.question,
      userId: request.userId,
      dynamicPrompt: String(state.memory?.dynamicPrompt || ''),
      modelConfig: request.modelConfig,
      routePolicyKey: request.routePolicyKey,
      routeDebugKey: request.routeDebugKey || request.routeMeta?.routeDebugKey,
      reviewMode: request.reviewMode,
      routeMeta: request.routeMeta,
      requestTrace: request.requestTrace || request.routeMeta?.requestTrace,
      topRouteType: request.topRouteType,
      customPrompt: request.customPrompt,
      source: 'agent_decide',
      dispatchBranch: 'agent',
      triggerBranch: 'agent_decide.react',
      disableTools: allowedTools.length === 0,
      allowedTools
    };
  }

  function buildInitialMessages(state) {
    const request = normalizeObject(state.request);
    const prepared = normalizeObject(state.memory?.preparedMainConversationContext);
    const chatMode = String(request.routeMeta?.chatMode || '').trim().toLowerCase();
    const visionRoute = Boolean(
      request.imageUrl
      || normalizeArray(request.imageUrls).length > 0
      || chatMode === 'image_qa'
      || chatMode === 'image_summary'
    );
    if (!visionRoute && normalizeArray(prepared.messages).length > 0) {
      return normalizeArray(prepared.messages).map((message) => ({ ...message }));
    }
    const messageContent = request.imageUrl
      ? deps.buildVisionMessageContent(request.question || '', request.imageUrl, request.imageUrls)
      : (request.question || '');
    const systemMessages = deps.getMainConversationSystemMessages(state, {
      isReviewRoute: deps.isReviewMode(request.reviewMode),
      disableMemoryCliInstruction: normalizeArray(request.allowedTools).length === 0
    });
    return normalizeArray(deps.buildDirectReplyMessages(state, messageContent, systemMessages)?.messages)
      .map((message) => ({ ...message }));
  }

  async function runPlainReply(state, messages, context) {
    const request = normalizeObject(state.request);
    if (request.streaming) {
      const streamed = await deps.streamDirectReply(messages, state);
      return {
        reply: String(streamed.persistedText || streamed.finalReply || '').trim(),
        displayReply: String(streamed.visibleText || streamed.finalReply || '').trim(),
        reasoningText: String(streamed.reasoningText || '').trim(),
        reasoningForwardText: String(streamed.reasoningForwardText || '').trim(),
        stream: streamed.stream,
        hasSafetyRestriction: streamed.hasSafetyRestriction === true
      };
    }
    const result = await deps.requestReplyImpl(messages, {
      ...context,
      triggerBranch: 'agent_decide.plain_reply',
      disableTools: true,
      allowedTools: []
    });
    let reply;
    let displayReply;
    let reasoningText = '';
    let reasoningForwardText = '';
    let hasSafetyRestriction = false;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      reply = String(result.persistedText || result.finalReply || result.visibleText || '').trim();
      displayReply = String(result.visibleText || result.finalReply || result.persistedText || '').trim();
      reasoningText = String(result.reasoningText || '').trim();
      reasoningForwardText = String(result.reasoningForwardText || '').trim();
      hasSafetyRestriction = result.hasSafetyRestriction === true;
    } else {
      reply = String(result || '').trim();
      displayReply = reply;
    }
    if (typeof deps.resolveToolLoopReply === 'function') {
      const resolved = await deps.resolveToolLoopReply(
        { role: 'assistant', content: reply },
        messages,
        context,
        'tool_error',
        []
      );
      if (resolved?.text && resolved.source !== 'assistant') {
        reply = String(resolved.text).trim();
        displayReply = reply;
      }
      return {
        reply,
        displayReply,
        reasoningText,
        reasoningForwardText,
        hasSafetyRestriction,
        resolutionSource: String(resolved?.source || '').trim()
      };
    }
    return { reply, displayReply, reasoningText, reasoningForwardText, hasSafetyRestriction };
  }

  return async function agentDecideNode(state) {
    const startedAt = Date.now();
    const createDecisionEvent = (payload = {}) => createEvent('agent_decision', {
      durationMs: Math.max(0, Date.now() - startedAt),
      ...payload
    });
    const request = normalizeObject(state.request);
    const currentAgent = normalizeObject(state.execution?.agent);
    const maxToolRounds = Math.max(1, Number(getMaxToolRounds()) || 3);
    const maxToolCalls = Math.max(1, Number(getMaxToolCalls()) || 4);
    const routeAllowedTools = filterAllowedToolNames(
      normalizeToolNames(request.allowedTools),
      normalizeToolNames(request.routeMeta?.allowedTools)
    );
    const resumePendingToolCalls = normalizeArray(currentAgent.pendingToolCalls);
    const forceFinal = currentAgent.forceFinal === true
      || Number(currentAgent.toolRoundCount || 0) >= maxToolRounds
      || Number(currentAgent.toolCallCount || 0) >= maxToolCalls;
    const allowedTools = forceFinal ? [] : routeAllowedTools;
    const initialMessages = currentAgent.initialized === true
      ? []
      : buildInitialMessages(state);
    const modelMessages = currentAgent.initialized === true
      ? normalizeArray(state.messages)
      : initialMessages;
    const modelContext = buildModelContext(state, allowedTools);
    const events = [createEvent('node_start', {
      node: 'agent_decide',
      toolRoundCount: Number(currentAgent.toolRoundCount || 0),
      toolCallCount: Number(currentAgent.toolCallCount || 0),
      forceFinal
    })];

    if (resumePendingToolCalls.length > 0) {
      const nextEvents = events.concat([
        createEvent('agent_decision', {
          node: 'agent_decide',
          decision: 'resume_pending_tools',
          pendingCount: resumePendingToolCalls.length
        }),
        createEvent('node_complete', { node: 'agent_decide' })
      ]);
      return saveAndEmit({
        ...state,
        execution: {
          ...state.execution,
          status: 'awaiting_tools',
          currentNode: 'agent_decide'
        },
        events: nextEvents
      }, 'agent_decide', 'running', nextEvents);
    }

    if (routeAllowedTools.length === 0 && currentAgent.initialized !== true) {
      try {
        const plain = await runPlainReply(state, modelMessages, modelContext);
        const reply = plain.reply || deps.getControlledFailureReply('generic_model_failure');
        const nextEvents = events.concat([
          createDecisionEvent({
            node: 'agent_decide',
            decision: 'final',
            forced: false,
            resolutionSource: plain.resolutionSource || 'assistant'
          }),
          createEvent('node_complete', { node: 'agent_decide' })
        ]);
        return saveAndEmit({
          ...state,
          execution: {
            ...state.execution,
            status: 'answered',
            mode: 'agent',
            currentNode: 'agent_decide',
            agent: {
              ...currentAgent,
              initialized: true,
              completed: true,
              pendingToolCalls: [],
              maxToolRounds,
              maxToolCalls,
              stopReason: 'final_answer'
            }
          },
          output: {
            ...state.output,
            draftReply: reply,
            displayReply: plain.displayReply || reply,
            reasoningText: plain.reasoningText || '',
            reasoningForwardText: plain.reasoningForwardText || '',
            hasSafetyRestriction: plain.hasSafetyRestriction === true,
            ...(plain.stream ? { stream: plain.stream } : {})
          },
          events: nextEvents
        }, 'agent_decide', 'running', nextEvents);
      } catch (error) {
        const failureType = deps.classifyDirectReplyError(error);
        const reply = deps.getControlledFailureReply(failureType, error);
        const nextEvents = events.concat([
          createDecisionEvent({
            node: 'agent_decide',
            decision: 'final',
            failureType,
            rawErrorMessage: deps.summarizeDirectReplyError(error)
          }),
          createEvent('node_complete', { node: 'agent_decide' })
        ]);
        return saveAndEmit({
          ...state,
          execution: {
            ...state.execution,
            status: 'answered',
            mode: 'agent',
            currentNode: 'agent_decide',
            agent: {
              ...currentAgent,
              initialized: true,
              completed: true,
              pendingToolCalls: [],
              maxToolRounds,
              maxToolCalls,
              stopReason: failureType
            }
          },
          output: { ...state.output, draftReply: reply, displayReply: reply },
          events: nextEvents
        }, 'agent_decide', 'running', nextEvents);
      }
    }

    let assistantMessage;
    try {
      assistantMessage = normalizeMessage(await deps.requestAssistantMessageImpl(
        forceFinal
          ? modelMessages.concat([{
              role: 'system',
              content: 'Tool use is finished. Answer the user now using the available evidence. Do not request or describe another tool call.'
            }])
          : modelMessages,
        modelContext
      ));
    } catch (error) {
      const failureType = deps.classifyDirectReplyError(error);
      const reply = deps.getControlledFailureReply(failureType, error);
      const nextEvents = events.concat([
        createDecisionEvent({
          node: 'agent_decide',
          decision: 'final',
          failureType,
          rawErrorMessage: deps.summarizeDirectReplyError(error)
        }),
        createEvent('node_complete', { node: 'agent_decide' })
      ]);
      return saveAndEmit({
        ...state,
        execution: {
          ...state.execution,
          status: 'answered',
          mode: 'agent',
          currentNode: 'agent_decide',
          agent: {
            ...currentAgent,
            initialized: true,
            completed: true,
            pendingToolCalls: [],
            maxToolRounds,
            maxToolCalls,
            stopReason: failureType
          }
        },
        output: { ...state.output, draftReply: reply, displayReply: reply },
        messages: modelMessages,
        events: nextEvents
      }, 'agent_decide', 'running', nextEvents);
    }

    const toolCalls = forceFinal ? [] : normalizeArray(assistantMessage.tool_calls);
    if (toolCalls.length === 0) {
      const assistantText = extractAssistantText(assistantMessage.content);
      const markupOnlyToolCall = forceFinal
        && normalizeArray(assistantMessage.tool_calls).length > 0
        && deps.isPureToolCallMarkup?.(assistantText) === true;
      const reply = (markupOnlyToolCall ? '' : assistantText)
        || deps.getControlledFailureReply(forceFinal ? 'post_tool_empty_reply' : 'generic_model_failure');
      const nextEvents = events.concat([
        ...(forceFinal ? [createEvent('agent_forced_final', {
          node: 'agent_decide',
          reason: currentAgent.stopReason || 'agent_limit_reached'
        })] : []),
        createDecisionEvent({ node: 'agent_decide', decision: 'final', forced: forceFinal }),
        createEvent('node_complete', { node: 'agent_decide' })
      ]);
      return saveAndEmit({
        ...state,
        execution: {
          ...state.execution,
          status: 'answered',
          mode: 'agent',
          currentNode: 'agent_decide',
          agent: {
            ...currentAgent,
            initialized: true,
            completed: true,
            forceFinal,
            pendingToolCalls: [],
            maxToolRounds,
            maxToolCalls,
            stopReason: forceFinal ? (currentAgent.stopReason || 'agent_limit_reached') : 'final_answer'
          },
          latencyBreakdown: {
            ...normalizeObject(state.execution?.latencyBreakdown),
            agent_decide: { durationMs: Math.max(0, Date.now() - startedAt) }
          }
        },
        output: {
          ...state.output,
          draftReply: reply,
          displayReply: reply,
          reasoningText: String(assistantMessage.reasoningText || '').trim()
        },
        messages: modelMessages.concat([assistantMessage]),
        events: nextEvents
      }, 'agent_decide', 'running', nextEvents);
    }

    const nextToolRoundCount = Number(currentAgent.toolRoundCount || 0) + 1;
    const previousToolCallCount = Number(currentAgent.toolCallCount || 0);
    const remainingToolCalls = Math.max(0, maxToolCalls - previousToolCallCount);
    const pendingToolCalls = toolCalls.map((toolCall, index) => ({
      toolCall,
      toolCallId: String(toolCall?.id || `agent_tool_${nextToolRoundCount}_${index + 1}`).trim(),
      toolName: String(toolCall?.function?.name || '').trim(),
      withinBudget: index < remainingToolCalls,
      round: nextToolRoundCount,
      index
    }));
    const nextToolCallCount = previousToolCallCount + toolCalls.length;
    const limitReached = nextToolRoundCount >= maxToolRounds || nextToolCallCount >= maxToolCalls;
    const nextEvents = events.concat([
      createDecisionEvent({
        node: 'agent_decide',
        decision: 'tools',
        toolRoundCount: nextToolRoundCount,
        toolCallCount: nextToolCallCount,
        toolNames: pendingToolCalls.map((item) => item.toolName)
      }),
      createEvent('agent_tool_round', {
        node: 'agent_decide',
        round: nextToolRoundCount,
        callCount: toolCalls.length
      }),
      ...(limitReached ? [createEvent('agent_limit_reached', {
        node: 'agent_decide',
        toolRoundCount: nextToolRoundCount,
        toolCallCount: nextToolCallCount,
        maxToolRounds,
        maxToolCalls
      })] : []),
      createEvent('node_complete', { node: 'agent_decide' })
    ]);
    return saveAndEmit({
      ...state,
      execution: {
        ...state.execution,
        status: 'awaiting_tools',
        mode: 'agent',
        currentNode: 'agent_decide',
        agent: {
          ...currentAgent,
          initialized: true,
          completed: false,
          pendingToolCalls,
          toolRoundCount: nextToolRoundCount,
          toolCallCount: nextToolCallCount,
          maxToolRounds,
          maxToolCalls,
          forceFinalAfterTools: limitReached,
          stopReason: limitReached ? 'agent_limit_reached' : ''
        }
      },
      output: {
        ...state.output,
        stream: deps.ensureOutputStream(state.output, 'final_only')
      },
      messages: modelMessages.concat([assistantMessage]),
      events: nextEvents
    }, 'agent_decide', 'running', nextEvents);
  };
}

module.exports = {
  createAgentDecideNode,
  createRouteAfterAgentDecide,
  extractAssistantText
};
