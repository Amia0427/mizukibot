      groupId: String(groupId || '').trim(),
      userId: String(senderId || '').trim(),
      chatType,
      durationMs: Math.max(0, Date.now() - routeResolverStartedAt),
      rawMessageTimestampMs,
      elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
      lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
      topRouteType: String(route?.topRouteType || '').trim(),
      routeReason: String(route?.meta?.reason || '').trim(),
      routeResolverFailed: Boolean(routeResolverError)
    });
    route.meta = {
      ...(route.meta || {}),
      requestTrace: cloneTraceForMeta(requestTrace),
      userId: String(senderId || ''),
      groupId: isPrivateChatType(chatType) ? '' : String(groupId || ''),
      chatType,
      directedContext,
      directedContextSummary: routerContextSummary,
      effectiveIntentText: runtimeQuestionText,
      quotePriority: directedContext?.quotePriority || null
    };
    if (visualContext) {
      route.meta.visualContext = visualContext;
      route.meta.imageUrls = effectiveVisualInputUrls;
      route.meta.persistUserText = persistUserText;
      route.meta.originalUserText = originalUserText;
    }
    if (visualContext?.worker?.succeeded) {
      route.question = runtimeQuestionText;
      route.cleanText = runtimeQuestionText;
      route.imageUrl = null;
    }

    if (route?.topRouteType === 'direct_chat') {
      const normalFastRoutePlan = {
        executor: 'direct',
        topRouteType: 'direct_chat',
        policyKey: 'chat/default',
        routeDebugKey: 'direct_chat/text_chat/answer',
        allowTools: false,
        allowedTools: [],
        allowedToolBuckets: [],
        allowStream: false,
        needsBackground: false,
        unavailableReason: ''
      };
      const normalFastDecision = buildNormalFastReplyDecision({
        userId: senderId,
        cleanText: route?.cleanText || runtimeQuestionText || effectiveCleanText || rawText,
        rawText,
        route,
        routeExecutionPlan: normalFastRoutePlan,
        imageUrl: visualContext?.worker?.succeeded ? null : (effectiveVisualInput || route?.imageUrl || ''),
        imageUrls: visualContext?.worker?.succeeded ? [] : effectiveVisualInputUrls,
        visualContext
      }, config, { isAdminUser });
      if (normalFastDecision.eligible) {
        const normalFastStartedAt = Date.now();
        try {
          const fastGroupId = isPrivateChatType(chatType) ? '' : groupId;
          const normalFastLimit = normalGroupMainReplyRateLimiter.tryAcquire({
            userId: senderId,
            groupId: fastGroupId,
            chatType,
            topRouteType: 'direct_chat'
          }, { isAdminUser });
          if (normalFastLimit.limited) {
            const pokeSent = await sendRateLimitGroupPoke(fastGroupId, senderId, {
              source: 'normal_fast_reply'
            });
            appendTraceTiming('normal_fast_reply_rate_limited', {
              stage: 'normal_fast_reply_rate_limited',
              messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
              groupId: String(fastGroupId || '').trim(),
              userId: String(senderId || '').trim(),
              chatType,
              limit: Number(normalFastLimit.limit || 0) || 0,
              windowMs: Number(normalFastLimit.windowMs || 0) || 0,
              count: Number(normalFastLimit.count || 0) || 0,
              retryAfterMs: Number(normalFastLimit.retryAfterMs || 0) || 0,
              pokeSent: Boolean(pokeSent),
              durationMs: Math.max(0, Date.now() - normalFastStartedAt),
              finalErrorCode: NORMAL_GROUP_MAIN_REPLY_RPM_LIMITED_CODE
            });
            appendRequestCompleteTrace({
              routePolicyKey: 'chat/default',
              topRouteType: 'direct_chat',
              replyPath: 'normal_fast_reply',
              sent: Boolean(pokeSent),
              stream: false,
              finalErrorCode: NORMAL_GROUP_MAIN_REPLY_RPM_LIMITED_CODE
            });
            return;
          }
          const normalFastReplyResult = await runNormalFastReply({
            userId: senderId,
            routeMeta: {
              ...(route.meta || {}),
              userId: String(senderId || '').trim(),
              groupId: String(fastGroupId || '').trim(),
              chatType,
              routePolicyKey: 'chat/default',
              routeDebugKey: 'direct_chat/text_chat/answer',
              topRouteType: 'direct_chat',
              threadId: stableThreadId,
              messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
              requestTrace: cloneTraceForMeta(requestTrace)
            },
            text: runtimeQuestionText || normalFastDecision.text,
            route,
            chatHistory,
            sessionKey
          });
          let fastReplyText = String(normalFastReplyResult?.replyText || '').trim();
          if (!fastReplyText) throw new Error('normal_fast_reply_empty');
          if (!freshnessGuard.shouldSend()) {
            appendTraceTiming('normal_fast_reply_stale', {
              stage: 'normal_fast_reply_stale',
              messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
              groupId: String(groupId || '').trim(),
              userId: String(senderId || '').trim(),
              chatType,
              durationMs: Math.max(0, Date.now() - normalFastStartedAt),
              sessionKey: String(freshnessGuard.sessionKey || '').trim(),
              flushVersion: Number(freshnessGuard.flushVersion || 0) || 0
            });
            appendRequestCompleteTrace({
              routePolicyKey: 'chat/default',
              topRouteType: 'direct_chat',
              replyPath: 'normal_fast_reply',
              sent: false,
              finalErrorCode: 'stale_reply_discarded'
            });
            return;
          }
          fastReplyText = normalizeUserFacingReply(fastReplyText, {
            policyKey: 'chat/default',
            routeDebugKey: 'direct_chat/text_chat/answer',
            topRouteType: 'direct_chat',
            allowTools: false,
            requestText: runtimeQuestionText || normalFastDecision.text
          });
          appendTraceTiming('normal_fast_reply_send_start', {
            stage: 'normal_fast_reply_send_start',
            messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
            groupId: String(groupId || '').trim(),
            userId: String(senderId || '').trim(),
            chatType,
            replyChars: Array.from(fastReplyText).length,
            recentMessageCount: Number(normalFastReplyResult?.recentMessageCount || 0) || 0,
            summaryChars: Number(normalFastReplyResult?.summaryChars || 0) || 0
          });
          const sent = await sendGroupReply({
            chatType,
            groupId,
            userId: senderId,
            senderId,
            replyText: fastReplyText,
            atSender: !isPrivateChatType(chatType),
            retries: 2,
            waitMs: 500,
            telemetry: buildReplyTelemetry({
              senderId,
              groupId: fastGroupId,
              chatType,
              routePolicyKey: 'chat/default',
              topRouteType: 'direct_chat',
              routeMeta: buildRouteMetaEnvelope(route, normalFastRoutePlan, null, {
                threadId: stableThreadId,
                messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
                requestTrace: cloneTraceForMeta(requestTrace),
                replyPath: 'normal_fast_reply'
              })
            })
          });
          appendTraceTiming('normal_fast_reply_send_done', {
            stage: 'normal_fast_reply_send_done',
            messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
            groupId: String(groupId || '').trim(),
            userId: String(senderId || '').trim(),
            chatType,
            sent: Boolean(sent),
            durationMs: Math.max(0, Date.now() - normalFastStartedAt),
            finalErrorCode: sent ? '' : 'reply_send_failed'
          });
          if (!sent) {
            console.warn('[normal-fast-reply] send failed, fallback to formal route');
          } else {
            if (!isPrivateChatType(chatType)) {
              sideEffects.recordInboundHumanMessage({
                groupId,
                senderId,
                senderName: String(effectiveMsg.sender?.card || effectiveMsg.sender?.nickname || effectiveMsg.sender?.nick || senderId || '').trim(),
                text: persistUserText || normalFastDecision.text || rawText,
                timestamp: Number(continuousMeta?.firstTimestamp || Date.now()),
                messageId: String(effectiveMsg.message_id || '').trim(),
                replyToMessageId: String(directedContext?.quote?.messageId || continuousMeta?.replyMessageId || '').trim(),
                replyToSenderId: String(directedContext?.quote?.senderId || '').trim(),
                replyToSenderName: String(directedContext?.quote?.senderName || '').trim()
              });
            }
            const normalFastUserInfo = sideEffects.updateUserPresence(
              senderId,
              persistUserText || normalFastDecision.text,
              fastGroupId
            );
            const persistedFastReplyText = String(normalFastReplyResult?.persistedReplyText || fastReplyText).trim() || fastReplyText;
            await maybeSendReasoningForward({
              reasoningForwardText: String(normalFastReplyResult?.reasoningForwardText || '').trim()
            }, {
              chatType,
              groupId: fastGroupId,
              userId: senderId,
              senderId
            });
            if (normalFastReplyResult?.hasSafetyRestriction === true) {
              const sourceMessageId = String(effectiveMsg.message_id || msg.message_id || '').trim();
              if (sourceMessageId) {
                markSafetyRestrictionEmojiAfterReply({
                  messageId: sourceMessageId,
                  routePolicyKey: 'chat/default',
                  routeMeta: {
                    ...(route.meta || {}),
                    groupId: String(fastGroupId || '').trim(),
                    userId: String(senderId || '').trim(),
                    chatType,
                    replyPath: 'normal_fast_reply'
                  },
                  actionClient: globalNapCatActionClient
                }).catch((error) => {
                  console.warn('[safety-restriction-emoji] mark failed', {
                    messageId: sourceMessageId,
                    error: error?.message || String(error || '')
                  });
                });
              }
            }
            appendShortTermHistory(
              senderId,
              persistUserText || normalFastDecision.text,
              persistedFastReplyText,
              normalFastUserInfo || {},
              {
                chatHistory,
                shortTermMemory,
                routeMeta: {
                  ...(route.meta || {}),
                  groupId: fastGroupId,
                  chatType
                },
                sessionKey
              }
            );
            saveData();
            markDirectSessionPresenceReplied({ groupId: fastGroupId, senderId });
            replyRuntime.recordBotReply({
              chatType,
              groupId: fastGroupId,
              senderId,
              replyText: persistedFastReplyText
            });
            if (!isPrivateChatType(chatType)) {
              await sideEffects.runDirectReplyFollowup({
                groupId,
                senderId,
                sendWithRetry,
                routePolicyKey: 'chat/default',
                topRouteType: 'direct_chat',
                userText: persistUserText || normalFastDecision.text,
                replyText: persistedFastReplyText,
                rawMessage: rawText,
                routeMeta: {
                  ...(route.meta || {}),
                  replyPath: 'normal_fast_reply'
                },
                replyToMessageId: String(effectiveMsg.message_id || '').trim()
              });
            }
            appendRequestCompleteTrace({
              routePolicyKey: 'chat/default',
              topRouteType: 'direct_chat',
              replyPath: 'normal_fast_reply',
              sent: true,
              stream: false,
              finalErrorCode: ''
            });
            return;
          }
        } catch (error) {
          appendTraceTiming('normal_fast_reply_failed', {
            stage: 'normal_fast_reply_failed',
            messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
            groupId: String(groupId || '').trim(),
            userId: String(senderId || '').trim(),
            chatType,
            durationMs: Math.max(0, Date.now() - normalFastStartedAt),
            finalErrorCode: extractErrorCode(error),
            error: error?.message || String(error || '')
          });
          console.warn('[normal-fast-reply] failed, fallback to formal route:', error?.message || error);
        }
      } else {
        appendTraceTiming('normal_fast_reply_skipped', {
          stage: 'normal_fast_reply_skipped',
          messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
          groupId: String(groupId || '').trim(),
          userId: String(senderId || '').trim(),
          chatType,
          reason: String(normalFastDecision.reason || '').trim()
        });
      }
    }

    if (route?.topRouteType === 'direct_chat') {
      const plannerStartedAt = Date.now();
      let plannerDecision = null;
      try {
        appendTraceTiming('planner_start', {
          stage: 'direct_chat_planner_start',
          messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
          groupId: String(groupId || '').trim(),
          userId: String(senderId || '').trim(),
          chatType,
          topRouteType: String(route?.topRouteType || '').trim(),
          rawMessageTimestampMs,
          elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
          lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
        });
        plannerDecision = await planDirectChat(route, {
          userId: senderId,
          allowedTools: route?.meta?.allowedTools,
          contextSummary: plannerContextSummary,
          directedContext,
          continuitySignals: route?.meta?.continuitySignals || inboundContext?.continuitySignals || {},
          memoryContext: inboundContext?.memoryContext || route?.meta?.memoryContext || {},
          availableContextSignals: route?.meta?.availableContextSignals || inboundContext?.availableContextSignals || {},
          personaModuleCatalog: route?.meta?.personaModuleCatalog || [],
          dynamicPromptBlockCatalog: route?.meta?.dynamicPromptBlockCatalog || [],
          dynamicPromptGuide: route?.meta?.dynamicPromptGuide || '',
          dynamicFewShotPrompt: inboundContext?.dynamicFewShotPrompt || route?.meta?.dynamicFewShotPrompt || '',
          mainReplyPromptMode: inboundContext?.mainReplyPromptMode || route?.meta?.mainReplyPromptMode || '',
          memoryCliTurn: inboundContext?.memoryCliTurn || route?.meta?.memoryCliTurn || {},
          schedulerInjection: inboundContext?.schedulerInjection || route?.meta?.schedulerInjection || route?.meta?.lifeSchedulerInjection || '',
          sharedShortTermContext: inboundContext?.sharedShortTermContext || route?.meta?.sharedShortTermContext || {},
          personaMemoryState: inboundContext?.personaMemoryState || route?.meta?.personaMemoryState || {},
          userInfo: inboundContext?.userInfo || {},
          requestTrace: cloneTraceForMeta(requestTrace)
        });
      } catch (error) {
        appendTraceTiming('planner_failed', {
          stage: 'direct_chat_planner_failed',
          messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
          groupId: String(groupId || '').trim(),
          userId: String(senderId || '').trim(),
          chatType,
          durationMs: Math.max(0, Date.now() - plannerStartedAt),
          rawMessageTimestampMs,
          elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
          lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
          finalErrorCode: extractErrorCode(error),
          error: error?.message || String(error || '')
        });
        throw error;
      }
      appendTraceTiming('planner_done', {
        stage: 'direct_chat_planner_done',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        durationMs: Math.max(0, Date.now() - plannerStartedAt),
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
        shouldUseTools: plannerDecision?.shouldUseTools === true,
        needsBackground: plannerDecision?.needsBackground === true,
        plannerFallbackUsed: plannerDecision?.plannerFallbackUsed === true,
        plannerModel: String(plannerDecision?.plannerModel || '').trim(),
        allowedToolCount: Array.isArray(plannerDecision?.allowedToolNames) ? plannerDecision.allowedToolNames.length : 0
      });
      route.meta = {
        ...(route.meta || {}),
        toolPlanner: plannerDecision,
        directChatPlanner: plannerDecision
      };
    }

    const routeExecutionStartedAt = Date.now();
    let routeExecutionPlan = null;
    try {
      routeExecutionPlan = routeExecution.resolveRouteExecution(route, config, {});
      appendTraceTiming('route_execution_done', {
        stage: 'route_execution_done',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        durationMs: Math.max(0, Date.now() - routeExecutionStartedAt),
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
    } catch (error) {
      routeExecutionPlan = {
        executor: 'direct',
        topRouteType: 'direct_chat',
        policyKey: 'chat/default',
        routeDebugKey: 'direct_chat/text_chat/answer',
        allowTools: false,
        allowedTools: [],
        allowedToolBuckets: [],
        allowStream: !route?.imageUrl && !['image_qa', 'image_summary'].includes(String(route?.meta?.chatMode || '').trim().toLowerCase()),
        needsBackground: false,
        unavailableReason: 'route-execution-failed'
      };
      appendTraceTiming('route_execution_failed', {
        stage: 'route_execution_failed',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        durationMs: Math.max(0, Date.now() - routeExecutionStartedAt),
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
        finalErrorCode: extractErrorCode(error),
        error: error?.message || String(error || '')
      });
      console.error('[routeExecution] resolve failed, fallback to direct chat:', error?.message || error);
    }
    if (routeExecutionPlan.executor === 'ignore') {
      logMemoryWriteSkip('route_executor_ignore', {
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
      appendTraceTiming('route_execution_ignored', {
        stage: 'route_execution_ignored',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
      return;
    }

    if (routeExecutionPlan.executor === 'refuse') {
      await sendGroupReply({
        chatType,
        groupId,
        userId: senderId,
        senderId,
        replyText: await buildRefusalReply(route),
        atSender: !isPrivateChatType(chatType),
        retries: 1,
        waitMs: 500
      });
      logMemoryWriteSkip('route_executor_refuse', {
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
      return;
    }

    if (routeExecutionPlan.executor === 'admin') {
      appendTraceTiming('admin_route_dispatch_start', {
        stage: 'admin_route_dispatch_start',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        command: String(route?.meta?.command?.cmd || '').trim(),
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
      await routeFlow.dispatchAdminRoute({
        route,
        groupId,
        senderId,
        rawText,
        userInfo: null,
        chatType
      });
      appendTraceTiming('admin_route_dispatch_done', {
        stage: 'admin_route_dispatch_done',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        command: String(route?.meta?.command?.cmd || '').trim(),
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
      appendTraceTiming('final_reply_send_done', {
        stage: 'final_reply_send_done',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        sent: true,
        replyPath: 'admin_route',
        command: String(route?.meta?.command?.cmd || '').trim(),
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
      logMemoryWriteSkip('route_executor_admin', {
        command: String(route?.meta?.command?.cmd || '').trim(),
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
      appendRequestCompleteTrace({
        routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
        topRouteType: routeExecutionPlan.topRouteType,
        sent: true,
        command: String(route?.meta?.command?.cmd || '').trim()
      });
      return;
    }

    const cleanText = String(route?.cleanText || effectiveCleanText || rawText || '').trim();
    const imageUrl = visualContext?.worker?.succeeded ? null : (effectiveVisualInput || route?.imageUrl || '');
    const imageUrls = visualContext?.worker?.succeeded ? [] : effectiveVisualInputUrls;
    if (route && typeof route === 'object') route.imageUrl = imageUrl;
    const inboundTimestamp = Date.now();
    const correctionStartedAt = Date.now();
    try {
      appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
        stage: 'capture_correction_start',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
      });
      maybeCaptureUserCorrection({
        cleanText,
        signalText: effectiveCleanText,
        senderId,
        groupId,
        routeExecutionPlan,
        getLastAssistantReply: getLastAssistantReplyForSession
      });
    } catch (error) {
      appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
        stage: 'capture_correction_failed',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        durationMs: Math.max(0, Date.now() - correctionStartedAt),
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
        error: error?.message || String(error || '')
      });
      console.error('[self-improvement] correction capture scheduling failed:', error?.message || error);
    }
    appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
      stage: 'capture_correction_done',
      messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
      groupId: String(groupId || '').trim(),
      userId: String(senderId || '').trim(),
      chatType,
      durationMs: Math.max(0, Date.now() - correctionStartedAt),
      rawMessageTimestampMs,
      elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
      lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
    });

    if (!isPrivateChatType(chatType)) {
      const groupSideEffectsStartedAt = Date.now();
      try {
        sideEffects.recordInboundHumanMessage({
          groupId,
          senderId,
          senderName: String(effectiveMsg.sender?.card || effectiveMsg.sender?.nickname || effectiveMsg.sender?.nick || senderId || '').trim(),
          text: persistUserText || cleanText || rawText,
          timestamp: Number(continuousMeta?.firstTimestamp || inboundTimestamp),
          messageId: String(effectiveMsg.message_id || '').trim(),
          replyToMessageId: String(directedContext?.quote?.messageId || continuousMeta?.replyMessageId || '').trim(),
          replyToSenderId: String(directedContext?.quote?.senderId || '').trim(),
          replyToSenderName: String(directedContext?.quote?.senderName || '').trim()
        });
        appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
          stage: 'group_side_effects_done',
          messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
          groupId: String(groupId || '').trim(),
          userId: String(senderId || '').trim(),
          chatType,
          durationMs: Math.max(0, Date.now() - groupSideEffectsStartedAt),
          rawMessageTimestampMs,
          elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
          lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
        });
      } catch (error) {
        appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
          stage: 'group_side_effects_failed',
          messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
          groupId: String(groupId || '').trim(),
          userId: String(senderId || '').trim(),
          chatType,
          durationMs: Math.max(0, Date.now() - groupSideEffectsStartedAt),
          rawMessageTimestampMs,
          elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
          lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
          error: error?.message || String(error || '')
        });
        console.error('[message] group side effects failed:', error?.message || error);
      }
    }

    const userPresenceStartedAt = Date.now();
    let userInfo = null;
    try {
      userInfo = sideEffects.updateUserPresence(senderId, persistUserText || cleanText, isPrivateChatType(chatType) ? '' : groupId);
      appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
        stage: 'user_presence_done',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        durationMs: Math.max(0, Date.now() - userPresenceStartedAt),
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
      });
    } catch (error) {
      appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
        stage: 'user_presence_failed',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        durationMs: Math.max(0, Date.now() - userPresenceStartedAt),
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
        error: error?.message || String(error || '')
      });
      console.error('[message] user presence update failed:', error?.message || error);
      userInfo = {};
    }

    const formalDispatchStartedAt = Date.now();
    appendTraceTiming('runtime_dispatch_start', {
      stage: 'formal_route_dispatch_start',
      messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
      groupId: String(groupId || '').trim(),
      userId: String(senderId || '').trim(),
      chatType,
      rawMessageTimestampMs,
      elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
      lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
    });
    let replyEnvelope = null;
    try {
      replyEnvelope = await routeFlow.dispatchFormalRoute({
        route,
        executionPlan: routeExecutionPlan,
        requestText: runtimeQuestionText || cleanText,
        inboundContext,
        userInfo,
        senderId,
        groupId: isPrivateChatType(chatType) ? '' : groupId,
        imageUrl,
        imageUrls,
        sourceMessageId: String(effectiveMsg.message_id || '').trim(),
        freshness: freshnessGuard
      });
      appendTraceTiming('runtime_dispatch_done', {
        stage: 'formal_route_dispatch_done',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        durationMs: Math.max(0, Date.now() - formalDispatchStartedAt),
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
    } catch (error) {
      appendTraceTiming('runtime_dispatch_failed', {
        stage: 'formal_route_dispatch_failed',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        durationMs: Math.max(0, Date.now() - formalDispatchStartedAt),
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
        finalErrorCode: extractErrorCode(error),
        error: error?.message || String(error || ''),
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
      throw error;
    }
    let reply = String(replyEnvelope?.replyText || '').trim();
    const persistedReplyText = String(replyEnvelope?.persistedReplyText || replyEnvelope?.replyText || '').trim();
    const usedStreamingSend = Boolean(replyEnvelope?.sendStrategy === 'stream' || replyEnvelope?.usedStreamingSend);
    const replyOptions = replyEnvelope?.replyOptions || null;
    if (
      replyEnvelope?.sendStrategy === 'rate_limit_poke'
      || String(replyEnvelope?.finalErrorCode || '').trim() === NORMAL_GROUP_MAIN_REPLY_RPM_LIMITED_CODE
    ) {
      appendTraceTiming('formal_route_rate_limited', {
        stage: 'formal_route_rate_limited',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        limit: Number(replyEnvelope?.rateLimit?.limit || 0) || 0,
        windowMs: Number(replyEnvelope?.rateLimit?.windowMs || 0) || 0,
        count: Number(replyEnvelope?.rateLimit?.count || 0) || 0,
        retryAfterMs: Number(replyEnvelope?.rateLimit?.retryAfterMs || 0) || 0,
        pokeSent: Boolean(replyEnvelope?.rateLimit?.pokeSent),
        durationMs: Math.max(0, Date.now() - formalDispatchStartedAt),
        finalErrorCode: NORMAL_GROUP_MAIN_REPLY_RPM_LIMITED_CODE,
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
      appendRequestCompleteTrace({
        routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
        topRouteType: routeExecutionPlan.topRouteType,
        sent: Boolean(replyEnvelope?.rateLimit?.pokeSent),
        stream: false,
        finalErrorCode: NORMAL_GROUP_MAIN_REPLY_RPM_LIMITED_CODE
      });
      return;
    }
    if (!usedStreamingSend) {
      if (!freshnessGuard.shouldSend()) {
        appendTraceTiming('final_reply_discarded_stale', {
          stage: 'reply_discarded_stale',
          messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
          groupId: String(groupId || '').trim(),
          userId: String(senderId || '').trim(),
          chatType,
          sessionKey: String(freshnessGuard.sessionKey || '').trim(),
          flushVersion: Number(freshnessGuard.flushVersion || 0) || 0,
          ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
        });
        appendRequestCompleteTrace({
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          topRouteType: routeExecutionPlan.topRouteType,
          sent: false,
          finalErrorCode: 'stale_reply_discarded'
        });
        return;
      }
      reply = normalizeUserFacingReply(reply, {
        policyKey: getEffectivePolicyKey(routeExecutionPlan),
        routeDebugKey: routeExecutionPlan.routeDebugKey,
        topRouteType: routeExecutionPlan.topRouteType,
        allowTools: routeExecutionPlan.allowTools,
        requestText: runtimeQuestionText || cleanText
      });
      console.log('[reply] sending normalized reply', {
        chatType,
        groupId,
        senderId,
        routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          topRouteType: routeExecutionPlan.topRouteType,
          replyPreview: String(reply || '').slice(0, 120)
        });
      const sendStartedAt = Date.now();
