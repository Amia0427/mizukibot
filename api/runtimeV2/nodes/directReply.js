function createRouteAfterDirectReply() {
  return function routeAfterDirectReply(state) {
    if (state?.request?.deferPersist === true) return '__end__';
    return String(state.execution?.mode || '').trim() === 'tool_plan' ? 'planner' : 'persist';
  };
}

function createDirectReplyNode(deps = {}) {
  const normalizeObject = typeof deps.normalizeObject === 'function'
    ? deps.normalizeObject
    : ((value, fallback = {}) => (value && typeof value === 'object' ? value : fallback));
  const normalizeArray = typeof deps.normalizeArray === 'function'
    ? deps.normalizeArray
    : ((value) => (Array.isArray(value) ? value : []));
  const createEvent = typeof deps.createEvent === 'function'
    ? deps.createEvent
    : ((type, payload = {}) => ({ type, ...payload }));
  const isReviewMode = typeof deps.isReviewMode === 'function'
    ? deps.isReviewMode
    : (() => false);
  const shouldBypassHumanizerForPolicy = typeof deps.shouldBypassHumanizerForPolicy === 'function'
    ? deps.shouldBypassHumanizerForPolicy
    : (() => false);
  const computeEffectiveAllowedTools = typeof deps.computeEffectiveAllowedTools === 'function'
    ? deps.computeEffectiveAllowedTools
    : (() => []);
  const getToolPlannerExecutionPlan = typeof deps.getToolPlannerExecutionPlan === 'function'
    ? deps.getToolPlannerExecutionPlan
    : (() => null);
  const isPlannerSingleAuthorityEnabled = typeof deps.isPlannerSingleAuthorityEnabled === 'function'
    ? deps.isPlannerSingleAuthorityEnabled
    : (() => false);
  const getRouteToolPlanner = typeof deps.getRouteToolPlanner === 'function'
    ? deps.getRouteToolPlanner
    : (() => null);
  const buildVisionMessageContent = typeof deps.buildVisionMessageContent === 'function'
    ? deps.buildVisionMessageContent
    : ((text) => text);
  const stripMemoryCliInstruction = typeof deps.stripMemoryCliInstruction === 'function'
    ? deps.stripMemoryCliInstruction
    : ((text) => String(text || ''));
  const getMainConversationSystemMessages = typeof deps.getMainConversationSystemMessages === 'function'
    ? deps.getMainConversationSystemMessages
    : (() => []);
  const buildDirectReplyMessages = typeof deps.buildDirectReplyMessages === 'function'
    ? deps.buildDirectReplyMessages
    : (() => ({ messages: [] }));
  const buildLiveMainConversationSnapshot = typeof deps.buildLiveMainConversationSnapshot === 'function'
    ? deps.buildLiveMainConversationSnapshot
    : (() => null);
  const ensureOutputStream = typeof deps.ensureOutputStream === 'function'
    ? deps.ensureOutputStream
    : ((output = {}, mode = 'none') => ({ ...(output.stream || {}), mode }));
  const createMemoryCliTurnState = typeof deps.createMemoryCliTurnState === 'function'
    ? deps.createMemoryCliTurnState
    : ((value) => value || null);
  const cloneDirectToolLoopState = typeof deps.cloneDirectToolLoopState === 'function'
    ? deps.cloneDirectToolLoopState
    : ((value) => ({ ...(value || {}) }));
  const normalizeMessageForToolLoop = typeof deps.normalizeMessageForToolLoop === 'function'
    ? deps.normalizeMessageForToolLoop
    : ((value) => value);
  const requestAssistantMessageImpl = typeof deps.requestAssistantMessageImpl === 'function'
    ? deps.requestAssistantMessageImpl
    : (async () => ({ role: 'assistant', content: '' }));
  const compileDirectChatToolCallsToPlan = typeof deps.compileDirectChatToolCallsToPlan === 'function'
    ? deps.compileDirectChatToolCallsToPlan
    : ((toolCalls, plan) => ({ ...plan, steps: toolCalls }));
  const saveAndEmit = typeof deps.saveAndEmit === 'function'
    ? deps.saveAndEmit
    : ((state) => state);
  const mirrorStreamingFlags = typeof deps.mirrorStreamingFlags === 'function'
    ? deps.mirrorStreamingFlags
    : (() => ({}));
  const isPureToolCallMarkup = typeof deps.isPureToolCallMarkup === 'function'
    ? deps.isPureToolCallMarkup
    : (() => false);
  const streamDirectReply = typeof deps.streamDirectReply === 'function'
    ? deps.streamDirectReply
    : (async () => ({ finalReply: '', stream: ensureOutputStream({}, 'direct') }));
  const requestReplyImpl = typeof deps.requestReplyImpl === 'function'
    ? deps.requestReplyImpl
    : (async () => '');
  const isStableDirectReplyText = typeof deps.isStableDirectReplyText === 'function'
    ? deps.isStableDirectReplyText
    : ((text = '') => {
        const trimmed = String(text || '').trim();
        if (!trimmed) return false;
        if (isPureToolCallMarkup(trimmed)) return false;
        return classifyReplyFailure(trimmed).type === 'none';
      });
  const classifyDirectReplyError = typeof deps.classifyDirectReplyError === 'function'
    ? deps.classifyDirectReplyError
    : (() => 'generic_model_failure');
  const attemptDirectMemoryRecovery = typeof deps.attemptDirectMemoryRecovery === 'function'
    ? deps.attemptDirectMemoryRecovery
    : (async () => null);
  const getControlledFailureReply = typeof deps.getControlledFailureReply === 'function'
    ? deps.getControlledFailureReply
    : (() => 'Tool error');
  const updateMemoryCliTurnStateAfterError = typeof deps.updateMemoryCliTurnStateAfterError === 'function'
    ? deps.updateMemoryCliTurnStateAfterError
    : ((state) => state);
  const classifyReplyFailure = typeof deps.classifyReplyFailure === 'function'
    ? deps.classifyReplyFailure
    : (() => ({ type: 'none' }));

  return async function directReplyNode(state) {
    const request = normalizeObject(state.request, {});
    const events = [createEvent('node_start', { node: 'direct_reply', mode: state.execution.mode })];
    const isReviewRoute = isReviewMode(request.reviewMode);
    const shouldBypassHumanizer = isReviewRoute || shouldBypassHumanizerForPolicy(request.routePolicyKey);
    void shouldBypassHumanizer;
    const directEffectiveAllowedTools = computeEffectiveAllowedTools(request, state.execution?.memoryCliTurn);
    const plannerExecutionPlan = getToolPlannerExecutionPlan(request.routeMeta);
    const plannerSingleAuthority = String(plannerExecutionPlan?.mode || '').trim() === 'tool_plan'
      && normalizeArray(plannerExecutionPlan?.steps).length > 0;
    const enforcePlannerSingleAuthority = isPlannerSingleAuthorityEnabled() && Boolean(getRouteToolPlanner(request.routeMeta));
    const shouldProbeToolCalls = !request.imageUrl
      && directEffectiveAllowedTools.length > 0
      && !plannerSingleAuthority
      && !enforcePlannerSingleAuthority
      && request.allowTools !== false;
    const messageContent = request.imageUrl
      ? buildVisionMessageContent(request.question || '', request.imageUrl)
      : (request.question || '');
    const dynamicPrompt = (!shouldProbeToolCalls || request.allowTools === false)
      ? stripMemoryCliInstruction(String(state.memory?.dynamicPrompt || ''))
      : String(state.memory?.dynamicPrompt || '');
    const directContext = {
      question: request.question,
      dynamicPrompt,
      modelConfig: request.modelConfig,
      routePolicyKey: request.routePolicyKey,
      reviewMode: request.reviewMode,
      routeMeta: request.routeMeta,
      topRouteType: request.topRouteType,
      customPrompt: request.customPrompt,
      disableTools: !request.allowTools,
      allowedTools: normalizeArray(request.allowedTools),
      source: 'direct_reply'
    };
    const baseSystemMessages = getMainConversationSystemMessages(state, {
      isReviewRoute,
      disableMemoryCliInstruction: !shouldProbeToolCalls
    });
    const directReplyPayload = buildDirectReplyMessages(state, messageContent, baseSystemMessages);
    const messagesToSend = normalizeArray(directReplyPayload.messages);
    directContext.compactionPlan = directReplyPayload.compactionPlan || null;
    directContext.canonicalSegments = directReplyPayload.canonicalSegments || null;
    const mainConversationSnapshot = buildLiveMainConversationSnapshot(state, {
      affinity: state.memory?.affinity,
      allowedTools: directEffectiveAllowedTools,
      source: 'direct_reply'
    });
    const contextStats = {
      usageRatio: Number(mainConversationSnapshot?.snapshotMeta?.compactionDiagnostics?.usageRatio || 0) || 0,
      compactionLevel: String(mainConversationSnapshot?.snapshotMeta?.compactionDiagnostics?.level || 'normal').trim() || 'normal'
    };
    let reply = '';
    let nextStream = ensureOutputStream(state.output, request.imageUrl ? 'none' : 'direct');
    let nextMemoryCliTurn = createMemoryCliTurnState(state.execution?.memoryCliTurn);
    let nextAllowedTools = directEffectiveAllowedTools;
    let directLoopEvents = [];
    let executedToolEnvelopes = [];
    let compiledToolPlan = null;
    const initialDirectLoopState = cloneDirectToolLoopState({
      messages: messagesToSend,
      events: [
        createEvent('effectiveAllowedTools', {
          node: 'direct_reply',
          allowedTools: directEffectiveAllowedTools
        }),
        createEvent('memoryCliTurn', {
          node: 'direct_reply',
          memoryCliTurn: nextMemoryCliTurn
        })
      ],
      memoryCliTurn: nextMemoryCliTurn,
      executedToolEnvelopes,
      effectiveAllowedTools: directEffectiveAllowedTools
    });

    if (shouldProbeToolCalls) {
      try {
        const firstAssistantMessage = normalizeMessageForToolLoop(await requestAssistantMessageImpl(messagesToSend, {
          ...directContext,
          disableTools: directEffectiveAllowedTools.length === 0,
          allowedTools: directEffectiveAllowedTools
        }));
        const firstToolCalls = normalizeArray(firstAssistantMessage.tool_calls);
        if (firstToolCalls.length > 0) {
          for (const toolCall of firstToolCalls) {
            directLoopEvents.push(createEvent('tool_call_detected', {
              node: 'direct_reply',
              tool_name: String(toolCall?.function?.name || '').trim(),
              tool_call_id: String(toolCall?.id || '').trim()
            }));
          }
          compiledToolPlan = compileDirectChatToolCallsToPlan(firstToolCalls, state.plan, {
            allowedTools: directEffectiveAllowedTools
          });
          const compiledEvents = events.concat(directLoopEvents).concat([
            createEvent('direct_chat_execution_mode', {
              node: 'direct_reply',
              mode: 'compiled_tool_plan'
            }),
            createEvent('node_complete', { node: 'direct_reply' })
          ]);
          return saveAndEmit({
            ...state,
            request: {
              ...state.request,
              allowedTools: nextAllowedTools
            },
            memory: {
              ...state.memory,
              mainConversationSnapshot,
              contextStats
            },
            plan: compiledToolPlan,
            execution: {
              ...state.execution,
              status: 'planned',
              mode: 'tool_plan',
              route: 'tool_plan',
              currentNode: 'direct_reply',
              toolResults: [],
              memoryCliTurn: nextMemoryCliTurn,
              directChatToolCompile: {
                enabled: true,
                assistantMessage: firstAssistantMessage,
                directContext,
                mainConversationSnapshot
              }
            },
            output: {
              ...state.output,
              stream: ensureOutputStream(state.output, 'none')
            },
            events: compiledEvents
          }, 'direct_reply', 'running', compiledEvents);
        }
        if (request.streaming) {
          const streamed = await streamDirectReply(messagesToSend, {
            ...state,
            request: {
              ...request,
              routePolicyKey: directContext.routePolicyKey
            }
          });
          reply = streamed.finalReply;
          nextStream = streamed.stream;
        } else {
          reply = await requestReplyImpl(
            messagesToSend,
            {
              ...directContext,
              disableTools: true,
              allowedTools: []
            }
          );
        }
      } catch (error) {
        const failureType = classifyDirectReplyError(error);
        const recovered = enforcePlannerSingleAuthority
          ? null
          : await attemptDirectMemoryRecovery(
              state,
              directContext,
              {
                mainConversationSnapshot
              },
              error?.directToolLoopState || initialDirectLoopState
            );
        if (recovered) {
          reply = String(recovered.reply || '');
          nextMemoryCliTurn = createMemoryCliTurnState(recovered.memoryCliTurn);
          nextAllowedTools = normalizeArray(recovered.effectiveAllowedTools);
          directLoopEvents = normalizeArray(recovered.events);
          executedToolEnvelopes = normalizeArray(recovered.executedToolEnvelopes);
        } else {
          reply = getControlledFailureReply(failureType);
          nextMemoryCliTurn = createMemoryCliTurnState(
            updateMemoryCliTurnStateAfterError(nextMemoryCliTurn, failureType === 'tool_loop_limit' ? 'tool_loop_limit' : 'tool_error')
          );
          nextAllowedTools = computeEffectiveAllowedTools(request, nextMemoryCliTurn);
          directLoopEvents = [
            createEvent('effectiveAllowedTools', {
              node: 'direct_reply',
              allowedTools: nextAllowedTools
            }),
            createEvent('memoryCliTurn', {
              node: 'direct_reply',
              memoryCliTurn: nextMemoryCliTurn
            }),
            createEvent('tool_loop_forced_answer', {
              node: 'direct_reply',
              reason: 'direct_tool_probe_error',
              failureType
            })
          ];
        }
      }
    } else if (plannerSingleAuthority) {
      try {
        reply = await requestReplyImpl(
          messagesToSend,
          {
            ...directContext,
            disableTools: true,
            allowedTools: []
          }
        );
      } catch (error) {
        reply = getControlledFailureReply(classifyDirectReplyError(error));
      }
      directLoopEvents = [
        createEvent('direct_chat_execution_mode', {
          node: 'direct_reply',
          mode: 'planner_single_authority'
        })
      ];
    } else if (request.streaming) {
      try {
        const streamed = await streamDirectReply(messagesToSend, {
          ...state,
          request: {
            ...request,
            routePolicyKey: directContext.routePolicyKey
          }
        });
        reply = streamed.finalReply;
        nextStream = streamed.stream;
      } catch (error) {
        nextStream = error?.outputStream
          ? { ...ensureOutputStream(state.output, 'direct'), ...normalizeObject(error.outputStream, {}) }
          : { ...ensureOutputStream(state.output, 'direct'), fallbackToNonStream: true };
        try {
          reply = await requestReplyImpl(
            messagesToSend,
            {
              ...directContext,
              disableTools: true,
              allowedTools: []
            }
          );
        } catch (fallbackError) {
          reply = getControlledFailureReply(classifyDirectReplyError(fallbackError));
        }
      }
    } else {
      try {
        reply = await requestReplyImpl(
          messagesToSend,
          {
            ...directContext,
            disableTools: true,
            allowedTools: []
          }
        );
      } catch (error) {
        reply = getControlledFailureReply(classifyDirectReplyError(error));
      }
    }

    if (isPureToolCallMarkup(reply) && executedToolEnvelopes.length === 0) {
      let retriedReply = '';
      try {
        retriedReply = String(await requestReplyImpl(
          messagesToSend.concat([{
            role: 'system',
            content: 'Do not emit any <tool_calls> markup or any tool/function call. No tool is available for this turn. Reply with plain natural language only.'
          }]),
          {
            ...directContext,
            disableTools: true,
            allowedTools: []
          }
        ) || '').trim();
      } catch (_) {}

      if (isStableDirectReplyText(retriedReply)) {
        reply = retriedReply;
        directLoopEvents = directLoopEvents.concat([
          createEvent('tool_loop_forced_answer', {
            node: 'direct_reply',
            reason: 'pure_tool_markup_retried_as_plain_text',
            failureType: ''
          })
        ]);
      } else {
        reply = getControlledFailureReply('tool_error');
        directLoopEvents = directLoopEvents.concat([
          createEvent('tool_loop_forced_answer', {
            node: 'direct_reply',
            reason: 'pure_tool_markup_blocked',
            failureType: 'tool_error'
          })
        ]);
      }
    }

    if (!request.streaming) {
      nextStream = {
        ...ensureOutputStream(state.output, request.imageUrl ? 'none' : 'direct'),
        mode: request.imageUrl ? 'none' : 'direct'
      };
    } else if (!nextStream.completed && String(reply || '').trim()) {
      nextStream = {
        ...ensureOutputStream(state.output, executedToolEnvelopes.length > 0 ? 'final_only' : 'direct'),
        ...mirrorStreamingFlags(state.output, reply),
        completed: Boolean(String(reply || '').trim()),
        mode: executedToolEnvelopes.length > 0 ? 'final_only' : 'direct',
        fallbackToNonStream: Boolean(nextStream.fallbackToNonStream)
      };
    }

    const failure = classifyReplyFailure(String(reply || '')).type !== 'none'
      ? classifyReplyFailure(String(reply || ''))
      : null;

    const nextEvents = events.concat(directLoopEvents).concat([
      createEvent('model_reply', {
        node: 'direct_reply',
        preview: String(reply || '').slice(0, 180)
      }),
      createEvent('final_output', {
        text: String(reply || ''),
        failureType: failure?.type || ''
      }),
      createEvent('node_complete', { node: 'direct_reply' })
    ]);
    return saveAndEmit({
      ...state,
      request: {
        ...state.request,
        allowedTools: nextAllowedTools
      },
      memory: {
        ...state.memory,
        mainConversationSnapshot,
        contextStats
      },
      execution: {
        ...state.execution,
        status: failure ? 'failed' : 'completed',
        currentNode: 'direct_reply',
        toolResults: executedToolEnvelopes,
        memoryCliTurn: nextMemoryCliTurn
      },
      output: {
        ...state.output,
        draftReply: String(reply || ''),
        finalReply: String(reply || ''),
        failure,
        stream: nextStream
      },
      events: nextEvents
    }, 'direct_reply', 'running', nextEvents);
  };
}

module.exports = {
  createDirectReplyNode,
  createRouteAfterDirectReply
};
