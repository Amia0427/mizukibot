const {
  applyGroupDirectStyleGuard,
  createGroupDirectStyleGuardEvent
} = require('../guards/groupDirectReplyStyleGuard');
const { isUnsafeUserFacingReply } = require('../../../utils/userFacingReplyGuards');
const {
  getNormalUserMainReplyStreamTimeoutReply,
  isNormalUserMainReplyStreamFirstTokenTimeout
} = require('../../../utils/normalUserMainReplyStreamTimeout');
const {
  getAdminPrivateMainReplyStreamTimeoutReply,
  isAdminPrivateMainReplyStreamFirstTokenTimeout
} = require('../../../utils/adminPrivateMainReplyStreamTimeout');
const {
  analyzeMainReplyDegeneration,
  buildMainReplyDegenerationRepairInstruction
} = require('../../../utils/mainReplyDegenerationGuard');

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
        if (isUnsafeUserFacingReply(trimmed)) return false;
        if (analyzeMainReplyDegeneration(trimmed).degenerated) return false;
        return classifyReplyFailure(trimmed).type === 'none';
      });
  const classifyDirectReplyError = typeof deps.classifyDirectReplyError === 'function'
    ? deps.classifyDirectReplyError
    : (() => 'generic_model_failure');
  const summarizeDirectReplyError = typeof deps.summarizeDirectReplyError === 'function'
    ? deps.summarizeDirectReplyError
    : ((error) => String(error?.message || error || '').trim());
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
  const summarizeToolMarkupText = typeof deps.summarizeToolMarkupText === 'function'
    ? deps.summarizeToolMarkupText
    : ((text = '', maxChars = 240) => {
        const compact = String(text || '').replace(/\s+/g, ' ').trim();
        if (!compact) return '';
        const limit = Math.max(80, Number(maxChars) || 240);
        return compact.length > limit ? `${compact.slice(0, limit - 3).trim()}...` : compact;
      });
  const buildUnsafeReplyRetryInstruction = typeof deps.buildUnsafeReplyRetryInstruction === 'function'
    ? deps.buildUnsafeReplyRetryInstruction
    : (() => [
        'The previous candidate narrated hidden tool/search work or exposed internal context markers.',
        'Do not mention tools, searches, commands, or bracketed internal context.',
        'Reply with plain natural language only, using the context silently.'
      ].join(' '));
  const buildReplyTextVariants = typeof deps.buildReplyTextVariants === 'function'
    ? deps.buildReplyTextVariants
    : ((text = '') => ({
      visibleText: String(text || '').trim(),
      persistedText: String(text || '').trim(),
      hasSafetyRestriction: false
    }));

  function extractAssistantContentText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      }).join('');
    }
    if (content && typeof content === 'object') {
      if (typeof content.text === 'string') return content.text;
      if (typeof content.content === 'string') return content.content;
    }
    return '';
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

  function normalizeReplyResult(result = '') {
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      return {
        reply: String(result.persistedText || result.finalReply || result.visibleText || '').trim(),
        displayReply: String(result.visibleText || result.finalReply || result.persistedText || '').trim(),
        hasSafetyRestriction: result.hasSafetyRestriction === true
      };
    }
    const text = String(result || '').trim();
    return {
      reply: text,
      displayReply: text,
      hasSafetyRestriction: false
    };
  }

  return async function directReplyNode(state) {
    const directReplyStartedAt = Date.now();
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
      ? buildVisionMessageContent(request.question || '', request.imageUrl, request.imageUrls)
      : (request.question || '');
    const dynamicPrompt = (!shouldProbeToolCalls || request.allowTools === false)
      ? stripMemoryCliInstruction(String(state.memory?.dynamicPrompt || ''))
      : String(state.memory?.dynamicPrompt || '');
    const directContext = {
      question: request.question,
      userId: request.userId,
      dynamicPrompt,
      modelConfig: request.modelConfig,
      routePolicyKey: request.routePolicyKey,
      routeDebugKey: request.routeDebugKey || request.routeMeta?.routeDebugKey,
      reviewMode: request.reviewMode,
      routeMeta: request.routeMeta,
      requestTrace: request.requestTrace || request.routeMeta?.requestTrace,
      topRouteType: request.topRouteType,
      customPrompt: request.customPrompt,
      disableTools: !request.allowTools,
      allowedTools: normalizeArray(request.allowedTools),
      source: 'direct_reply',
      dispatchBranch: 'direct_reply',
      preserveThink: request.cotDisplayOnce === true
    };
    const baseSystemMessages = getMainConversationSystemMessages(state, {
      isReviewRoute,
      disableMemoryCliInstruction: !shouldProbeToolCalls
    });
    const preparedContext = normalizeObject(state.memory?.preparedMainConversationContext, {});
    const shouldReusePreparedContext = normalizeArray(preparedContext.messages).length > 0
      && !isVisionLiteContextRequest(request)
      && String(preparedContext.contextBudgetMode || '').trim() !== 'vision_lite';
    const directReplyPayload = shouldReusePreparedContext
      ? {
          messages: normalizeArray(preparedContext.messages),
          assistantOnlyContextMessages: normalizeArray(preparedContext.assistantOnlyContextMessages),
          compactionPlan: preparedContext.compactionPlan || null,
          canonicalSegments: preparedContext.canonicalSegments || null
        }
      : buildDirectReplyMessages(state, messageContent, baseSystemMessages);
    const messagesToSend = normalizeArray(directReplyPayload.messages);
    directContext.compactionPlan = directReplyPayload.compactionPlan || null;
    directContext.canonicalSegments = directReplyPayload.canonicalSegments || null;
    const mainConversationSnapshot = preparedContext.mainConversationSnapshot && typeof preparedContext.mainConversationSnapshot === 'object'
      ? preparedContext.mainConversationSnapshot
      : buildLiveMainConversationSnapshot(state, {
        affinity: state.memory?.affinity,
        allowedTools: directEffectiveAllowedTools,
        source: 'direct_reply'
      });
    const contextStats = preparedContext.contextStats && typeof preparedContext.contextStats === 'object'
      ? preparedContext.contextStats
      : {
          usageRatio: Number(mainConversationSnapshot?.snapshotMeta?.compactionDiagnostics?.usageRatio || 0) || 0,
          compactionLevel: String(mainConversationSnapshot?.snapshotMeta?.compactionDiagnostics?.level || 'normal').trim() || 'normal'
        };
    let reply = '';
    let displayReply = '';
    let hasSafetyRestriction = false;
    let nextStream = ensureOutputStream(state.output, request.imageUrl ? 'none' : 'direct');
    let nextMemoryCliTurn = createMemoryCliTurnState(state.execution?.memoryCliTurn);
    let nextAllowedTools = directEffectiveAllowedTools;
    let directLoopEvents = [];
    let executedToolEnvelopes = [];
    let compiledToolPlan = null;
    let firstAssistantReused = false;
    let humanizerTimedOut = false;
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

    let toolProbeDurationMs = 0;
    if (shouldProbeToolCalls) {
      const toolProbeStartedAt = Date.now();
      try {
        const firstAssistantMessage = normalizeMessageForToolLoop(await requestAssistantMessageImpl(messagesToSend, {
          ...directContext,
          triggerBranch: 'direct_reply.tool_probe',
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
              latencyBreakdown: {
                ...normalizeObject(state.execution?.latencyBreakdown, {}),
                model: {
                  ...(normalizeObject(state.execution?.latencyBreakdown?.model, {})),
                  firstAssistantReused: false,
                  hadToolCalls: true,
                  mode: request.streaming ? 'streaming' : 'non_stream',
                  tool_probe_ms: Math.max(0, Date.now() - toolProbeStartedAt),
                  total_direct_reply_ms: Math.max(0, Date.now() - directReplyStartedAt)
                }
              },
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
        const assistantText = extractAssistantContentText(firstAssistantMessage?.content).trim();
        if (isStableDirectReplyText(assistantText)) {
          const variants = buildReplyTextVariants(assistantText);
          reply = String(variants.persistedText || assistantText || '').trim();
          displayReply = String(variants.visibleText || reply || '').trim();
          hasSafetyRestriction = Boolean(hasSafetyRestriction || variants.hasSafetyRestriction === true);
          firstAssistantReused = true;
          directLoopEvents.push(createEvent('first_assistant_reused', {
            node: 'direct_reply',
            reused: true,
            hadToolCalls: false
          }));
          if (request.streaming) {
            if (typeof request.onDelta === 'function' && displayReply) {
              try {
                const streamGuard = applyGroupDirectStyleGuard(displayReply, request);
                request.onDelta(streamGuard.text, streamGuard.text);
              } catch (_) {}
            }
            nextStream = {
              ...ensureOutputStream(state.output, 'direct'),
              ...mirrorStreamingFlags(state.output, reply),
              completed: Boolean(reply),
              mode: 'direct'
            };
          }
        } else if (isUnsafeUserFacingReply(assistantText)) {
          directLoopEvents.push(createEvent('unsafe_reply_blocked', {
            node: 'direct_reply',
            stage: 'tool_probe',
            preview: summarizeToolMarkupText(assistantText, 320)
          }));
          const replyResult = await requestReplyImpl(
            messagesToSend.concat([{
              role: 'system',
              content: buildUnsafeReplyRetryInstruction()
            }]),
            {
              ...directContext,
              triggerBranch: 'direct_reply.unsafe_tool_probe_retry',
              disableTools: true,
              allowedTools: []
            }
          );
          const normalizedReply = normalizeReplyResult(replyResult);
          reply = normalizedReply.reply;
          displayReply = normalizedReply.displayReply;
          hasSafetyRestriction = Boolean(hasSafetyRestriction || normalizedReply.hasSafetyRestriction);
        } else if (request.streaming) {
          const streamed = await streamDirectReply(messagesToSend, {
            ...state,
            request: {
              ...request,
              routePolicyKey: directContext.routePolicyKey,
              routeDebugKey: directContext.routeDebugKey
            }
          });
          reply = streamed.persistedText || streamed.finalReply || '';
          displayReply = streamed.visibleText || streamed.finalReply || '';
          hasSafetyRestriction = Boolean(hasSafetyRestriction || streamed.hasSafetyRestriction === true);
          nextStream = streamed.stream;
          humanizerTimedOut = Boolean(humanizerTimedOut || streamed.humanizerTimedOut);
        } else {
          const replyResult = await requestReplyImpl(
            messagesToSend,
            {
              ...directContext,
              triggerBranch: 'direct_reply.tool_probe_non_stream_fallback',
              disableTools: true,
              allowedTools: []
            }
          );
          const normalizedReply = normalizeReplyResult(replyResult);
          reply = normalizedReply.reply;
          displayReply = normalizedReply.displayReply;
          hasSafetyRestriction = Boolean(hasSafetyRestriction || normalizedReply.hasSafetyRestriction);
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
          displayReply = String(recovered.reply || '');
          nextMemoryCliTurn = createMemoryCliTurnState(recovered.memoryCliTurn);
          nextAllowedTools = normalizeArray(recovered.effectiveAllowedTools);
          directLoopEvents = normalizeArray(recovered.events);
          executedToolEnvelopes = normalizeArray(recovered.executedToolEnvelopes);
        } else {
          reply = getControlledFailureReply(failureType);
          displayReply = reply;
          nextMemoryCliTurn = createMemoryCliTurnState(
            updateMemoryCliTurnStateAfterError(nextMemoryCliTurn, failureType === 'tool_loop_limit' ? 'tool_loop_limit' : 'tool_error')
          );
          nextAllowedTools = computeEffectiveAllowedTools(request, nextMemoryCliTurn);
          directLoopEvents = [
            createEvent('direct_reply_failure', {
              node: 'direct_reply',
              stage: 'request_reply',
              failureType,
              fallbackSource: 'controlled_failure',
              rawErrorMessage: summarizeDirectReplyError(error)
            }),
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
      } finally {
        toolProbeDurationMs = Math.max(0, Date.now() - toolProbeStartedAt);
      }
    } else if (plannerSingleAuthority) {
      try {
        const replyResult = await requestReplyImpl(
          messagesToSend,
          {
            ...directContext,
            triggerBranch: 'direct_reply.planner_single_authority',
            disableTools: true,
            allowedTools: []
          }
        );
        const normalizedReply = normalizeReplyResult(replyResult);
        reply = normalizedReply.reply;
        displayReply = normalizedReply.displayReply;
        hasSafetyRestriction = Boolean(hasSafetyRestriction || normalizedReply.hasSafetyRestriction);
      } catch (error) {
        const failureType = classifyDirectReplyError(error);
        directLoopEvents = directLoopEvents.concat([
          createEvent('direct_reply_failure', {
            node: 'direct_reply',
            stage: 'planner_single_authority',
            failureType,
            fallbackSource: 'controlled_failure',
            rawErrorMessage: summarizeDirectReplyError(error)
          })
        ]);
        reply = getControlledFailureReply(failureType);
        displayReply = reply;
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
            routePolicyKey: directContext.routePolicyKey,
            routeDebugKey: directContext.routeDebugKey
          }
        });
        reply = streamed.persistedText || streamed.finalReply || '';
        displayReply = streamed.visibleText || streamed.finalReply || '';
        hasSafetyRestriction = Boolean(hasSafetyRestriction || streamed.hasSafetyRestriction === true);
        nextStream = streamed.stream;
        humanizerTimedOut = Boolean(humanizerTimedOut || streamed.humanizerTimedOut);
      } catch (error) {
        nextStream = error?.outputStream
          ? { ...ensureOutputStream(state.output, 'direct'), ...normalizeObject(error.outputStream, {}) }
          : { ...ensureOutputStream(state.output, 'direct'), fallbackToNonStream: true };
        if (isNormalUserMainReplyStreamFirstTokenTimeout(error)) {
          const timeoutReply = getNormalUserMainReplyStreamTimeoutReply(error);
          reply = timeoutReply;
          displayReply = timeoutReply;
          nextStream = {
            ...ensureOutputStream(state.output, 'direct'),
            ...mirrorStreamingFlags(state.output, timeoutReply),
            completed: true,
            fallbackToNonStream: false,
            mode: 'direct',
            normalUserStreamFirstTokenTimedOut: true
          };
          directLoopEvents = directLoopEvents.concat([
            createEvent('normal_user_stream_first_token_timeout', {
              node: 'direct_reply',
              stage: 'streaming_upstream',
              fallbackSource: 'normal_user_stream_first_token_timeout',
              timeoutMs: Number(error?.timeoutMs || 0) || 0
            })
          ]);
        } else if (isAdminPrivateMainReplyStreamFirstTokenTimeout(error)) {
          const timeoutReply = getAdminPrivateMainReplyStreamTimeoutReply(error);
          reply = timeoutReply;
          displayReply = timeoutReply;
          nextStream = {
            ...ensureOutputStream(state.output, 'direct'),
            ...mirrorStreamingFlags(state.output, timeoutReply),
            completed: true,
            fallbackToNonStream: false,
            mode: 'direct',
            adminPrivateStreamFirstTokenTimedOut: true
          };
          directLoopEvents = directLoopEvents.concat([
            createEvent('admin_private_stream_first_token_timeout', {
              node: 'direct_reply',
              stage: 'streaming_upstream',
              fallbackSource: 'admin_private_stream_first_token_timeout',
              timeoutKind: String(error?.adminPrivateStreamTimeoutKind || 'first_token').trim() || 'first_token',
              timeoutMs: Number(error?.timeoutMs || 0) || 0
            })
          ]);
        } else {
          try {
            const replyResult = await requestReplyImpl(
              messagesToSend,
              {
                ...directContext,
                triggerBranch: 'direct_reply.stream_non_stream_fallback',
                disableTools: true,
                allowedTools: []
              }
            );
            const normalizedReply = normalizeReplyResult(replyResult);
            reply = normalizedReply.reply;
            displayReply = normalizedReply.displayReply;
            hasSafetyRestriction = Boolean(hasSafetyRestriction || normalizedReply.hasSafetyRestriction);
          } catch (fallbackError) {
            const failureType = classifyDirectReplyError(fallbackError);
            directLoopEvents = directLoopEvents.concat([
              createEvent('direct_reply_failure', {
                node: 'direct_reply',
                stage: 'stream_non_stream_fallback',
                failureType,
                fallbackSource: 'controlled_failure',
                rawErrorMessage: summarizeDirectReplyError(fallbackError)
              })
            ]);
            reply = getControlledFailureReply(failureType);
            displayReply = reply;
          }
        }
      }
    } else {
      try {
        const replyResult = await requestReplyImpl(
          messagesToSend,
          {
            ...directContext,
            triggerBranch: 'direct_reply.non_stream',
            disableTools: true,
            allowedTools: []
          }
        );
        const normalizedReply = normalizeReplyResult(replyResult);
        reply = normalizedReply.reply;
        displayReply = normalizedReply.displayReply;
        hasSafetyRestriction = Boolean(hasSafetyRestriction || normalizedReply.hasSafetyRestriction);
      } catch (error) {
        const failureType = classifyDirectReplyError(error);
        directLoopEvents = directLoopEvents.concat([
          createEvent('direct_reply_failure', {
            node: 'direct_reply',
            stage: 'request_reply',
            failureType,
            fallbackSource: 'controlled_failure',
            rawErrorMessage: summarizeDirectReplyError(error)
          })
        ]);
        reply = getControlledFailureReply(failureType);
        displayReply = reply;
      }
    }

    if (!displayReply) {
      displayReply = reply;
    }

    if (isUnsafeUserFacingReply(reply)) {
      directLoopEvents = directLoopEvents.concat([
        createEvent('unsafe_reply_blocked', {
          node: 'direct_reply',
          stage: 'final_reply',
          preview: summarizeToolMarkupText(reply, 320)
        })
      ]);
      let retriedReply = '';
      try {
        const retryResult = await requestReplyImpl(
          messagesToSend.concat([{
            role: 'system',
            content: buildUnsafeReplyRetryInstruction()
          }]),
          {
            ...directContext,
            triggerBranch: 'direct_reply.unsafe_final_retry',
            disableTools: true,
            allowedTools: []
          }
        );
        retriedReply = String(
          retryResult?.persistedText
          || retryResult?.finalReply
          || retryResult?.visibleText
          || retryResult
          || ''
        ).trim();
        hasSafetyRestriction = Boolean(hasSafetyRestriction || retryResult?.hasSafetyRestriction === true);
      } catch (_) {}

      if (isStableDirectReplyText(retriedReply)) {
        reply = retriedReply;
        displayReply = retriedReply;
      } else {
        reply = getControlledFailureReply('generic_model_failure');
        displayReply = reply;
      }
    }

    const degenerationAnalysis = analyzeMainReplyDegeneration(reply);
    if (degenerationAnalysis.degenerated) {
      directLoopEvents = directLoopEvents.concat([
        createEvent('main_reply_degeneration_detected', {
          node: 'direct_reply',
          stage: 'final_reply',
          score: degenerationAnalysis.score,
          reasons: degenerationAnalysis.reasons,
          metrics: degenerationAnalysis.metrics,
          repairAttempted: true
        })
      ]);
      let repairedReply = '';
      let repairedDisplayReply = '';
      try {
        const retryResult = await requestReplyImpl(
          messagesToSend.concat([{
            role: 'system',
            content: buildMainReplyDegenerationRepairInstruction(degenerationAnalysis)
          }]),
          {
            ...directContext,
            triggerBranch: 'direct_reply.degeneration_final_retry',
            disableTools: true,
            allowedTools: []
          }
        );
        repairedReply = String(
          retryResult?.persistedText
          || retryResult?.finalReply
          || retryResult?.visibleText
          || retryResult
          || ''
        ).trim();
        repairedDisplayReply = String(
          retryResult?.visibleText
          || retryResult?.finalReply
          || retryResult?.persistedText
          || retryResult
          || ''
        ).trim();
        hasSafetyRestriction = Boolean(hasSafetyRestriction || retryResult?.hasSafetyRestriction === true);
      } catch (_) {}

      const repairAnalysis = analyzeMainReplyDegeneration(repairedReply);
      const repairOk = isStableDirectReplyText(repairedReply) && !repairAnalysis.degenerated;
      directLoopEvents = directLoopEvents.concat([
        createEvent('main_reply_degeneration_repair', {
          node: 'direct_reply',
          stage: 'final_reply',
          ok: repairOk,
          score: repairAnalysis.score,
          reasons: repairAnalysis.reasons
        })
      ]);
      if (repairOk) {
        reply = repairedReply;
        displayReply = repairedDisplayReply || repairedReply;
      } else {
        reply = getControlledFailureReply('generic_model_failure');
        displayReply = reply;
      }
    }

    if (isPureToolCallMarkup(reply) && executedToolEnvelopes.length === 0) {
      directLoopEvents = directLoopEvents.concat([
        createEvent('tool_markup_blocked', {
          node: 'direct_reply',
          stage: 'initial_reply',
          preview: summarizeToolMarkupText(reply, 320)
        })
      ]);
      let retriedReply = '';
      try {
        const retryResult = await requestReplyImpl(
          messagesToSend.concat([{
            role: 'system',
            content: 'Ignore the previous structured tool-call markup. Reply to the user in plain natural language. Do not mention tools, tool availability, or internal routing.'
          }]),
          {
            ...directContext,
            triggerBranch: 'direct_reply.pure_tool_markup_retry',
            disableTools: true,
            allowedTools: []
          }
        );
        retriedReply = String(
          retryResult?.persistedText
          || retryResult?.finalReply
          || retryResult?.visibleText
          || retryResult
          || ''
        ).trim();
        hasSafetyRestriction = Boolean(hasSafetyRestriction || retryResult?.hasSafetyRestriction === true);
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
        if (retriedReply && isPureToolCallMarkup(retriedReply)) {
          directLoopEvents = directLoopEvents.concat([
            createEvent('tool_markup_blocked', {
              node: 'direct_reply',
              stage: 'plain_text_retry',
              preview: summarizeToolMarkupText(retriedReply, 320)
            })
          ]);
        }
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

    const groupDirectStyleGuard = applyGroupDirectStyleGuard(reply || displayReply || '', request);
    if (groupDirectStyleGuard.applied) {
      reply = groupDirectStyleGuard.text;
      displayReply = groupDirectStyleGuard.text;
      directLoopEvents = directLoopEvents.concat([
        createGroupDirectStyleGuardEvent(createEvent, 'direct_reply', groupDirectStyleGuard)
      ]);
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
      ...(humanizerTimedOut ? [createEvent('humanizer_first_token_timeout', {
        node: 'direct_reply',
        fallbackSource: 'original_streamed_reply'
      })] : []),
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
        memoryCliTurn: nextMemoryCliTurn,
        firstAssistantReused,
        latencyBreakdown: {
          ...normalizeObject(state.execution?.latencyBreakdown, {}),
          model: {
            firstAssistantReused,
            hadToolCalls: Boolean(compiledToolPlan),
            mode: request.streaming ? 'streaming' : 'non_stream',
            humanizerFirstTokenTimeout: humanizerTimedOut,
            tool_probe_ms: toolProbeDurationMs,
            total_direct_reply_ms: Math.max(0, Date.now() - directReplyStartedAt)
          }
        }
      },
        output: {
          ...state.output,
          draftReply: String(reply || ''),
          finalReply: String(reply || ''),
          displayReply: String(displayReply || reply || ''),
          persistedReplyText: String(reply || ''),
          hasSafetyRestriction,
          failure,
          stream: nextStream
        },
      events: nextEvents
    }, 'direct_reply', 'running', nextEvents);
  };
}

module.exports = {
  applyGroupDirectStyleGuard,
  createDirectReplyNode,
  createRouteAfterDirectReply
};
