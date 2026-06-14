const { buildRoutePromptBundle } = require('../../utils/routePromptPolicy');
const { buildImageModelConfig } = require('../../utils/imageModelConfigResolver');
const {
  buildReplyEnvelope,
  buildRouteDecisionContext
} = require('../messageContracts');
const { buildLlmPerception } = require('../llmPerception');
const { buildRouteMetaEnvelope } = require('../executablePlan');
const {
  appendRequestTraceEvent,
  cloneTraceForMeta,
  nextTracePhase,
  normalizeRequestTrace
} = require('../../utils/requestTrace');
const {
  shouldForceDisableGroupMainModelStream
} = require('../../utils/groupMainModelStreamPolicy');
const {
  buildCacheStatsDiagnostic,
  buildMainReplyTruncationDiagnostic,
  buildMainReplyDiagnosticReport,
  parseMainReplyDiagnosticInput
} = require('../../utils/mainReplyDiagnostics');
const {
  buildMainReplyPromptAssemblyDiagnostic
} = require('../../utils/mainReplyPromptAssemblyDiagnostics');
const {
  parseProviderDiagnosticArgs,
  runProviderRequestDiagnostics
} = require('../../utils/providerRequestDiagnostics');
const { buildRuntimeStatusDiagnostic } = require('../../utils/runtimeStatusDiagnostics');
const { buildRuntimeHotspotsDiagnostic } = require('../../utils/runtimeHotspotsDiagnostics');
const {
  formatModelSelfCheckReport,
  runModelSelfCheck
} = require('../../utils/modelSelfCheck');
const {
  parseJsonTail,
  buildUnavailableRouteReply,
  shouldDowngradeUnavailableRouteToDirectReply,
  buildQzoneAutodraftPrompt,
  buildSupplementedTaskText,
  composeDirectRoutePrompt,
  resolveVisionFallbackModelConfig: resolveVisionFallbackModelConfigBase,
  buildRouteDiagPayload
} = require('./helpers');
const {
  handleGroupPublicAdminCommand,
  handleMainStreamAdminCommand
} = require('./adminCommands');
const {
  generateGroupSummary: generateGroupSummaryDefault
} = require('../../api/groupSummaryService');
const {
  applyGroupDirectGuardToReplyEnvelopeInput
} = require('./groupDirectGuard');
const {
  createAdminTaskHandlers
} = require('./adminTaskHandlers');
const {
  NORMAL_GROUP_MAIN_REPLY_RPM_LIMITED_CODE
} = require('../../utils/normalGroupMainReplyRateLimiter');

function resolveVisionFallbackModelConfig(route = {}, imageUrl = null, userId = '') {
  return resolveVisionFallbackModelConfigBase(route, imageUrl, userId, buildImageModelConfig);
}

function isPrivateNoToolDirectReply(routeExecutionPlan = {}, replyOptions = {}, chatType = '') {
  return Boolean(
    String(chatType || replyOptions?.routeMeta?.chatType || replyOptions?.routeMeta?.chat_type || '').trim().toLowerCase() === 'private'
    && String(routeExecutionPlan?.topRouteType || replyOptions?.topRouteType || '').trim().toLowerCase() === 'direct_chat'
    && routeExecutionPlan?.allowTools !== true
    && replyOptions?.allowTools !== true
    && Array.isArray(routeExecutionPlan?.allowedTools)
    && routeExecutionPlan.allowedTools.length === 0
    && Array.isArray(replyOptions?.allowedTools)
    && replyOptions.allowedTools.length === 0
  );
}

async function sendRateLimitGroupPokeSafely({
  sendGroupPoke,
  sendWithRetry,
  groupId = '',
  senderId = '',
  source = ''
} = {}) {
  const targetGroupId = String(groupId || '').trim();
  const targetUserId = String(senderId || '').trim();
  if (typeof sendGroupPoke !== 'function' || !targetGroupId || !targetUserId) return false;
  try {
    const options = typeof sendWithRetry === 'function'
      ? {
          actionClient: {
            callAction: async (action, params) => {
              const ok = await sendWithRetry({ action, params }, 1, 300);
              if (!ok) {
                throw new Error(`sendWithRetry failed for ${String(action || '').trim() || 'group_poke'}`);
              }
              return {};
            }
          }
        }
      : {};
    await sendGroupPoke(targetGroupId, targetUserId, options);
    return true;
  } catch (error) {
    console.warn('[normal-group-main-reply-rate-limit] group poke failed', {
      groupId: targetGroupId,
      senderId: targetUserId,
      source,
      error: error?.message || String(error || '')
    });
    return false;
  }
}

