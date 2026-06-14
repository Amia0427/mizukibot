        runtimeConfig: config
      })) {
        await sendGroupReply({
          chatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: PRIVATE_GROUP_ONLY_REPLY,
          atSender: false,
          retries: 1,
          waitMs: 300
        });
        return;
      }
      const initiativeResult = await handleInitiativeAdminCommand({
        rawText: slashCommandText,
        groupId,
        userId: senderId
      });
      if (String(initiativeResult?.replyText || '').trim()) {
        await sendGroupReply({
          chatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: initiativeResult.replyText,
          atSender: true,
          retries: 1,
          waitMs: 300
        });
      }
      logMemoryWriteSkip('special_command', { command: 'initiative' });
      return;
    }

    if (/^\s*\/cot(?:\s|$)/i.test(String(slashCommandText || '').trim())) {
      const armed = armCotOnce({
        chatType,
        groupId: isPrivateChatType(chatType) ? '' : groupId,
        userId: senderId
      });
      const ttlSeconds = Math.max(1, Math.ceil(getCotOnceTtlMs() / 1000));
      await sendGroupReply({
        chatType,
        groupId,
        userId: senderId,
        senderId,
        replyText: armed
          ? `已开启一次性思维链显示。请在 ${ttlSeconds} 秒内发送下一条正常对话消息；仅该次回复生效。`
          : '一次性思维链显示刚刚没开起来。等一下再试试。',
        atSender: true,
        retries: 1,
        waitMs: 300
      });
      logMemoryWriteSkip('special_command', { command: 'cot' });
      return;
    }

    if (!effectiveBotQQ) {
      console.warn('[message] skip because bot qq is unresolved');
      return;
    }

    const mentioned = getCachedRouteValue(`mentioned:${String(rawText || '')}:${effectiveBotQQ}`, () => isAtBot(rawText, effectiveBotQQ));
    const cleanTextWithoutControls = getCachedRouteValue(`cleanTextWithoutControls:${String(rawText || '')}:${effectiveBotQQ}`, () => stripLeadingCqControlSegments(rawText, effectiveBotQQ));
    if (continuousMeta && typeof continuousMeta === 'object') {
      await resolveContinuousEntryDetails(continuousMeta, {
        actionClient: globalNapCatActionClient,
        effectiveBotQQ,
        resolveReply: Boolean(continuousMeta.replyMessageId),
        resolveForward: Array.isArray(continuousMeta.forwardIds) && continuousMeta.forwardIds.length > 0,
        resolveCards: Array.isArray(continuousMeta.qqCardUrls) && continuousMeta.qqCardUrls.length > 0
      });
    }
    if (continuousMeta && typeof continuousMeta === 'object') {
      effectiveMsg.__continuousMessageMeta = continuousMeta;
    }
    // source-compat anchor: const effectiveVisualInput = resolveVisualInputFromContinuousMeta(continuousMeta);
    const effectiveRawText = getCachedRouteValue(`effectiveRawText:${String(effectiveMsg?.raw_message || rawText || '')}`, () => String(effectiveMsg?.raw_message || rawText || ''));
    const effectiveCleanText = getCachedRouteValue(`effectiveCleanText:${effectiveRawText}:${effectiveBotQQ}`, () => stripLeadingCqControlSegments(effectiveRawText, effectiveBotQQ));
    const directedContext = await resolveMessageDirectedContext({
      msg,
      effectiveMsg,
      groupId,
      senderId,
      rawText: effectiveRawText,
      cleanText: effectiveCleanText,
      isAtBot: mentioned,
      botQQ: effectiveBotQQ,
      continuousMeta,
      historySummary: buildSubagentContextSummary(senderId, groupId, { maxLength: 180 })
    });
    const currentMessageImageRawUrls = Array.isArray(effectiveMsg?.message)
      ? effectiveMsg.message
          .filter((item) => String(item?.type || '').trim() === 'image')
          .map((item) => String(item?.data?.url || '').trim())
          .filter(Boolean)
      : [];
    const currentMessageImageRawUrl = currentMessageImageRawUrls[0] || '';
    const hasPotentialVisualInput = Boolean(
      Array.isArray(continuousMeta?.imageUrls) && continuousMeta.imageUrls.length > 0
      || Array.isArray(continuousMeta?.currentImageUrls) && continuousMeta.currentImageUrls.length > 0
      || (Array.isArray(continuousMeta?.replyContext?.imageUrls) && continuousMeta.replyContext.imageUrls.length > 0)
      || String(directedContext?.replyImageUrl || '').trim()
      || (Array.isArray(continuousMeta?.forwardImageUrls) && continuousMeta.forwardImageUrls.length > 0)
      || (Array.isArray(continuousMeta?.forwardImages) && continuousMeta.forwardImages.length > 0)
      || (Array.isArray(continuousMeta?.qqCardUrls) && continuousMeta.qqCardUrls.length > 0)
      || currentMessageImageRawUrls.length > 0
    );
    const visualImageCollectionResult = hasPotentialVisualInput
      ? getCachedRouteValue(`visualCollection:${String(effectiveMsg?.message_id || msg?.message_id || '')}`, () => buildVisualImageCollectionDetails(
        continuousMeta,
        directedContext,
        effectiveCleanText,
        { maxImages: config.VISION_CAPTION_WORKER_MAX_IMAGES }
      ))
      : { images: [], meta: {} };
    const visualImageCollection = Array.isArray(visualImageCollectionResult?.images) ? visualImageCollectionResult.images : [];
    const currentImageRefMap = continuousMeta?.imageRefMap && typeof continuousMeta.imageRefMap === 'object'
      ? continuousMeta.imageRefMap
      : {};
    const stableVisualImageCollection = [];
    for (const item of visualImageCollection) {
      const itemUrl = String(item?.url || '').trim();
      if (!itemUrl) continue;
      const stableUrl = await resolveStableVisualUrl(itemUrl);
      stableVisualImageCollection.push({
        ...item,
        url: stableUrl,
        originalUrl: String(item?.originalUrl || itemUrl).trim() || itemUrl
      });
    }
    const currentMessageImageUrls = [];
    for (const rawUrl of currentMessageImageRawUrls) {
      const stableUrl = await resolveStableVisualUrl(rawUrl, currentImageRefMap);
      if (stableUrl) currentMessageImageUrls.push({ rawUrl, stableUrl });
    }
    const currentMessageImageUrl = currentMessageImageUrls[0]?.stableUrl || '';
    const continuousPrimaryImageUrl = String(
      resolveVisualInputFromContinuousMetaCore(continuousMeta, directedContext, effectiveCleanText) || ''
    ).trim();
    const stableContinuousPrimaryImageUrl = continuousPrimaryImageUrl
      ? await resolveStableVisualUrl(continuousPrimaryImageUrl, currentImageRefMap)
      : '';
    const effectiveVisualCollection = stableVisualImageCollection.length > 0
      ? stableVisualImageCollection
      : (
        currentMessageImageUrls.length > 0
          ? currentMessageImageUrls.map((item, index) => ({
              imageIndex: index,
              source: 'current',
              url: item.stableUrl,
              originalUrl: item.rawUrl || item.stableUrl,
              label: `current_${index + 1}`
            }))
          : []
      );
    const effectiveVisualInput = stableVisualImageCollection.length > 0
      ? (String(stableVisualImageCollection[0]?.url || '').trim()
        || stableContinuousPrimaryImageUrl)
      : currentMessageImageUrl;
    const effectiveVisualInputUrls = effectiveVisualCollection
      .map((item) => String(item?.url || '').trim())
      .filter(Boolean);
    const visualCacheRefCount = countCachedVisualRefs(effectiveVisualCollection);
    const directedScene = String(directedContext?.scene || '').trim();
    const replyToBotRequested = directedScene === 'reply_to_bot';
    const replyToBotRecentWindowMs = Math.max(
      0,
      Math.floor(Number(config.REPLY_TO_BOT_RECENT_WINDOW_MINUTES || 0) * 60 * 1000)
    );
    const lastBotReplyAt = !isPrivateChatType(chatType) && replyToBotRequested ? getLastReplyAt(groupId) : 0;
    const replyToBotIsRecent = Boolean(
      replyToBotRequested
      && lastBotReplyAt > 0
      && replyToBotRecentWindowMs > 0
      && (Date.now() - lastBotReplyAt) <= replyToBotRecentWindowMs
    );
    const directBotAnchor = Boolean(isPrivateChatType(chatType) || mentioned || replyToBotIsRecent);
    const effectiveIntentText = String(
      directedContext?.quotePriority?.quoteAnchoredText
      || effectiveCleanText
      || ''
    ).trim();
    let routerRawText = effectiveVisualInput && !/\[CQ:image,.*?\]/i.test(effectiveRawText)
      ? `${effectiveRawText.trim()}\n[CQ:image,url=${effectiveVisualInput}]`
      : effectiveRawText;
    let runtimeQuestionText = effectiveIntentText;
    let persistUserText = effectiveIntentText;
    let originalUserText = effectiveIntentText;
    let visualContext = visualImageCollection.length > 0
      ? {
          hasVisualInput: true,
        worker: {
          name: 'vision-caption-worker',
          succeeded: false,
          fallbackUsed: true,
          fallbackReason: 'not_started',
          imageCount: effectiveVisualCollection.length
        },
          images: effectiveVisualCollection.map((item, index) => ({
            imageIndex: index,
            source: item.source,
            url: item.url,
            label: item.label
          })),
          selectionMeta: {
            ...(visualImageCollectionResult.meta || {})
          },
          captionJson: null,
          summary: '',
          recommendedPromptContext: '',
          shortPersistSummary: '',
          runtimeQuestionText: effectiveIntentText,
          persistUserText: effectiveIntentText,
          originalUserText: effectiveIntentText
        }
      : null;

    if (effectiveVisualCollection.length > 0) {
      appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
        stage: 'vision_input_selected',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        imageCount: effectiveVisualCollection.length,
        currentImageCount: Number(visualImageCollectionResult.meta?.currentImageCount || 0) || 0,
        replyImageCount: Number(visualImageCollectionResult.meta?.replyImageCount || 0) || 0,
        forwardImageCount: Number(visualImageCollectionResult.meta?.forwardImageCount || 0) || 0,
        directedScene: String(visualImageCollectionResult.meta?.directedScene || '').trim(),
        quotePriorityMode: String(visualImageCollectionResult.meta?.quotePriorityMode || '').trim(),
        forcedReplyPriority: visualImageCollectionResult.meta?.forcedReplyPriority === true,
        replyPriorityReason: String(visualImageCollectionResult.meta?.replyPriorityReason || '').trim(),
        selectedPrimarySource: String(visualImageCollectionResult.meta?.selectedPrimarySource || '').trim(),
        cacheRefCount: visualCacheRefCount,
        selectedVisualInput: effectiveVisualInput,
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
      });
    }

    if (effectiveVisualCollection.length > 0) {
      const visionStartedAt = Date.now();
      const captionResult = await visionCaptionWorkerRunner({
        originalUserText: effectiveIntentText,
        images: effectiveVisualCollection,
        quotePriorityMode: String(directedContext?.quotePriority?.mode || '').trim(),
        quotePriorityReason: String(directedContext?.quotePriority?.reason || '').trim()
      });
      if (captionResult.ok && captionResult.visualContext) {
        visualContext = captionResult.visualContext;
        visualContext.selectionMeta = {
          ...(visualImageCollectionResult.meta || {})
        };
        runtimeQuestionText = normalizeVisualSummaryText(visualContext.runtimeQuestionText) || effectiveIntentText;
        persistUserText = normalizeVisualSummaryText(visualContext.persistUserText) || effectiveIntentText;
        originalUserText = normalizeVisualSummaryText(visualContext.originalUserText) || effectiveIntentText;
        routerRawText = effectiveCleanText;
        appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
          stage: 'vision_caption_worker_done',
          messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
          groupId: String(groupId || '').trim(),
          userId: String(senderId || '').trim(),
          chatType,
          imageCount: effectiveVisualCollection.length,
          cacheRefCount: visualCacheRefCount,
          durationMs: Math.max(0, Date.now() - visionStartedAt),
          fallbackUsed: false,
          rawMessageTimestampMs,
          elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
          lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
        });
      } else {
        if (visualContext && visualContext.worker) {
          visualContext.worker.fallbackUsed = true;
          visualContext.worker.fallbackReason = String(captionResult.fallbackReason || 'worker_failed').trim() || 'worker_failed';
        }
        appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
          stage: 'vision_caption_worker_fallback',
          messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
          groupId: String(groupId || '').trim(),
          userId: String(senderId || '').trim(),
          chatType,
          imageCount: effectiveVisualCollection.length,
          cacheRefCount: visualCacheRefCount,
          durationMs: Math.max(0, Date.now() - visionStartedAt),
          fallbackReason: String(captionResult.fallbackReason || 'worker_failed').trim(),
          fallbackImageUrl: effectiveVisualInput,
          rawMessageTimestampMs,
          elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
          lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
        });
      }
    }
    const sessionKey = resolveShortTermSessionKey(senderId, { groupId });
    const stableThreadId = resolveThreadId({
      userId: senderId,
      routePolicyKey: '',
      reviewMode: '',
      routeMeta: {
        userId: String(senderId || '').trim(),
        groupId: isPrivateChatType(chatType) ? '' : String(groupId || '').trim(),
        chatType,
        messageId: String(effectiveMsg?.message_id || msg?.message_id || '').trim()
      },
      sessionKey,
      imageUrl: effectiveVisualInput,
      options: {
        threadId: [
          String(senderId || '').trim() || 'anonymous',
          String(sessionKey || 'default').trim() || 'default',
          String(effectiveMsg?.message_id || msg?.message_id || '').trim() || 'message',
          String(effectiveVisualInput || '').trim() ? 'image' : 'chat'
        ].join(':')
      }
    });
    const previousPresence = getShortTermPresence(sessionKey, shortTermMemory, {});
    const sessionTiming = buildInboundSessionTiming({
      continuousMeta,
      previousPresence
    });
    markDirectSessionHumanInbound({
      groupId,
      senderId,
      sessionTiming
    });
    const inboundContext = buildInboundMessageContext({
      msg,
      effectiveMsg,
      groupId: isPrivateChatType(chatType) ? '' : groupId,
      senderId,
      rawText: effectiveRawText,
      cleanText: effectiveCleanText,
      imageUrl: visualContext?.worker?.succeeded ? null : effectiveVisualInput,
      imageUrls: visualContext?.worker?.succeeded ? [] : effectiveVisualInputUrls,
      isAtBot: directBotAnchor,
      botQQ: effectiveBotQQ,
      chatType,
      sessionTiming,
      continuousMeta,
      directedContext,
      visualContext,
      threadId: stableThreadId,
      requestTrace: cloneTraceForMeta(requestTrace),
      messageMeta: {
        messageId: String(effectiveMsg?.message_id || msg?.message_id || '').trim(),
        threadId: stableThreadId
      }
    });
    inboundContext.requestTrace = cloneTraceForMeta(requestTrace);
    inboundContext.onEvent = (event = {}) => {
      const normalizedEvent = event && typeof event === 'object' ? event : {};
      const normalizedEventType = String(normalizedEvent.type || normalizedEvent.stage || 'reply_event').trim() || 'reply_event';
      const shouldTraceReplyEvent = Boolean(
        requestTrace
        && normalizedEventType
        && !normalizedEventType.startsWith('runtime_v2_')
        && [
          'ask_ai_dispatch_start',
          'ask_ai_dispatch_done',
          'thinking_emoji_done',
          'thinking_emoji_skipped',
          'tool_task_local_start',
          'tool_task_local_done',
          'reply_stream_chunk_start',
          'reply_stream_chunk_success',
          'reply_stream_chunk_failure',
          'normal_group_main_reply_rate_limited'
        ].includes(normalizedEventType)
      );
      if (shouldTraceReplyEvent) {
        appendRequestTraceEvent(nextTracePhase(requestTrace, normalizedEventType, {
          tracePhase: normalizedEventType,
          stage: normalizedEventType,
          source: 'message_route_flow',
          node: String(normalizedEvent.node || '').trim(),
          messageId: String(effectiveMsg?.message_id || msg?.message_id || '').trim(),
          groupId: isPrivateChatType(chatType) ? '' : String(groupId || '').trim(),
          userId: String(senderId || '').trim(),
          chatType,
          routePolicyKey: String(normalizedEvent.routePolicyKey || '').trim(),
          topRouteType: String(normalizedEvent.topRouteType || '').trim(),
          reason: String(normalizedEvent.reason || '').trim(),
          durationMs: Number.isFinite(Number(normalizedEvent.durationMs))
            ? Math.max(0, Math.floor(Number(normalizedEvent.durationMs)))
            : null,
          channel: String(normalizedEvent.channel || '').trim(),
          chunkIndex: Number(normalizedEvent.chunkIndex || 0) || 0,
          chunkLength: Number(normalizedEvent.chunkLength || 0) || 0,
          applied: normalizedEvent.applied === true,
          rawMessageTimestampMs,
          elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
          lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
        }));
      }
      if (String(normalizedEvent.type || '').trim() === 'direct_reply_failure') {
        appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
          ...nextTracePhase(requestTrace, 'runtime_direct_reply_failure', {}),
          stage: 'direct_reply_failure',
          messageId: String(effectiveMsg?.message_id || msg?.message_id || '').trim(),
          groupId: isPrivateChatType(chatType) ? '' : String(groupId || '').trim(),
          userId: String(senderId || '').trim(),
          chatType,
          routePolicyKey: String(normalizedEvent.routePolicyKey || '').trim(),
          topRouteType: String(normalizedEvent.topRouteType || '').trim(),
          failureType: String(normalizedEvent.failureType || '').trim(),
          fallbackSource: String(normalizedEvent.fallbackSource || '').trim(),
          failureStage: String(normalizedEvent.stage || '').trim(),
          rawErrorMessage: String(normalizedEvent.rawErrorMessage || '').trim(),
          rawMessageTimestampMs,
          elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
          lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
        });
      }
      const telemetry = buildReplyTelemetry({
        senderId,
        groupId: isPrivateChatType(chatType) ? '' : groupId,
        chatType,
        routePolicyKey: '',
        topRouteType: '',
        routeMeta: {
          userId: String(senderId || '').trim(),
          groupId: isPrivateChatType(chatType) ? '' : String(groupId || '').trim(),
          chatType,
          threadId: stableThreadId,
          messageId: String(effectiveMsg?.message_id || msg?.message_id || '').trim(),
          requestTrace: cloneTraceForMeta(requestTrace)
        }
      });
      if (typeof telemetry?.onEvent === 'function') {
        telemetry.onEvent(event);
      }
    };
    inboundContext.effectiveIntentText = runtimeQuestionText;
    inboundContext.runtimeQuestionText = runtimeQuestionText;
    inboundContext.persistUserText = persistUserText;
    inboundContext.originalUserText = originalUserText;
    if (visualContext?.worker?.succeeded) {
      inboundContext.cleanText = runtimeQuestionText;
      inboundContext.rawText = runtimeQuestionText;
    }
    inboundContext.quotePriority = directedContext?.quotePriority || null;
    if (!isPrivateChatType(chatType) && !directBotAnchor) {
      const passiveFlowResult = await runPassiveFlow({
        inboundContext,
        handlePassiveGroupAwareness,
        sendGroupReply,
        sendWithRetry
      });
      const passiveResult = passiveFlowResult.passiveResult;
      console.log('[message] skip not at bot', {
        messageId: effectiveMsg.message_id,
        groupId,
        userId: senderId,
        effectiveBotQQ,
        rawPreview: String(rawText || '').slice(0, 120),
        passiveHandled: Boolean(passiveResult?.handled),
        passiveReason: passiveResult?.reason || '',
        reply_to_bot_recent_gate: replyToBotRequested ? (replyToBotIsRecent ? 'allow' : 'reject') : '',
        reply_to_bot_last_reply_at: lastBotReplyAt || 0,
        cheap_gate_reason: passiveResult?.cheapGateReason || '',
        decision_reason: passiveResult?.decisionReason || '',
        decision_model_called: Boolean(passiveResult?.decisionModelCalled),
        reply_model_called: Boolean(passiveResult?.replyModelCalled),
        presenceState: passiveResult?.presenceState || '',
        presenceAction: passiveResult?.presenceAction || '',
        presenceReason: passiveResult?.presenceReason || ''
      });
      return;
    }

    const cotArmedState = consumeCotOnce({
      chatType,
      groupId: isPrivateChatType(chatType) ? '' : groupId,
      userId: senderId
    });

    console.log('[message] accepted inbound', {
      messageId: effectiveMsg.message_id,
      groupId,
      userId: senderId,
      chatType,
      concurrencyScope,
      privilegedPrivateChat,
      effectiveBotQQ,
      rawPreview: String(rawText || '').slice(0, 120),
      acceptedBy: isPrivateChatType(chatType)
        ? 'private_direct'
        : (mentioned ? 'at_bot' : 'reply_to_bot_recent'),
      reply_to_bot_last_reply_at: lastBotReplyAt || 0,
      cotDisplayOnce: Boolean(cotArmedState)
    });

    const cleanMentionText = String(rawText || '')
      .replace(/\[CQ:reply,.*?\]/g, '')
      .replace(new RegExp(`\\[CQ:at,qq=${effectiveBotQQ}\\]`, 'g'), '')
      .replace(/\[CQ:image,.*?\]/g, '')
      .trim();
    const backgroundControlCommand = parseBackgroundControlCommand(cleanMentionText);
    if (!isPrivateChatType(chatType) && backgroundControlCommand) {
      const controlUserInfo = updateFavor(senderId, cleanMentionText || '鍚庡彴浠诲姟鎺у埗', groupId);
      controlUserInfo.last_seen_at = Date.now();
      saveData();
      recordMemoryScope(senderId, { groupId });

      const handled = await routeFlow.handleBackgroundControl({
        command: backgroundControlCommand,
        groupId,
        senderId,
        userInfo: controlUserInfo,
        imageUrl: effectiveVisualInput,
        rawText,
        botQQ: effectiveBotQQ
      });
      if (handled) return;
    }

    const previousShortTermState = shortTermMemory?.[sessionKey] && typeof shortTermMemory[sessionKey] === 'object'
      ? shortTermMemory[sessionKey]
      : {};
    const routeContinuitySignals = {
      activeTopic: String(previousShortTermState?.interaction?.activeTopic || previousShortTermState?.activeTopic || '').trim(),
      carryOverUserTurn: String(previousShortTermState?.interaction?.carryOverUserTurn || previousShortTermState?.carryOverUserTurn || '').trim(),
      sceneTopic: String(previousShortTermState?.scene?.activeTopic || '').trim(),
      recentTurns: Array.isArray(previousShortTermState?.interaction?.recentTurns)
        ? previousShortTermState.interaction.recentTurns.slice(-4)
        : []
    };
    const routerContextSummary = buildSubagentContextSummary(senderId, groupId, { maxLength: 180, directedContext });
    const plannerContextSummary = buildSubagentContextSummary(senderId, groupId, { maxLength: 320, directedContext });
    const routeResolverStartedAt = Date.now();
    let route = null;
    let routeResolverError = null;
    try {
      appendTraceTiming('router_start', {
        stage: 'route_resolver_start',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
      });
      route = await routeResolver({
        rawText: routerRawText,
        botQQ: effectiveBotQQ,
        userId: senderId,
        chatType,
        contextSummary: routerContextSummary,
        directedContext,
        continuitySignals: routeContinuitySignals,
        effectiveIntentText: runtimeQuestionText
      }, { requestTrace: cloneTraceForMeta(requestTrace) });
    } catch (error) {
      routeResolverError = error;
      appendTraceTiming('router_failed', {
        stage: 'route_resolver_failed',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        durationMs: Math.max(0, Date.now() - routeResolverStartedAt),
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
        finalErrorCode: extractErrorCode(error),
        error: error?.message || String(error || '')
      });
      throw error;
    }
    appendTraceTiming('router_done', {
      stage: 'route_resolver_done',
      messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
