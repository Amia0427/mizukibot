      appendTraceTiming('final_reply_send_start', {
        stage: 'final_reply_send_start',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        replyChars: Array.from(String(replyEnvelope?.replyText || reply || '')).length,
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
      const sent = await sendGroupReply({
        chatType,
        groupId,
        userId: senderId,
        senderId,
        replyText: replyEnvelope?.replyText || reply,
        atSender: !isPrivateChatType(chatType) && replyEnvelope?.atSender !== false,
        retries: 2,
        waitMs: 500,
        shouldSend: freshnessGuard.shouldSend,
        telemetry: buildReplyTelemetry({
          senderId,
          groupId: isPrivateChatType(chatType) ? '' : groupId,
          chatType,
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          topRouteType: routeExecutionPlan.topRouteType,
          routeMeta: buildRouteMetaEnvelope(route, routeExecutionPlan, route?.meta?.toolPlanner || route?.meta?.directChatPlanner || null, {
            threadId: String(replyOptions?.threadId || inboundContext?.threadId || inboundContext?.messageMeta?.threadId || '').trim(),
            messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
            requestTrace: cloneTraceForMeta(requestTrace)
          })
        })
      });
      appendTraceTiming('final_reply_send_done', {
        stage: 'final_reply_send_done',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        sent: Boolean(sent),
        durationMs: Math.max(0, Date.now() - sendStartedAt),
        finalErrorCode: sent ? '' : 'reply_send_failed',
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
      if (sent) {
        maybeRunDeferredPersist(replyEnvelope);
        markDirectSessionPresenceReplied({ groupId, senderId });
        replyRuntime.recordBotReply({
          chatType,
          groupId: isPrivateChatType(chatType) ? '' : groupId,
          senderId,
          replyText: persistedReplyText || reply
        });
        if (!isPrivateChatType(chatType)) {
          await sideEffects.runDirectReplyFollowup({
            groupId,
            senderId,
            sendWithRetry,
            routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
            topRouteType: routeExecutionPlan.topRouteType,
            userText: persistUserText || cleanText,
            replyText: persistedReplyText || reply,
            rawMessage: rawText,
            routeMeta: route.meta || {},
            replyToMessageId: String(effectiveMsg.message_id || '').trim()
          });
        }
      }
    } else {
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
          stream: true,
          finalErrorCode: 'stale_reply_discarded'
        });
        return;
      }
      appendTraceTiming('final_reply_send_done', {
        stage: 'final_reply_send_done',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        sent: true,
        stream: true,
        streamCompleted: replyOptions?.streamCompleted === true,
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
      maybeRunDeferredPersist(replyEnvelope);
      if (!isPrivateChatType(chatType)) {
        await sideEffects.runDirectReplyFollowup({
          groupId,
          senderId,
          sendWithRetry,
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          topRouteType: routeExecutionPlan.topRouteType,
          userText: persistUserText || cleanText,
          replyText: replyOptions?.streamCompleted ? (persistedReplyText || reply) : '',
          rawMessage: rawText,
          routeMeta: route.meta || {},
          replyToMessageId: String(effectiveMsg.message_id || '').trim()
        });
      }
    }
    appendRequestCompleteTrace({
      routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
      topRouteType: routeExecutionPlan.topRouteType,
      sent: true,
      stream: usedStreamingSend,
      finalErrorCode: ''
    });
    } catch (error) {
      inboundHadError = true;
      appendTraceTiming('inbound_handler_failed', {
        stage: 'inbound_handler_failed',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
        durationMs: Math.max(0, Date.now() - handlerStartedAt),
        finalErrorCode: extractErrorCode(error),
        error: error?.message || String(error || ''),
        stack: String(error?.stack || '').split('\n').slice(0, 4).join(' | ')
      });
      appendRequestCompleteTrace({
        sent: false,
        finalErrorCode: extractErrorCode(error),
        error: error?.message || String(error || '')
      });
      throw error;
    } finally {
      inboundLock.release({ hadError: inboundHadError });
    }
  }

  async function sendScheduledGreeting(type) {
    return proactiveGreetingFlow.sendScheduledGreeting(type);
  }

  return {
    handleIncomingMessage,
    sendScheduledGreeting,
    getDatePartsInTz
  };
}