function createMessageRouteFlow(deps = {}) {
  const {
    config,
    routeResolver,
    routeExecution,
    planDirectChat,
    askAIDispatch,
    askToolTaskLocally,
    runBackgroundToolTask,
    handleAdminCommand,
    handleMemoryOpsAdminCommand = async () => ({ handled: true, replyText: 'memoryops 这边现在没接上。' }),
    handleQqScheduleAdminCommand,
    detectQzonePostDraftMode,
    publishQzoneForContext,
    backgroundTaskRuntime,
    buildSessionId,
    isAdminUser,
    listScheduledTasks,
    cancelScheduledTask,
    deleteScheduledTask,
    formatEventsAsText,
    searchEvents,
    listRecentEvents,
    formatPatternsAsText,
    listPatterns,
    formatRulesAsText,
    listRules,
    formatGuidesAsText,
    listGuides,
    formatStyleProfileAsText,
    formatSocialContextAsText,
    formatRelationshipGraphAsText,
    sendGroupReply,
    sendReply,
    updateFavor,
    saveData,
    recordMemoryScope,
    buildToolGuidancePrompt,
    buildStreamingSegmentationPrompt,
    buildQqRichReplyPrompt,
    shouldPreferQqRichReply,
    buildSafetyBoundaryRoutePrompt,
    buildLlmPerception: injectedBuildLlmPerception,
    createStreamingDispatcher,
    normalizeUserFacingReply,
    getEffectivePolicyKey,
    maybeCaptureUnavailableFeatureRequest,
    shouldAutoDraftQzonePostRequest,
    buildSessionStatusReply,
    buildNoTaskControlText,
    getStreamMaxSegments,
    sendWithRetry,
    markThinkingEmojiBeforeLlm,
    buildSubagentContextSummary,
    normalGroupMainReplyRateLimiter,
    sendGroupPoke,
    generateGroupSummary = generateGroupSummaryDefault,
    actionClient = null
  } = deps;
  const {
    hasAdminAccess
  } = createAdminTaskHandlers({
    isAdminUser,
    sendGroupReply
  });

  async function handleBackgroundTaskControl({
    command,
    groupId,
    senderId,
    userInfo,
    imageUrl,
    rawText,
    botQQ
  }) {
    if (!command) return false;
    const cleanText = String(rawText || '')
      .replace(new RegExp(`\\[CQ:at,qq=${String(botQQ || '').trim()}\\]`, 'g'), '')
      .replace(/\[CQ:image,.*?\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const sessionId = buildSessionId(senderId, {
      sessionChannel: 'qq-group',
      sessionChatId: `group_${groupId}_user_${senderId}`
    });
    const session = backgroundTaskRuntime.getSessionState(sessionId);
    const activeTask = backgroundTaskRuntime.getActiveTask(sessionId);

    if (command.type === 'status') {
      await sendGroupReply({
        groupId,
        senderId,
        replyText: buildSessionStatusReply(session, activeTask),
        atSender: true,
        retries: 1,
        waitMs: 300
      });
      return true;
    }

    if (command.type === 'cancel') {
      const targetTaskId = activeTask?.id || '';
      const cancelled = targetTaskId
        ? backgroundTaskRuntime.requestCancel(targetTaskId, { error: 'cancelled by user', reason: 'cancelled by user' })
        : null;
      await sendGroupReply({
        groupId,
        senderId,
        replyText: cancelled ? '已尝试取消当前后台任务。' : buildNoTaskControlText(),
        atSender: true,
        retries: 1,
        waitMs: 300
      });
      return true;
    }

    if (command.type === 'close') {
      const closed = session ? backgroundTaskRuntime.closeSession(sessionId) : null;
      await sendGroupReply({
        groupId,
        senderId,
        replyText: closed ? '已结束当前后台任务会话。' : buildNoTaskControlText(),
        atSender: true,
        retries: 1,
        waitMs: 300
      });
      return true;
    }

    if (command.type !== 'supplement') return false;
    if (!String(command.payload || '').trim()) {
      await sendGroupReply({
        groupId,
        senderId,
        replyText: '请在“任务补充 ...”或“任务继续 ...”后面写清新的要求。',
        atSender: true,
        retries: 1,
        waitMs: 300
      });
      return true;
    }

    if (!session || String(session.status || '').trim() === 'done') {
      await sendGroupReply({
        groupId,
        senderId,
        replyText: buildNoTaskControlText(),
        atSender: true,
        retries: 1,
        waitMs: 300
      });
      return true;
    }

    const supplementedText = buildSupplementedTaskText(session, command.payload);
    const routerContextSummary = typeof buildSubagentContextSummary === 'function'
      ? buildSubagentContextSummary(senderId, groupId, { maxLength: 180 })
      : '';
    const plannerContextSummary = typeof buildSubagentContextSummary === 'function'
      ? buildSubagentContextSummary(senderId, groupId, { maxLength: 320 })
      : '';
    const route = await routeResolver({
      rawText: String(rawText || '').replace(cleanText, supplementedText),
      botQQ,
      userId: senderId,
      contextSummary: routerContextSummary
    });
    route.meta = {
      ...(route.meta || {}),
      userId: String(senderId || ''),
      groupId: String(groupId || '')
    };
    route.cleanText = supplementedText;
    route.rawText = supplementedText;
    if (route?.topRouteType === 'direct_chat') {
      const plannerDecision = await planDirectChat(route, {
        userId: senderId,
        allowedTools: route?.meta?.allowedTools,
        contextSummary: plannerContextSummary,
        directedContext: route?.meta?.directedContext || null,
        continuitySignals: route?.meta?.continuitySignals || {},
        memoryContext: route?.meta?.memoryContext || {},
        availableContextSignals: route?.meta?.availableContextSignals || {},
        personaModuleCatalog: route?.meta?.personaModuleCatalog || [],
        dynamicPromptBlockCatalog: route?.meta?.dynamicPromptBlockCatalog || [],
        dynamicPromptGuide: route?.meta?.dynamicPromptGuide || '',
        dynamicFewShotPrompt: route?.meta?.dynamicFewShotPrompt || '',
        mainReplyPromptMode: route?.meta?.mainReplyPromptMode || '',
        memoryCliTurn: route?.meta?.memoryCliTurn || {},
        schedulerInjection: route?.meta?.schedulerInjection || route?.meta?.lifeSchedulerInjection || '',
        sharedShortTermContext: route?.meta?.sharedShortTermContext || {},
        personaMemoryState: route?.meta?.personaMemoryState || {}
      });
      route.meta = {
        ...(route.meta || {}),
        toolPlanner: plannerDecision,
        directChatPlanner: plannerDecision
      };
    }
    const routeExecutionPlan = routeExecution.resolveRouteExecution(route, config, {});

    if (String(routeExecutionPlan.executor || '').trim() !== 'background_direct' && !routeExecutionPlan.allowTools) {
      await sendGroupReply({
        groupId,
        senderId,
        replyText: '这条补充要求目前不会进入后台工具链路。你可以把任务目标说得更明确一些再试。',
        atSender: true,
        retries: 1,
        waitMs: 300
      });
      return true;
    }

    if (activeTask?.id) {
      backgroundTaskRuntime.supersedeTask(activeTask.id);
    }

    const promptBundle = buildRoutePromptBundle({
      route,
      routeExecutionPlan,
      cleanText: supplementedText,
      maxStreamSegments: getStreamMaxSegments(config),
      buildToolGuidancePrompt,
      buildStreamingSegmentationPrompt,
      shouldPreferQqRichReply,
      buildQqRichReplyPrompt
    });
    await runBackgroundToolTask({
      route,
      routeExecutionPlan,
      cleanText: supplementedText,
      imageUrl: route.imageUrl || imageUrl,
      userInfo,
      senderId,
      groupId,
      toolTaskOptions: {
        routePrompt: promptBundle.toolGuidancePrompt,
        sessionChannel: 'qq-group',
        sessionChatId: `group_${groupId}_user_${senderId}`,
        routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
        topRouteType: routeExecutionPlan.topRouteType,
        allowedTools: routeExecutionPlan.allowedTools,
        routeMeta: buildRouteMetaEnvelope(route, routeExecutionPlan, route?.meta?.toolPlanner || route?.meta?.directChatPlanner || null, { groupId })
      },
      sendAckOnly: false
    });
    return true;
  }

  async function dispatchByRoutePlan(input = {}) {
    const routeDecision = buildRouteDecisionContext(input);
    const {
      route,
      executionPlan: routeExecutionPlan,
      requestText: cleanText,
      imageUrl,
      imageUrls,
      userInfo,
      senderId,
      groupId,
      inboundContext,
      freshness = null
    } = routeDecision;
    const chatType = String(route?.meta?.chatType || inboundContext?.chatType || 'group').trim().toLowerCase() === 'private'
      ? 'private'
      : 'group';
    const requestTrace = normalizeRequestTrace(route?.meta?.requestTrace)
      || normalizeRequestTrace(inboundContext?.requestTrace);
    const downgradeUnavailableToDirectReply = shouldDowngradeUnavailableRouteToDirectReply(route, routeExecutionPlan);
    const emitRouteDiag = (phase = '', payload = {}) => {
      if (!requestTrace) return;
      appendRequestTraceEvent(nextTracePhase(requestTrace, phase, {
        stage: phase,
        source: 'route_dispatch',
        userId: String(senderId || '').trim(),
        groupId: String(groupId || '').trim(),
        chatType,
        ...payload
      }));
    };
    const cotDisplayOnce = route?.meta?.cotDisplayOnce === true;
    let reply = '';
    let usedStreamingSend = false;
    let finalReplyOptions = null;
    let persistedReplyText = '';

    const promptBundle = buildRoutePromptBundle({
      route,
      routeExecutionPlan,
      cleanText,
      maxStreamSegments: getStreamMaxSegments(config),
      buildToolGuidancePrompt,
      buildStreamingSegmentationPrompt,
      shouldPreferQqRichReply,
      buildQqRichReplyPrompt
    });
    let {
      toolGuidancePrompt,
      streamingSegmentationPrompt,
      qqRichReplyPrompt,
      disableStreamForReply
    } = promptBundle;
    if (downgradeUnavailableToDirectReply) {
      toolGuidancePrompt = null;
    }
    const safetyBoundaryRoutePrompt = buildSafetyBoundaryRoutePrompt(route);
    const perceptionBuilder = typeof injectedBuildLlmPerception === 'function'
      ? injectedBuildLlmPerception
      : buildLlmPerception;
    const perceptionResult = perceptionBuilder(inboundContext || {}, {
      passive: false
    });
    const perceptionPrompt = String(perceptionResult?.text || '').trim() || null;

    try {
      if (routeExecutionPlan.unavailableReason && !downgradeUnavailableToDirectReply) {
        emitRouteDiag('dispatch_unavailable', buildRouteDiagPayload(routeExecutionPlan, 'unavailable'));
        maybeCaptureUnavailableFeatureRequest?.({
          routeExecutionPlan,
          cleanText,
          senderId,
          groupId,
          route
        });
        reply = buildUnavailableRouteReply(route, routeExecutionPlan, { isAdminUser });
      } else if (routeExecutionPlan.allowTools || routeExecutionPlan.executor === 'background_direct') {
        const dispatchBranch = routeExecutionPlan.executor === 'background_direct'
          ? 'background_direct'
          : 'tool_plan';
        emitRouteDiag('dispatch_branch_selected', buildRouteDiagPayload(routeExecutionPlan, dispatchBranch));
        const toolTaskOptions = {
          routePrompt: [toolGuidancePrompt, perceptionPrompt].filter(Boolean).join('\n\n') || null,
          sessionChannel: chatType === 'private' ? 'qq-private' : 'qq-group',
          sessionChatId: chatType === 'private' ? `direct_${senderId}` : `group_${groupId}_user_${senderId}`,
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          routeDebugKey: routeExecutionPlan.routeDebugKey,
          topRouteType: routeExecutionPlan.topRouteType,
          dispatchBranch,
          triggerBranch: `${dispatchBranch}.final_send`,
          allowTools: routeExecutionPlan.allowTools,
          allowedTools: routeExecutionPlan.allowedTools,
          imageUrls,
          plannerExecutionPlan: route?.meta?.toolPlanner?.executionPlan || route?.meta?.directChatPlanner?.executionPlan || null,
          disableDirectToolLoop: true,
          deferPersist: false,
          requestTrace: cloneTraceForMeta(requestTrace),
          routeMeta: buildRouteMetaEnvelope(route, routeExecutionPlan, route?.meta?.toolPlanner || route?.meta?.directChatPlanner || null, {
            groupId,
            chatType,
            dispatchBranch,
            requestTrace: cloneTraceForMeta(requestTrace)
          })
        };
        const fallbackModelConfig = resolveVisionFallbackModelConfig(route, imageUrl, senderId);
        if (fallbackModelConfig) {
          toolTaskOptions.modelConfig = fallbackModelConfig;
        }

        if (config.BACKGROUND_TOOL_TASKS_ENABLED && routeExecutionPlan.executor === 'background_direct') {
          const backgroundResult = await runBackgroundToolTask({
            route,
            routeExecutionPlan,
            cleanText,
            imageUrl,
            imageUrls,
            userInfo,
            senderId,
            groupId,
            toolTaskOptions
          });
          return buildReplyEnvelope(applyGroupDirectGuardToReplyEnvelopeInput({
            replyText: backgroundResult.reply || '',
            allowStream: false,
            atSender: true,
            routeContext: routeDecision,
            sendStrategy: backgroundResult.backgroundHandled ? 'background_ack' : 'standard',
            backgroundTaskState: {
              handled: Boolean(backgroundResult.backgroundHandled)
            }
          }, route, routeExecutionPlan, chatType, groupId));
        }

        const qzoneDraftMode = detectQzonePostDraftMode(route, cleanText);
        if (qzoneDraftMode === 'bot_diary') {
          const draftResult = await publishQzoneForContext({
            mode: 'bot_diary',
            hint: cleanText
          }, {
            userId: String(senderId || ''),
            routeMeta: {
              ...(route.meta || {}),
              userId: String(senderId || ''),
              groupId: String(groupId || '')
            }
          });
          reply = draftResult?.ok
            ? `已生成 QQ 空间 bot 日记草稿，未发布。\n\n内容：\n${draftResult.content}`
            : `生成 bot 日记草稿失败。\n\n原因：${draftResult?.reason || draftResult?.text || '未知错误'}`;
        } else if (qzoneDraftMode === 'generic_autodraft' || shouldAutoDraftQzonePostRequest?.(route, cleanText)) {
          const draftResult = await publishQzoneForContext({
            mode: 'agent',
            hint: cleanText
          }, {
            userId: String(senderId || ''),
            routeMeta: {
              ...(route.meta || {}),
              userId: String(senderId || ''),
              groupId: String(groupId || '')
            }
          }, {
            qzoneSource: 'generic_autodraft',
            qzoneType: 'generic_autodraft'
          });
          reply = draftResult?.ok
            ? `已生成 QQ 空间草稿，未发布。\n\n内容：\n${draftResult.content}`
            : `这次没能生成可发布的 QQ 空间草稿。\n\n原因：${draftResult?.reason || draftResult?.text || '未知错误'}`;
        } else {
          const toolThinkingEmojiStartedAt = Date.now();
          const toolThinkingEmojiApplied = await markThinkingEmojiBeforeLlm?.({
            messageId: String(inboundContext?.messageMeta?.messageId || input.sourceMessageId || '').trim(),
            routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
            routeMeta: route.meta || {},
            actionClient
          });
          inboundContext?.onEvent?.({
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            ts: Date.now(),
            type: 'thinking_emoji_done',
            node: 'pre_model',
            routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
            topRouteType: String(routeExecutionPlan?.topRouteType || '').trim(),
            reason: '',
            applied: Boolean(toolThinkingEmojiApplied),
            durationMs: Math.max(0, Date.now() - toolThinkingEmojiStartedAt)
          });
          const toolTaskStartedAt = Date.now();
          inboundContext?.onEvent?.({
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            ts: Date.now(),
            type: 'tool_task_local_start',
            node: 'pre_model',
            routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
            topRouteType: String(routeExecutionPlan?.topRouteType || '').trim()
          });
          reply = await askToolTaskLocally(cleanText, userInfo, senderId, null, imageUrl, toolTaskOptions);
          inboundContext?.onEvent?.({
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            ts: Date.now(),
            type: 'tool_task_local_done',
            node: 'pre_model',
            routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
            topRouteType: String(routeExecutionPlan?.topRouteType || '').trim(),
            durationMs: Math.max(0, Date.now() - toolTaskStartedAt)
          });
        }
      } else {
        emitRouteDiag('dispatch_branch_selected', buildRouteDiagPayload(routeExecutionPlan, 'direct_reply'));
        const streamingDispatcher = createStreamingDispatcher({
          runtimeConfig: config,
          sendWithRetry,
          chatType,
          groupId,
          userId: senderId,
          senderId,
          shouldSend: freshness && typeof freshness.shouldSend === 'function'
            ? freshness.shouldSend
            : null,
          telemetry: {
            onEvent: typeof inboundContext?.onEvent === 'function' ? inboundContext.onEvent : null
          }
        });
        const replyOptions = {
          onEvent: typeof inboundContext?.onEvent === 'function' ? inboundContext.onEvent : null,
          onDelta: streamingDispatcher.onDelta,
          streamHadOutput: false,
          streamCompleted: false,
          streamFallbackToNonStream: false,
          routePrompt: composeDirectRoutePrompt({
            toolGuidancePrompt,
            perceptionPrompt,
            safetyBoundaryRoutePrompt,
            streamingSegmentationPrompt,
            qqRichReplyPrompt
          }),
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          routeDebugKey: routeExecutionPlan.routeDebugKey,
          topRouteType: routeExecutionPlan.topRouteType,
          dispatchBranch: 'direct_reply',
          triggerBranch: 'direct_reply.final_send',
          disableTools: !routeExecutionPlan.allowTools,
          allowTools: routeExecutionPlan.allowTools,
          allowedTools: routeExecutionPlan.allowedTools,
          imageUrls,
          disableDirectToolLoop: true,
          routeMeta: buildRouteMetaEnvelope(route, routeExecutionPlan, route?.meta?.toolPlanner || route?.meta?.directChatPlanner || null, {
            groupId,
            chatType,
            messageId: String(inboundContext?.messageMeta?.messageId || input.sourceMessageId || '').trim(),
            threadId: String(inboundContext?.threadId || inboundContext?.messageMeta?.threadId || '').trim(),
            dispatchBranch: 'direct_reply',
            requestTrace: cloneTraceForMeta(requestTrace)
          }),
          requestTrace: cloneTraceForMeta(requestTrace),
          disableStream: disableStreamForReply || routeExecutionPlan.allowStream !== true,
          deferPersist: String(routeExecutionPlan?.topRouteType || '').trim().toLowerCase() === 'direct_chat',
          cotDisplayOnce,
          disableHumanizer: cotDisplayOnce,
          threadId: String(inboundContext?.threadId || inboundContext?.messageMeta?.threadId || '').trim()
        };
        const fallbackModelConfig = resolveVisionFallbackModelConfig(route, imageUrl, senderId);
        if (fallbackModelConfig) {
          replyOptions.modelConfig = fallbackModelConfig;
        }
        if (shouldForceDisableGroupMainModelStream({
          groupId,
          routeMeta: replyOptions.routeMeta,
          isQqGroup: chatType === 'group',
          isDirectMainModelReply: true
        })) {
          replyOptions.disableStream = true;
        }
        if (cotDisplayOnce) {
          replyOptions.disableStream = true;
        }
        finalReplyOptions = replyOptions;

        const normalGroupMainReplyLimit = normalGroupMainReplyRateLimiter
          && typeof normalGroupMainReplyRateLimiter.tryAcquire === 'function'
          ? normalGroupMainReplyRateLimiter.tryAcquire({
              userId: senderId,
              groupId,
              chatType,
              topRouteType: routeExecutionPlan.topRouteType,
              routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
              routeMeta: replyOptions.routeMeta
            }, { isAdminUser })
          : { allowed: true, limited: false };
        if (normalGroupMainReplyLimit?.limited) {
          const pokeSent = await sendRateLimitGroupPokeSafely({
            sendGroupPoke,
            sendWithRetry,
            groupId,
            senderId,
            source: 'direct_reply'
          });
          inboundContext?.onEvent?.({
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            ts: Date.now(),
            type: 'normal_group_main_reply_rate_limited',
            node: 'pre_model',
            routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
            topRouteType: String(routeExecutionPlan?.topRouteType || '').trim(),
            limit: Number(normalGroupMainReplyLimit.limit || 0) || 0,
            windowMs: Number(normalGroupMainReplyLimit.windowMs || 0) || 0,
            count: Number(normalGroupMainReplyLimit.count || 0) || 0,
            retryAfterMs: Number(normalGroupMainReplyLimit.retryAfterMs || 0) || 0,
            pokeSent: Boolean(pokeSent)
          });
          return buildReplyEnvelope({
            replyText: '',
            persistedReplyText: '',
            allowStream: false,
            atSender: false,
            routeContext: routeDecision,
            sendStrategy: 'rate_limit_poke',
            postActions: [],
            backgroundTaskState: null,
            replySegments: [],
            usedStreamingSend: false,
            replyOptions,
            freshness,
            finalErrorCode: NORMAL_GROUP_MAIN_REPLY_RPM_LIMITED_CODE,
            rateLimit: {
              limit: Number(normalGroupMainReplyLimit.limit || 0) || 0,
              windowMs: Number(normalGroupMainReplyLimit.windowMs || 0) || 0,
              count: Number(normalGroupMainReplyLimit.count || 0) || 0,
              retryAfterMs: Number(normalGroupMainReplyLimit.retryAfterMs || 0) || 0,
              pokeSent: Boolean(pokeSent)
            }
          });
        }

        const skipThinkingEmoji = isPrivateNoToolDirectReply(routeExecutionPlan, replyOptions, chatType);
        const thinkingEmojiStartedAt = Date.now();
        const thinkingEmojiApplied = skipThinkingEmoji
          ? false
          : await markThinkingEmojiBeforeLlm?.({
              messageId: String(inboundContext?.messageMeta?.messageId || input.sourceMessageId || '').trim(),
              routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
              routeMeta: route.meta || {},
              actionClient
            });
        inboundContext?.onEvent?.({
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          ts: Date.now(),
          type: skipThinkingEmoji ? 'thinking_emoji_skipped' : 'thinking_emoji_done',
          node: 'pre_model',
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          topRouteType: String(routeExecutionPlan?.topRouteType || '').trim(),
          reason: skipThinkingEmoji ? 'private_no_tool_direct_reply' : '',
          applied: Boolean(thinkingEmojiApplied),
          durationMs: Math.max(0, Date.now() - thinkingEmojiStartedAt)
        });
        reply = await askAIDispatch(cleanText, userInfo, senderId, null, imageUrl, replyOptions);
        persistedReplyText = String(replyOptions?.persistedReplyText || reply || '').trim();
        if (replyOptions.streamCompleted && replyOptions.streamHadOutput) {
          usedStreamingSend = true;
          const streamFinishStartedAt = Date.now();
          await streamingDispatcher.finish(reply);
          const streamStats = typeof streamingDispatcher.getStats === 'function'
            ? streamingDispatcher.getStats()
            : {};
          replyOptions.streamSendStats = {
            ...(streamStats && typeof streamStats === 'object' ? streamStats : {}),
            finishDurationMs: Math.max(0, Date.now() - streamFinishStartedAt)
          };
        }
      }
    } catch (dispatchErr) {
      console.error('[dispatch] failed:', {
        routeDebugKey: routeExecutionPlan?.routeDebugKey,
        policyKey: routeExecutionPlan?.policyKey,
        groupId,
        senderId,
        error: dispatchErr?.message || String(dispatchErr || '')
      });
      if (!String(reply || '').trim()) {
        reply = '刚刚处理到一半卡住了。等一下再丢给我试试。';
        persistedReplyText = reply;
        finalReplyOptions = finalReplyOptions
          ? { ...finalReplyOptions, deferPersist: false, __dispatchFailed: true }
          : { deferPersist: false, __dispatchFailed: true };
      }
    }

    return buildReplyEnvelope(applyGroupDirectGuardToReplyEnvelopeInput({
      replyText: reply,
      persistedReplyText: persistedReplyText || reply,
      allowStream: Boolean(routeExecutionPlan?.allowStream),
      atSender: true,
      routeContext: routeDecision,
      sendStrategy: usedStreamingSend ? 'stream' : 'standard',
      postActions: [],
      backgroundTaskState: null,
      replySegments: [],
      usedStreamingSend,
      replyOptions: finalReplyOptions,
      hasSafetyRestriction: finalReplyOptions?.hasSafetyRestriction === true,
      freshness
    }, route, routeExecutionPlan, chatType, groupId));
  }

  async function dispatchAdminRoute({
    route,
    groupId,
    senderId,
    rawText,
    userInfo,
    chatType = 'group'
  }) {
    const normalizedChatType = String(chatType || '').trim().toLowerCase() === 'private' ? 'private' : 'group';
    const cmd = route?.meta?.command?.cmd;
    const args = route?.meta?.command?.args || [];
    const adminContext = {
      userId: String(senderId || ''),
      routeMeta: {
        ...(route?.meta || {}),
        userId: String(senderId || ''),
        groupId: String(groupId || ''),
        chatType: normalizedChatType
      }
    };

    let adminReply = '';
    if (!hasAdminAccess(route, senderId)) {
      adminReply = '这个按钮现在只给管理员按哦。';
      await sendGroupReply({
        chatType: normalizedChatType,
        groupId,
        userId: senderId,
        senderId,
        replyText: adminReply,
        atSender: normalizedChatType !== 'private',
        retries: 1,
        waitMs: 500
      });
      return {
        handled: true,
        replyText: adminReply
      };
    }

    if (cmd === 'meme') {
      const memeAdminResult = await handleAdminCommand({
        rawText: route?.meta?.command?.raw || route?.cleanText || rawText,
        groupId,
        userId: senderId
      });
      adminReply = String(memeAdminResult?.replyText || '').trim() || 'meme 管理命令已处理。';
    } else if (cmd === 'memoryops') {
      const memoryOpsResult = await handleMemoryOpsAdminCommand({
        rawText: route?.meta?.command?.raw || route?.cleanText || rawText,
        groupId,
        userId: senderId
      });
      adminReply = String(memoryOpsResult?.replyText || '').trim() || 'memoryops 管理命令已处理。';
    } else if (cmd === 'group_summary') {
      if (normalizedChatType === 'private' || !String(groupId || '').trim()) {
        adminReply = '这个要在群里才接得住啦。';
      } else {
        const summaryResult = await generateGroupSummary({
          groupId,
          userId: senderId,
          botQQ: config.BOT_QQ,
          command: route?.meta?.command || {}
        });
        adminReply = String(summaryResult?.text || '').trim() || '群总结这次没生成稳。等一下再试一次吧。';
      }
    } else if (cmd === 'qzone_post') {
      const payload = parseJsonTail(route?.meta?.command?.payload);
      adminReply = (await publishQzoneForContext({
        content: payload.content,
        mode: payload.mode,
        hint: payload.hint
      }, adminContext)).text;
    } else if (cmd === 'schedule_create') {
      adminReply = (await handleQqScheduleAdminCommand(route?.meta?.command, adminContext)).text;
    } else if (cmd === 'schedule_list') {
      const scope = String(route?.meta?.command?.payload || '').trim().toLowerCase() === 'all' ? 'all' : 'mine';
      adminReply = listScheduledTasks(scope, adminContext).text;
    } else if (cmd === 'schedule_cancel') {
      adminReply = cancelScheduledTask(String(route?.meta?.command?.payload || '').trim(), adminContext).text;
    } else if (cmd === 'schedule_delete') {
      adminReply = deleteScheduledTask(String(route?.meta?.command?.payload || '').trim(), adminContext).text;
    } else if (cmd === 'learn_recent') {
      const limit = Math.max(1, Math.min(50, Number(route?.meta?.command?.args?.[0]) || 10));
      adminReply = formatEventsAsText(listRecentEvents(limit));
    } else if (cmd === 'learn_search') {
      const query = String(route?.meta?.command?.payload || '').trim();
      adminReply = query
        ? formatEventsAsText(searchEvents(query, { top_k: 5 }))
        : '用法: /learn search <query>';
    } else if (cmd === 'learn_patterns') {
      const limit = Math.max(1, Math.min(50, Number(route?.meta?.command?.args?.[0]) || 10));
      adminReply = formatPatternsAsText(listPatterns(limit));
    } else if (cmd === 'learn_rules') {
      const limit = Math.max(1, Math.min(50, Number(route?.meta?.command?.args?.[0]) || 10));
      adminReply = formatRulesAsText(listRules(limit));
    } else if (cmd === 'learn_guide') {
      const patternKey = String(route?.meta?.command?.payload || '').trim();
      adminReply = patternKey
        ? formatGuidesAsText(listGuides(10, { pattern_key: patternKey, active_only: true }))
        : '用法: /learn guide <pattern_key>';
    } else if (cmd === 'learn_style') {
      adminReply = formatStyleProfileAsText(groupId);
    } else if (cmd === 'learn_social') {
      adminReply = formatSocialContextAsText(groupId);
    } else if (cmd === 'learn_graph') {
      const targetUserId = String(route?.meta?.command?.args?.[0] || senderId || '').trim();
      adminReply = targetUserId
        ? formatRelationshipGraphAsText(targetUserId, { groupId, limit: 5 })
        : '用法: /learn graph <userId>';
    } else if (cmd === 'learn' || cmd === 'learn_unknown') {
      adminReply = '用法: /learn recent [limit], /learn search <query>, /learn patterns [limit], /learn rules [limit], /learn guide <pattern_key>, /learn style, /learn social, /learn graph <userId>';
    } else if (cmd === 'group_public') {
      adminReply = handleGroupPublicAdminCommand(route?.meta?.command, groupId, senderId);
    } else if (cmd === 'main_stream') {
      adminReply = handleMainStreamAdminCommand(route?.meta?.command, groupId, senderId);
    } else if (cmd === 'help') {
      adminReply = '可用命令: /check, /群总结 [条数], /create <prompt>, /debug runtime|hotspots|replydiag|replyprompt|replycache|replytrunc|provider, /status, /reload, /memoryops diagnose|backfill|recall, /learn recent [limit], /learn search <query>, /learn patterns [limit], /learn rules [limit], /learn guide <pattern_key>, /learn style, /learn social, /learn graph <userId>, /group_public on|off|status, /main_stream on|off|status, /meme ..., /qzone_post {...}, /schedule_create {...}, /schedule_list [all], /schedule_cancel <jobId>, /schedule_delete <jobId>';
    } else if (cmd === 'check') {
      adminReply = formatModelSelfCheckReport(await runModelSelfCheck({
        adminUserId: senderId,
        normalUserId: '__model_self_check_user__'
      }));
    } else if (cmd === 'status') {
      adminReply = '状态命令已收到。';
    } else if (cmd === 'reload') {
      adminReply = '重载命令已收到。';
    } else if (cmd === 'debug') {
      const subcmd = String(args[0] || '').trim().toLowerCase();
      if (subcmd === 'replycache' || subcmd === 'main-reply-cache' || subcmd === 'cache-stats') {
        adminReply = JSON.stringify(buildCacheStatsDiagnostic(), null, 2);
      } else if (subcmd === 'replytrunc' || subcmd === 'reply-truncation' || subcmd === 'truncation' || subcmd === 'truncated') {
        const limit = Math.max(1, Math.min(200, Number(args[1] || 50) || 50));
        adminReply = JSON.stringify(buildMainReplyTruncationDiagnostic({ limit }), null, 2);
      } else if (subcmd === 'runtime' || subcmd === 'status' || subcmd === 'daemon') {
        adminReply = JSON.stringify(buildRuntimeStatusDiagnostic(), null, 2);
      } else if (subcmd === 'hotspots' || subcmd === 'hotspot' || subcmd === 'resources' || subcmd === 'resource') {
        adminReply = JSON.stringify(buildRuntimeHotspotsDiagnostic(), null, 2);
      } else if (subcmd === 'replydiag' || subcmd === 'main-reply' || subcmd === 'reply') {
        const payload = args.slice(1).join(' ').trim();
        const parsed = parseMainReplyDiagnosticInput(payload || rawText || '');
        const report = await buildMainReplyDiagnosticReport({
          ...parsed,
          rawText: parsed.rawText || parsed.text || parsed.requestText || payload || rawText,
          requestText: parsed.requestText || parsed.cleanText || parsed.text || payload || rawText,
          userId: parsed.userId || senderId,
          groupId: parsed.groupId || groupId,
          chatType: parsed.chatType || normalizedChatType,
          plannerMode: parsed.plannerMode || 'rule'
        });
        adminReply = JSON.stringify(report, null, 2);
      } else if (subcmd === 'replyprompt' || subcmd === 'prompt-assembly' || subcmd === 'system-prompt') {
        const payload = args.slice(1).join(' ').trim();
        const parsed = parseMainReplyDiagnosticInput(payload || rawText || '');
        const requestId = String(parsed.requestId || parsed.request_id || '').trim()
          || (/^req_[A-Za-z0-9_-]+$/.test(payload) ? payload : '');
        const report = await buildMainReplyPromptAssemblyDiagnostic({
          ...parsed,
          ...(requestId ? { requestId } : {}),
          rawText: parsed.rawText || parsed.text || parsed.requestText || payload || rawText,
          requestText: parsed.requestText || parsed.cleanText || parsed.text || payload || rawText,
          userId: parsed.userId || senderId,
          groupId: parsed.groupId || groupId,
          chatType: parsed.chatType || normalizedChatType
        });
        adminReply = JSON.stringify(report, null, 2);
      } else if (subcmd === 'provider' || subcmd === 'provider-request' || subcmd === 'providerdiag') {
        const report = await runProviderRequestDiagnostics(parseProviderDiagnosticArgs(args.slice(1)));
        adminReply = JSON.stringify(report, null, 2);
      } else {
        adminReply = `debug 参数: ${args.join(' ') || '无'}`;
      }
    } else {
      adminReply = '这个管理员命令我没认出来。发 /help 看看能用哪些吧。';
    }

    await sendGroupReply({
      chatType: normalizedChatType,
      groupId,
      userId: senderId,
      senderId,
      replyText: adminReply,
      atSender: normalizedChatType !== 'private',
      retries: 1,
      waitMs: 500
    });

    return {
      handled: true,
      replyText: adminReply
    };
  }

  return {
    dispatchAdminRoute,
    dispatchByRoutePlan,
    dispatchFormalRoute: dispatchByRoutePlan,
    handleBackgroundTaskControl,
    handleBackgroundControl: handleBackgroundTaskControl
  };
}

module.exports = {
  buildQzoneAutodraftPrompt,
  buildUnavailableRouteReply,
  buildSupplementedTaskText,
  createMessageRouteFlow
};
