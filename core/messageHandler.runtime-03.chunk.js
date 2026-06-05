    if (inboundDeduper.shouldSkip(msg)) {
      console.log('[message] deduped', {
        messageId: msg.message_id,
        groupId: msg.group_id,
        userId: msg.user_id
      });
      return;
    }

    const senderId = msg.user_id;
    const groupId = msg.group_id;
    const chatType = String(msg.message_type || '').trim().toLowerCase() === 'private' ? 'private' : 'group';
    const privilegedPrivateChat = isPrivilegedPrivateChatUser({
      chatType,
      userId: senderId,
      config
    });
    if (shouldSkipSelfMessage(msg, config)) {
      return;
    }

    const rawInboundFreshnessSessionKey = resolveShortTermSessionKey(
      senderId,
      isPrivateChatType(chatType) ? {} : { groupId }
    );
    const rawInboundFreshnessVersion = nextSessionFreshnessVersion(rawInboundFreshnessSessionKey);
    const rawMessageText = String(msg?.raw_message || '').trim();
    const createCommandText = stripLeadingCqControlSegments(rawMessageText, resolveEffectiveBotQQ(msg, config));
    if (/^\s*\/create(?:\s|$)/i.test(createCommandText)) {
      if (isPrivateChatType(chatType) && !privilegedPrivateChat) {
        const sendStartedAt = Date.now();
        appendTraceTiming('final_reply_send_start', {
          stage: 'final_reply_send_start',
          ...buildTraceBase(),
          routePolicyKey: 'admin/create',
          topRouteType: 'admin',
          replyPath: 'create_private_blocked'
        });
        await sendGroupReply({
          chatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: PRIVATE_CHAT_WHITELIST_REPLY,
          atSender: false,
          retries: 1,
          waitMs: 300
        });
        appendTraceTiming('final_reply_send_done', {
          stage: 'final_reply_send_done',
          ...buildTraceBase(),
          routePolicyKey: 'admin/create',
          topRouteType: 'admin',
          replyPath: 'create_private_blocked',
          sent: true,
          durationMs: Math.max(0, Date.now() - sendStartedAt)
        });
        appendRequestCompleteTrace({
          routePolicyKey: 'admin/create',
          topRouteType: 'admin',
          finalErrorCode: 'private_chat_disabled'
        });
        return;
      }

      const createAgentExecutor = getCreateAgentExecutorModule();
      if (!createAgentExecutor.isCreateAgentUserAllowed(senderId)) {
        try {
          await sendGroupPoke(groupId, senderId, {
            actionClient: {
              callAction: async (action, params) => {
                const ok = await sendWithRetry({
                  action,
                  params
                }, 1, 300);
                if (!ok) {
                  throw new Error(`sendWithRetry failed for ${String(action || '').trim() || 'group_poke'}`);
                }
                return {};
              }
            }
          });
        } catch (error) {
          console.warn('[create] unauthorized group poke failed', {
            groupId,
            senderId,
            error: error?.message || String(error || '')
          });
        }
        appendRequestCompleteTrace({
          routePolicyKey: 'admin/create',
          topRouteType: 'admin',
          finalErrorCode: 'unauthorized',
          sent: false
        });
        return;
      }

      const prompt = createCommandText.replace(/^\s*\/create/i, '').trim();
      appendTraceTiming('admin_route_dispatch_start', {
        stage: 'admin_route_dispatch_start',
        ...buildTraceBase(),
        routePolicyKey: 'admin/create',
        topRouteType: 'admin',
        command: 'create'
      });
      const createResult = await createAgentExecutor.executeCreateCommand({
        prompt,
        chatType,
        groupId,
        senderId,
        rawText: rawMessageText,
        requestTrace: cloneTraceForMeta(requestTrace)
      });
      appendTraceTiming('admin_route_dispatch_done', {
        stage: 'admin_route_dispatch_done',
        ...buildTraceBase(),
        routePolicyKey: 'admin/create',
        topRouteType: 'admin',
        command: 'create',
        ok: createResult?.ok === true,
        finalErrorCode: createResult?.ok ? '' : String(createResult?.code || '').trim()
      });

      if (!createResult?.ok) {
        const sendStartedAt = Date.now();
        appendTraceTiming('final_reply_send_start', {
          stage: 'final_reply_send_start',
          ...buildTraceBase(),
          routePolicyKey: 'admin/create',
          topRouteType: 'admin',
          replyPath: 'create_failure'
        });
        const sent = await sendGroupReply({
          chatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: String(createResult?.replyText || '生图那边刚刚没跑成。等一下再丢给我试试。').trim(),
          atSender: false,
          retries: 1,
          waitMs: 300
        });
        appendTraceTiming('final_reply_send_done', {
          stage: 'final_reply_send_done',
          ...buildTraceBase(),
          routePolicyKey: 'admin/create',
          topRouteType: 'admin',
          replyPath: 'create_failure',
          sent: Boolean(sent),
          durationMs: Math.max(0, Date.now() - sendStartedAt),
          finalErrorCode: String(createResult?.code || '').trim()
        });
      }
      appendRequestCompleteTrace({
        routePolicyKey: 'admin/create',
        topRouteType: 'admin',
        sent: createResult?.ok === true,
        finalErrorCode: createResult?.ok ? '' : String(createResult?.code || '').trim()
      });
      return;
    }

    if (isPrivateChatType(chatType) && !isPrivateChatUserAllowed(senderId, config)) {
      console.log('[message] private chat rejected by allowlist', {
        messageId: msg.message_id,
        userId: senderId,
        chatType
      });
      await sendGroupReply({
        chatType,
        groupId,
        userId: senderId,
        senderId,
        replyText: PRIVATE_CHAT_WHITELIST_REPLY,
        atSender: false,
        retries: 1,
        waitMs: 300
      });
      return;
    }

    const uploadConsume = await consumePendingUploadFromMessage(msg);
    if (uploadConsume?.consumed) {
      if (String(uploadConsume.replyText || '').trim()) {
        await sendGroupReply({
          chatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: uploadConsume.replyText,
          atSender: true,
          retries: 1,
          waitMs: 300
        });
      }
      return;
    }

    const effectiveBotQQ = resolveEffectiveBotQQ(msg, config);
    const preprocessed = await continuousMessagePreprocessor.handleMessage(msg, {
      effectiveBotQQ,
      freshnessSessionKey: rawInboundFreshnessSessionKey,
      freshnessVersion: rawInboundFreshnessVersion
    });
    appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
      stage: 'continuous_preprocess_done',
      messageId: String(msg?.message_id || '').trim(),
      groupId: String(msg?.group_id || '').trim(),
      userId: String(msg?.user_id || '').trim(),
      preprocessMode: String(preprocessed?.mode || '').trim(),
      flushReason: String(preprocessed?.meta?.flushReason || '').trim(),
      rawMessageTimestampMs,
      elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
      lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
    });
    if (preprocessed?.mode === 'deferred') {
      return;
    }

    const effectiveMsg = preprocessed?.effectiveMsg || msg;
    let continuousMeta = preprocessed?.meta || effectiveMsg.__continuousMessageMeta || null;
    if (!continuousMeta) {
      const syntheticContinuousMeta = cheapParseMessageEntry(effectiveMsg, {
        effectiveBotQQ
      });
      await resolveContinuousEntryDetails(syntheticContinuousMeta, {
        effectiveBotQQ,
        resolveReply: Boolean(syntheticContinuousMeta.replyMessageId),
        resolveForward: Array.isArray(syntheticContinuousMeta.forwardIds) && syntheticContinuousMeta.forwardIds.length > 0,
        resolveCards: Array.isArray(syntheticContinuousMeta.qqCardUrls) && syntheticContinuousMeta.qqCardUrls.length > 0
      });
      syntheticContinuousMeta.sessionKey = '';
      syntheticContinuousMeta.freshnessSessionKey = rawInboundFreshnessSessionKey;
      syntheticContinuousMeta.flushVersion = rawInboundFreshnessVersion;
      syntheticContinuousMeta.firstTimestamp = syntheticContinuousMeta.firstTimestamp || syntheticContinuousMeta.timestamp || Date.now();
      syntheticContinuousMeta.lastTimestamp = syntheticContinuousMeta.lastTimestamp || syntheticContinuousMeta.timestamp || Date.now();
      syntheticContinuousMeta.sourceMessageIds = Array.isArray(syntheticContinuousMeta.sourceMessageIds) && syntheticContinuousMeta.sourceMessageIds.length
        ? syntheticContinuousMeta.sourceMessageIds
        : (syntheticContinuousMeta.messageId ? [syntheticContinuousMeta.messageId] : []);
      syntheticContinuousMeta.flushReason = String(syntheticContinuousMeta.flushReason || 'single_message').trim() || 'single_message';
      continuousMeta = syntheticContinuousMeta;
      effectiveMsg.__continuousMessageMeta = continuousMeta;
    }
    if (continuousMeta && typeof continuousMeta === 'object') {
      continuousMeta.freshnessSessionKey = String(continuousMeta.freshnessSessionKey || rawInboundFreshnessSessionKey || '').trim();
      continuousMeta.flushVersion = Number(continuousMeta.flushVersion || rawInboundFreshnessVersion || 0) || 0;
    }
    updateSessionFreshnessVersion(
      String(continuousMeta?.freshnessSessionKey || continuousMeta?.sessionKey || '').trim(),
      Number(continuousMeta?.flushVersion || 0) || 0
    );
    const freshnessGuard = buildFreshnessGuard(continuousMeta);
    const rawText = effectiveMsg.raw_message || '';
    const inboundSessionKey = rawInboundFreshnessSessionKey;
    const isPrivateInbound = isPrivateChatType(chatType);
    const concurrencyScope = isPrivateInbound ? 'private' : 'default';
    const concurrencyLane = isAdminUser(senderId) ? 'admin' : 'general';
    const selectedInboundConcurrency = isPrivateInbound ? privateInboundConcurrency : inboundConcurrency;
    const inboundPool = isPrivateInbound ? 'private' : 'default';
    const queueWaitStartedAt = Date.now();
    const inboundLock = await selectedInboundConcurrency.acquire({
      userId: senderId,
      sessionKey: inboundSessionKey,
      lane: concurrencyLane,
      messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
      groupId,
      chatType,
      concurrencyScope,
      privilegedPrivateChat
    });
    const inboundSnapshot = selectedInboundConcurrency.getSnapshot();
    appendTraceTiming('message_ingress_lock_acquired', {
      stage: 'inbound_lock_acquired',
      messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
      groupId: String(groupId || '').trim(),
      userId: String(senderId || '').trim(),
      chatType,
      concurrencyLane,
      concurrencyScope,
      privilegedPrivateChat,
      queueWaitMs: Math.max(0, Date.now() - queueWaitStartedAt),
      inbound_wait_ms: Number(inboundLock?.waitMs || 0) || 0,
      inbound_lane: String(inboundLock?.lane || concurrencyLane).trim() || concurrencyLane,
      inbound_pool: inboundPool,
      inbound_request_id: String(inboundLock?.requestId || '').trim(),
      inbound_active_total: Number(inboundSnapshot?.totalActive || 0) || 0,
      inbound_active_general: Number(inboundSnapshot?.activeGeneral || 0) || 0,
      inbound_active_admin: Number(inboundSnapshot?.activeAdmin || 0) || 0,
      foreground_wait_ms: Number(inboundLock?.waitMs || 0) || 0,
      foreground_lane: String(inboundLock?.lane || concurrencyLane).trim() || concurrencyLane,
      foreground_request_id: String(inboundLock?.requestId || '').trim(),
      foreground_active_total: Number(inboundSnapshot?.totalActive || 0) || 0,
      foreground_active_general: Number(inboundSnapshot?.activeGeneral || 0) || 0,
      foreground_active_admin: Number(inboundSnapshot?.activeAdmin || 0) || 0,
      rawMessageTimestampMs,
      lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
    });
    let inboundHadError = false;

    try {
      appendTraceTiming('message_ingress_route_entry', {
        stage: 'inbound_route_entry',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
      });
      // source-compat anchor: msg: effectiveMsg,

      const slashCommandText = stripLeadingCqControlSegments(rawText, effectiveBotQQ);
      const logMemoryWriteSkip = (reason = '', extra = {}) => {
        const payload = {
          stage: 'memory_write_skipped',
          reason: String(reason || '').trim(),
          messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
          groupId: String(groupId || '').trim(),
          userId: String(senderId || '').trim(),
          chatType,
          rawMessageTimestampMs,
          elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
          lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
          ...extra
        };
        appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, payload);
        console.log('[memory-write] skipped', payload);
      };
      if (!isPrivateChatType(chatType)) {
        recordHumanInbound(groupId, senderId, Number(effectiveMsg?.time ? Number(effectiveMsg.time) * 1000 : Date.now()));
      }

    if (/^\s*\/meme(?:\s|$)/i.test(String(slashCommandText || '').trim())) {
      if (isPrivateChatType(chatType) && !canBypassPrivateGroupOnly({
        chatType,
        userId: senderId,
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
        logMemoryWriteSkip('special_command_private_blocked', { command: 'dailyshare' });
        return;
      }
      const memeAdminResult = await handleAdminCommand({
        rawText: slashCommandText,
        groupId,
        userId: senderId
      });
      if (String(memeAdminResult?.replyText || '').trim()) {
        await sendGroupReply({
          chatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: memeAdminResult.replyText,
          atSender: true,
          retries: 1,
          waitMs: 300
        });
      }
      logMemoryWriteSkip('special_command', { command: 'meme' });
      return;
    }

    if (/^\s*\/dailyshare(?:\s|$)/i.test(String(slashCommandText || '').trim())) {
      if (isPrivateChatType(chatType) && !canBypassPrivateGroupOnly({
        chatType,
        userId: senderId,
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
        logMemoryWriteSkip('special_command_private_blocked', { command: 'life' });
        return;
      }
      const dailyShareResult = await getDailyShareEngine().handleAdminCommand({
        rawText: slashCommandText,
        groupId,
        userId: senderId,
        sendWithRetry,
        askAIByGraph
      });
      if (String(dailyShareResult?.replyText || '').trim()) {
        await sendGroupReply({
          chatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: dailyShareResult.replyText,
          atSender: true,
          retries: 1,
          waitMs: 300
        });
      }
      logMemoryWriteSkip('special_command', { command: 'dailyshare' });
      return;
    }

    if (/^\s*\/life(?:\s|$)/i.test(String(slashCommandText || '').trim())) {
      if (isPrivateChatType(chatType) && !canBypassPrivateGroupOnly({
        chatType,
        userId: senderId,
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
        logMemoryWriteSkip('special_command_private_blocked', { command: 'sr' });
        return;
      }
      const lifeResult = await lifeSchedulerEngine.handleAdminCommand({
        rawText: slashCommandText,
        groupId,
        userId: senderId,
        sendWithRetry,
        askAIByGraph
      });
      if (String(lifeResult?.replyText || '').trim()) {
        await sendGroupReply({
          chatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: lifeResult.replyText,
          atSender: true,
          retries: 1,
          waitMs: 300
        });
      }
      logMemoryWriteSkip('special_command', { command: 'life' });
      return;
    }

    if (/^\s*\/sr(?:\s|$)/i.test(String(slashCommandText || '').trim())) {
      if (isPrivateChatType(chatType) && !canBypassPrivateGroupOnly({
        chatType,
        userId: senderId,
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
        logMemoryWriteSkip('special_command_private_blocked', { command: 'initiative' });
        return;
      }
      const srResult = await handleSessionSummaryCommand({
        rawText: slashCommandText,
        groupId,
        senderId,
        summarizeSessionContext: sessionSummaryGenerator
      });
      if (String(srResult?.replyText || '').trim()) {
        await sendGroupReply({
          chatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: srResult.replyText,
          atSender: true,
          retries: 1,
          waitMs: 300
        });
      }
      logMemoryWriteSkip('special_command', { command: 'sr' });
      return;
    }

    if (/^\s*\/restart\s*$/i.test(String(slashCommandText || '').trim())) {
      const restartResult = await handleRestartAdminCommand({
        rawText: slashCommandText,
        groupId,
        userId: senderId
      });
      if (String(restartResult?.replyText || '').trim()) {
        await sendGroupReply({
          chatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: restartResult.replyText,
          atSender: true,
          retries: 1,
          waitMs: 300
        });
      }
      if (restartResult?.restartRequested) {
        triggerRemoteRestart({ delayMs: 800 });
      }
      logMemoryWriteSkip('special_command', { command: 'restart' });
      return;
    }

    if (/^\s*\/initiative(?:\s|$)/i.test(String(slashCommandText || '').trim())) {
      if (isPrivateChatType(chatType) && !canBypassPrivateGroupOnly({
        chatType,
        userId: senderId,
