          question,
          plan,
          workerResults,
          userInfo,
          userId,
          imageUrl,
          routePrompt: mutableOptions.routePrompt,
          routePolicyKey
        });
        if (!shouldContinue()) return '';
        if (String(reviewed || '').trim()) {
          const cleanReviewed = prepareSubagentFallbackReply(
            cleanToolReplyText(reviewed, formattingPreferences),
            { requestText: question }
          );
          if (cleanReviewed && !looksLikeModelFailureText(cleanReviewed)) {
            console.log('[full-subagent] review completed', {
              executor: 'full_subagent',
              multiAgent: true,
              workerCount,
              reviewCompleted: true,
              reviewDurationMs: Date.now() - reviewStartedAt
            });
            return cleanReviewed;
          }
        }
      } catch (error) {
        console.error('[full-subagent] review failed, fallback to best worker output', {
          executor: 'full_subagent',
          multiAgent: true,
          workerCount,
          error: error?.message || error
        });
      }

      console.log('[full-subagent] review fallback', {
        executor: 'full_subagent',
        multiAgent: true,
        workerCount,
        reviewFallback: true
      });
      return buildFullSubagentFallbackReply(workerResults);
    })().catch((error) => {
      if (error && /cancelled/i.test(String(error?.message || ''))) {
        return '';
      }
      console.error('[full-subagent] multi-agent execute failed:', error?.message || error);
      return '?? `/full` ? worker ????????????????';
    });

    return {
      promise,
      cancel(reason = 'cancelled') {
        for (const fn of workerCancels) {
          try { fn(reason); } catch (_) {}
        }
        return reason;
      }
    };
  }

  async function askAIDispatch(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
    const mutableOptions = options && typeof options === 'object' ? options : {};
    mutableOptions.routePrompt = String(mutableOptions.routePrompt || '').trim() || null;
    if (!mutableOptions.modelConfig && imageUrl) {
      const fallbackModelConfig = resolveLegacyVisionFallbackModelConfig(imageUrl, userId, mutableOptions.routeMeta || {});
      if (fallbackModelConfig) mutableOptions.modelConfig = fallbackModelConfig;
    }
    const startedAt = Date.now();
    if (typeof mutableOptions?.onEvent === 'function') {
      try {
        mutableOptions.onEvent({
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          ts: Date.now(),
          type: 'ask_ai_dispatch_start',
          node: 'pre_model',
          routePolicyKey: String(mutableOptions.routePolicyKey || '').trim(),
          topRouteType: String(mutableOptions.topRouteType || '').trim()
        });
      } catch (_) {}
    }

    const reply = await askAIByGraph(question, userInfo, userId, customPrompt, imageUrl, mutableOptions);

    if (typeof mutableOptions?.onEvent === 'function') {
      try {
        mutableOptions.onEvent({
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          ts: Date.now(),
          type: 'ask_ai_dispatch_done',
          node: 'pre_model',
          routePolicyKey: String(mutableOptions.routePolicyKey || '').trim(),
          topRouteType: String(mutableOptions.topRouteType || '').trim(),
          durationMs: Math.max(0, Date.now() - startedAt)
        });
      } catch (_) {}
    }

    return reply;
  }

  async function markThinkingEmojiBeforeLlm({
    messageId,
    routePolicyKey = '',
    routeMeta = {}
  } = {}) {
    const normalizedMessageId = String(messageId || '').trim();
    if (!normalizedMessageId) return false;

    const emojiIds = Array.isArray(config.QQ_THINKING_EMOJI_IDS) ? config.QQ_THINKING_EMOJI_IDS : [];
    if (!emojiIds.length) return false;

    const result = await setMessageEmojiLike(normalizedMessageId, emojiIds, { set: true }).catch((error) => ({
      success: false,
      reason: error?.message || String(error || 'unknown error'),
      failures: []
    }));

    if (!result?.success) {
      console.warn('[thinking-emoji] failed', {
        messageId: normalizedMessageId,
        routePolicyKey: String(routePolicyKey || '').trim(),
        groupId: String(routeMeta?.groupId || routeMeta?.group_id || '').trim(),
        reason: result?.reason || 'unknown error'
      });
      return false;
    }

    return true;
  }

  async function askToolTaskWithSubagentReview(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
    const mutableOptions = options && typeof options === 'object' ? options : {};
    mutableOptions.routePrompt = String(mutableOptions.routePrompt || '').trim() || null;
    const routePolicyKey = String(mutableOptions.routePolicyKey || 'admin/full').trim() || 'admin/full';
    const formattingPreferences = getFormattingPreferences(question);

    if (!(config.SUBAGENT_ENABLED || config.NANOBOT_BRIDGE_ENABLED)) {
      return '?????????????? agent ????? agent ?????????? `.env` ?? `SUBAGENT_ENABLED`?`SUBAGENT_COMMAND` ? `OPENCLAW_*` ???';
    }

    let subagentOutput = '';
    try {
      const bridgeCall = await startSubagentBridgeCall(question, userInfo, userId, customPrompt, imageUrl, mutableOptions);
      subagentOutput = await bridgeCall.promise;
    } catch (bridgeErr) {
      console.error('[subagent-bridge] execute failed:', bridgeErr?.message || bridgeErr);
      return '????????????? agent ??????????????????????????? agent ????????';
    }

    if (looksLikeModelFailureText(subagentOutput)) {
      return '? agent ???????????????????????????????????????????? agent ???????????';
    }

    if (!(config.SUBAGENT_REVIEW_ENABLED || config.NANOBOT_REVIEW_ENABLED)) {
      return prepareSubagentFallbackReply(cleanToolReplyText(subagentOutput, formattingPreferences), { requestText: question });
    }

    try {
      const reviewed = await reviewSubagentOutput({
        question,
        subagentOutput: prepareSubagentOutputForReview(subagentOutput, { requestText: question }),
        userInfo,
        userId,
        imageUrl,
        routePrompt: mutableOptions.routePrompt,
        routePolicyKey
      });

      if (String(reviewed || '').trim()) {
        if (looksLikeModelFailureText(reviewed) && String(subagentOutput || '').trim()) {
          return prepareSubagentFallbackReply(cleanToolReplyText(subagentOutput, formattingPreferences), { requestText: question });
        }
        return prepareSubagentFallbackReply(cleanToolReplyText(reviewed, formattingPreferences), { requestText: question });
      }
      if (String(subagentOutput || '').trim()) {
        return prepareSubagentFallbackReply(cleanToolReplyText(subagentOutput, formattingPreferences), { requestText: question });
      }
      return '? agent ???????? Mizuki ????????????????????????';
    } catch (reviewErr) {
      console.error('[subagent-review] failed, fallback to raw subagent output:', reviewErr?.message || reviewErr);
      if (String(subagentOutput || '').trim()) {
        return prepareSubagentFallbackReply(cleanToolReplyText(subagentOutput, formattingPreferences), { requestText: question });
      }
      return '??? agent ????????????????????????';
    }
  }

  async function askToolTaskLocally(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
    const mutableOptions = options && typeof options === 'object' ? options : {};
    const formattingPreferences = getFormattingPreferences(question);
    const outputFormatInstruction = buildToolReplyFormatInstruction(formattingPreferences);
    mutableOptions.routePrompt = [String(mutableOptions.routePrompt || '').trim(), outputFormatInstruction].filter(Boolean).join('\n\n') || null;
    const plannerExecutionPlan = mutableOptions.plannerExecutionPlan && typeof mutableOptions.plannerExecutionPlan === 'object'
      ? mutableOptions.plannerExecutionPlan
      : null;
    if (!mutableOptions.modelConfig && imageUrl) {
      const fallbackModelConfig = resolveLegacyVisionFallbackModelConfig(imageUrl, userId, mutableOptions.routeMeta || {});
      if (fallbackModelConfig) mutableOptions.modelConfig = fallbackModelConfig;
    }

    const reply = await askAIByGraph(question, userInfo, userId, customPrompt, imageUrl, {
      ...mutableOptions,
      disableTools: false,
      disableStream: true,
      forcePlanMode: String(plannerExecutionPlan?.mode || '').trim() === 'tool_plan',
      routeMeta: {
        ...(mutableOptions.routeMeta || {})
      }
    });
    return cleanToolReplyText(reply, formattingPreferences);
  }

  async function executeDirectChatToolTask(question, userInfo, userId, imageUrl = null, options = {}) {
    return askToolTaskLocally(question, userInfo, userId, null, imageUrl, options);
  }

  async function executeFullSubagentTaskWithHandle(question, userInfo, userId, imageUrl = null, options = {}) {
    const mutableOptions = options && typeof options === 'object' ? { ...options } : {};
    mutableOptions.routePrompt = String(mutableOptions.routePrompt || '').trim() || null;
    const routePolicyKey = String(mutableOptions.routePolicyKey || 'admin/full').trim() || 'admin/full';
    const formattingPreferences = getFormattingPreferences(question);

      if (!(config.SUBAGENT_ENABLED || config.NANOBOT_BRIDGE_ENABLED)) {
        return {
          promise: Promise.resolve('?????????????? agent??? agent ?????????? `.env` ?? `SUBAGENT_ENABLED`?`SUBAGENT_COMMAND` ? `OPENCLAW_*` ???'),
          cancel() {}
        };
      }

      const bridgeCall = await startSubagentBridgeCall(question, userInfo, userId, null, imageUrl, mutableOptions);
      const promise = bridgeCall.promise.then(async (subagentOutput) => {
        if (looksLikeModelFailureText(subagentOutput)) {
          return '? agent ???????????????????????????????????????????? agent ???????????';
        }

        if (!(config.SUBAGENT_REVIEW_ENABLED || config.NANOBOT_REVIEW_ENABLED)) {
          return prepareSubagentFallbackReply(cleanToolReplyText(subagentOutput, formattingPreferences), { requestText: question });
        }

        const shouldContinue = typeof mutableOptions?.shouldContinue === 'function'
          ? mutableOptions.shouldContinue
          : () => true;

        try {
          if (!shouldContinue()) return '';
          const reviewed = await reviewSubagentOutput({
            question,
            subagentOutput: prepareSubagentOutputForReview(subagentOutput, { requestText: question }),
            userInfo,
            userId,
            imageUrl,
            routePrompt: mutableOptions.routePrompt,
            routePolicyKey
          });
          if (!shouldContinue()) return '';

          if (String(reviewed || '').trim()) {
            if (looksLikeModelFailureText(reviewed) && String(subagentOutput || '').trim()) {
              return prepareSubagentFallbackReply(cleanToolReplyText(subagentOutput, formattingPreferences), { requestText: question });
            }
            return prepareSubagentFallbackReply(cleanToolReplyText(reviewed, formattingPreferences), { requestText: question });
          }
          if (String(subagentOutput || '').trim()) {
            return prepareSubagentFallbackReply(cleanToolReplyText(subagentOutput, formattingPreferences), { requestText: question });
          }
          return '? agent ???????? Mizuki ????????????????????????';
        } catch (reviewErr) {
          console.error('[subagent-review] failed, fallback to raw subagent output:', reviewErr?.message || reviewErr);
          if (String(subagentOutput || '').trim()) {
            return prepareSubagentFallbackReply(cleanToolReplyText(subagentOutput, formattingPreferences), { requestText: question });
          }
          return '??? agent ????????????????????????';
        }
      }).catch((bridgeErr) => {
        if (bridgeErr && /cancelled/i.test(String(bridgeErr?.message || ''))) {
          return '';
        }
        console.error('[subagent-bridge] execute failed:', bridgeErr?.message || bridgeErr);
        return '????????????? agent ??????????????????????????? agent ????????';
      });

      return {
        promise,
        cancel(reason = 'cancelled') {
          return bridgeCall.cancel(reason);
        }
      };
  }

  async function executeDirectChatToolTaskWithHandle(question, userInfo, userId, imageUrl = null, options = {}) {
    return {
      promise: executeDirectChatToolTask(question, userInfo, userId, imageUrl, options),
      cancel() {}
    };
  }

  routeFlow = createMessageRouteFlow({
    config,
    routeResolver,
    routeExecution,
    planDirectChat,
    askAIDispatch,
    askToolTaskLocally,
    askToolTaskWithSubagentReview,
    runBackgroundToolTask,
    handleAdminCommand,
    handleHapiAdminCommand,
    handleMemoryOpsAdminCommand,
    handleQqScheduleAdminCommand,
    detectQzonePostDraftMode,
    generateBotDiaryDraft,
    generateGenericQzoneDraft,
    normalizeGeneratedQzoneContent,
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
    sendGroupReply: (...args) => replyRuntime.sendGroupReply(...args),
    sendReply: (...args) => replyRuntime.sendReply(...args),
    updateFavor,
    saveData,
    recordMemoryScope,
    buildToolGuidancePrompt: promptComposerBuildToolGuidancePrompt,
    buildBridgeGuidancePrompt: promptComposerBuildBridgeGuidancePrompt,
    buildStreamingSegmentationPrompt: promptComposerBuildStreamingSegmentationPrompt,
    buildQqRichReplyPrompt: promptComposerBuildQqRichReplyPrompt,
    shouldPreferQqRichReply: promptComposerShouldPreferQqRichReply,
    buildSafetyBoundaryRoutePrompt: promptComposerBuildSafetyBoundaryRoutePrompt,
    buildLlmPerception,
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
    buildSubagentContextSummary
  });

  async function sendGroupReplyFallback({ groupId, senderId, replyText, atSender = true, retries = 2, waitMs = 500 }) {
    const normalized = String(replyText || '').trim() || '??????????????';
    const richPayload = buildQqRichMessagePayload(normalized, { atSender, senderId });
    if (richPayload) {
      const ok = await sendWithRetry({
        action: 'send_group_msg',
        params: { group_id: groupId, message: richPayload }
      }, retries, waitMs);

      if (!ok) {
        console.error('[reply] send_group_msg failed', {
          groupId,
          senderId,
          chunkIndex: 0,
          chunkCount: 1,
          richMessage: true
        });
      }

      return ok;
    }

    const chunks = splitReplyForSend(normalized, getReplyChunkChars(config));
    if (!chunks.length) return false;

    let sentAny = false;
    for (let i = 0; i < chunks.length; i += 1) {
      const prefix = (atSender && i === 0) ? `[CQ:at,qq=${senderId}] ` : '';
      const ok = await sendWithRetry({
        action: 'send_group_msg',
        params: { group_id: groupId, message: `${prefix}${chunks[i]}` }
      }, retries, waitMs);

      if (!ok) {
        console.error('[reply] send_group_msg failed', {
          groupId,
          senderId,
          chunkIndex: i,
          chunkCount: chunks.length
        });
        return sentAny;
      }

      sentAny = true;
      if (i < chunks.length - 1) {
        await new Promise((r) => setTimeout(r, 140));
      }
    }

    return sentAny;
  }

  const sendGroupReply = async function patchedSendReply({
    chatType = 'group',
    groupId,
    userId,
    senderId,
    replyText,
    atSender = true,
    retries = 2,
    waitMs = 500,
    telemetry = null
  }) {
    return sendReply({
      chatType,
      groupId,
      userId: userId || senderId,
      senderId,
      replyText,
      atSender,
      retries,
      waitMs,
      telemetry
    });
  };
  // source-compat anchor: return replyRuntime.sendGroupReply({

  async function maybeHandlePrivateTypingNotice(noticeResult = null) {
    if (!noticeResult || noticeResult.type !== 'input_status') return false;
    if (!config.PRIVATE_TYPING_POKE_ENABLED) return true;

    const meta = noticeResult.meta && typeof noticeResult.meta === 'object' ? noticeResult.meta : {};
    const userId = String(meta.userId || '').trim();
    const statusText = String(meta.statusText || '').trim();
    const eventType = String(meta.eventType || '').trim();
    const isPrivate = meta.isPrivate === true;

    if (!isPrivate || !userId) return true;
    if (!isPrivateChatUserAllowed(userId, config)) return true;

    const isTyping = eventType === '1' || /正在输入/.test(statusText);
    if (!isTyping) return true;

    const now = Date.now();
    const cooldownMs = Math.max(0, Number(config.PRIVATE_TYPING_POKE_COOLDOWN_MS) || 0);
    const lastTriggeredAt = Math.max(0, Number(privateTypingPokeCooldownByUser.get(userId) || 0) || 0);
    if (cooldownMs > 0 && lastTriggeredAt > 0 && (now - lastTriggeredAt) < cooldownMs) {
      return true;
    }

    privateTypingPokeCooldownByUser.set(userId, now);
    try {
      await sendPrivatePoke(userId);
      console.log('[notice] private typing poke sent', {
        userId,
        eventType,
        statusText
      });
    } catch (error) {
      console.warn('[notice] private typing poke failed', {
        userId,
        eventType,
        statusText,
        error: error?.message || String(error || '')
      });
    }
    return true;
  }

  async function handleIncomingMessage(msg) {
    const handlerStartedAt = Date.now();
    const rawMessageTimestampMs = getRawMessageTimestampMs(msg);
    const requestTrace = createRequestTrace({
      source: 'message_ingress',
      messageId: String(msg?.message_id || '').trim(),
      groupId: String(msg?.group_id || '').trim(),
      userId: String(msg?.user_id || '').trim(),
      chatType: String(msg?.message_type || '').trim(),
      isAdmin: isAdminUser(String(msg?.user_id || '').trim())
    });
    const appendTraceTiming = (phase, payload = {}) => appendInboundTimingLog(
      inboundTimingLogFile,
      config.ENABLE_DEBUG_LOG,
      nextTracePhase(requestTrace, phase, payload)
    );
    const buildTraceBase = () => ({
      messageId: String(msg?.message_id || '').trim(),
      groupId: String(msg?.group_id || '').trim(),
      userId: String(msg?.user_id || '').trim(),
      chatType: String(msg?.message_type || '').trim().toLowerCase() === 'private' ? 'private' : 'group',
      rawMessageTimestampMs,
      elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
      lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
    });
    const appendRequestCompleteTrace = (payload = {}) => appendTraceTiming('request_complete', {
      stage: 'request_complete',
      ...buildTraceBase(),
      durationMs: Math.max(0, Date.now() - handlerStartedAt),
      ...payload
    });
    appendTraceTiming('message_ingress', {
      stage: 'handle_incoming_start',
      messageId: String(msg?.message_id || '').trim(),
      groupId: String(msg?.group_id || '').trim(),
      userId: String(msg?.user_id || '').trim(),
      chatType: String(msg?.message_type || '').trim(),
      isAdmin: isAdminUser(String(msg?.user_id || '').trim()),
      rawMessageTimestampMs,
      lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, handlerStartedAt - rawMessageTimestampMs) : null
    });

    const noticeResult = shouldHandleNotice(msg, config);
