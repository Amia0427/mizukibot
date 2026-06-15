function createMessageBackgroundTaskCoordinator(deps = {}) {
  const {
    config,
    buildSessionId,
    backgroundTaskRuntime,
    normalizeUserFacingReply,
    getEffectivePolicyKey,
    summarizeBackgroundReply,
    sendGroupReply,
    maybeSendMemeFollowup,
    sendWithRetry
  } = deps;

  function getBackgroundTaskAckDelayMs(runtimeConfig) {
    const n = Number(runtimeConfig?.BACKGROUND_TASK_ACK_DELAY_MS);
    if (!Number.isFinite(n)) return 2500;
    return Math.max(20, Math.floor(n));
  }

  async function runBackgroundToolTask({
    route,
    routeExecutionPlan,
    cleanText,
    imageUrl,
    imageUrls = [],
    userInfo,
    senderId,
    groupId,
    toolTaskOptions,
    executionHandleFactory,
    sendAckOnly = false,
    initialStage = 'running'
  }) {
    const sessionId = buildSessionId(senderId, {
      sessionChannel: 'qq-group',
      sessionChatId: `group_${groupId}_user_${senderId}`
    });

    const task = backgroundTaskRuntime.startTask({
      sessionKey: sessionId,
      executorType: String(routeExecutionPlan?.executor || 'background_direct').trim() || 'background_direct',
      groupId,
      userId: senderId,
      originalText: cleanText,
      effectiveText: cleanText,
      routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
      topRouteType: routeExecutionPlan.topRouteType
    });

    const runExecution = typeof executionHandleFactory === 'function'
      ? executionHandleFactory
      : async (nextText, nextUserInfo, nextSenderId, nextImageUrl, nextOptions) => ({
          promise: Promise.resolve(deps.askToolTaskLocally(nextText, nextUserInfo, nextSenderId, null, nextImageUrl, nextOptions)),
          cancel() {}
        });
    if (typeof executionHandleFactory !== 'function' && typeof deps.askToolTaskLocally !== 'function') {
      throw new Error('background tool task requires executionHandleFactory or askToolTaskLocally');
    }

    const backgroundImageUrls = Array.isArray(imageUrls) && imageUrls.length > 0
      ? imageUrls
      : (Array.isArray(toolTaskOptions?.imageUrls) ? toolTaskOptions.imageUrls : []);
    const executionHandle = await runExecution(cleanText, userInfo, senderId, imageUrl, {
      ...toolTaskOptions,
      imageUrls: backgroundImageUrls,
      deferPersist: false,
      backgroundTaskId: task.id,
      shouldContinue: () => backgroundTaskRuntime.shouldContinue(task.id)
    });

    backgroundTaskRuntime.attachController(task.id, {
      cancel(reason = 'cancelled') {
        return executionHandle.cancel(reason);
      }
    });
    backgroundTaskRuntime.markTaskRunning(task.id, initialStage);

    const finalizeSuccess = (rawReply) => {
      const normalizedReply = normalizeUserFacingReply(rawReply, {
        routeDebugKey: routeExecutionPlan?.routeDebugKey || getEffectivePolicyKey(routeExecutionPlan),
        topRouteType: routeExecutionPlan.topRouteType,
        allowTools: routeExecutionPlan.allowTools,
        requestText: cleanText
      });
      const currentTask = backgroundTaskRuntime.getTask(task.id);
      const retainSession = Boolean(currentTask?.ack_sent || sendAckOnly);
      backgroundTaskRuntime.finalizeTask(task.id, {
        status: normalizedReply ? 'completed' : (currentTask?.status || 'completed'),
        stage: normalizedReply ? 'completed' : (currentTask?.stage || 'completed'),
        replyText: normalizedReply,
        latestSummary: summarizeBackgroundReply(normalizedReply),
        retainSession,
        followupSent: Boolean(currentTask?.followup_sent)
      });
      return normalizedReply;
    };

    const finalizeFailure = (err) => {
      if (err && /cancelled/i.test(String(err?.message || ''))) {
        backgroundTaskRuntime.requestCancel(task.id, {
          error: 'cancelled',
          reason: 'cancelled'
        });
        return '';
      }
      const currentTask = backgroundTaskRuntime.getTask(task.id);
      backgroundTaskRuntime.finalizeTask(task.id, {
        status: 'failed',
        stage: 'failed',
        error: err?.message || String(err || 'unknown error'),
        latestSummary: '',
        replyText: '',
        retainSession: Boolean(currentTask?.ack_sent || sendAckOnly)
      });
      return '????????????????????????????????????';
    };

    const toFailureOutcome = (error) => ({
      done: true,
      status: 'failed',
      reply: finalizeFailure(error),
      error
    });
    const replyPromise = executionHandle.promise.then(
      (rawReply) => ({
        done: true,
        status: 'completed',
        reply: finalizeSuccess(rawReply)
      }),
      toFailureOutcome
    ).catch(toFailureOutcome);

    const ackDelayMs = getBackgroundTaskAckDelayMs(config);
    const ackRace = await Promise.race([
      replyPromise,
      new Promise((resolve) => setTimeout(() => resolve({ done: false, status: 'timeout', timeout: true }), ackDelayMs))
    ]);

    if (ackRace.done) {
      const latest = backgroundTaskRuntime.getTask(task.id);
      if (latest?.ack_sent) {
        if (backgroundTaskRuntime.canEmitFollowup(task.id)) {
          const sent = await sendGroupReply({
            groupId,
            senderId,
            replyText: ackRace.reply,
            atSender: true,
            retries: 2,
            waitMs: 500
          });
          if (sent) {
            backgroundTaskRuntime.markFollowupSent(task.id, true);
            await maybeSendMemeFollowup({
              surface: 'direct',
              groupId,
              senderId,
              sendWithRetry,
              routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
              topRouteType: routeExecutionPlan.topRouteType,
              userText: cleanText,
              replyText: ackRace.reply,
              routeMeta: route.meta || {}
            });
          }
        }
        return { reply: '', usedStreamingSend: true, replyOptions: null, backgroundHandled: true };
      }
      return {
        reply: ackRace.reply,
        usedStreamingSend: false,
        replyOptions: null,
        backgroundHandled: false
      };
    }

    const ackText = '这类任务我先在后台跑。你可以随时发“任务状态”“取消任务”“结束任务”，或用“任务补充 ...”追加要求。';
    const sentAck = await sendGroupReply({
      groupId,
      senderId,
      replyText: ackText,
      atSender: true,
      retries: 1,
      waitMs: 300
    });
    if (sentAck) {
      backgroundTaskRuntime.markAckSent(task.id, true);
    }

    replyPromise.then(async (outcome) => {
      if (outcome?.status === 'failed') return;
      const finalReply = outcome?.reply;
      if (!String(finalReply || '').trim()) return;
      if (!backgroundTaskRuntime.canEmitFollowup(task.id)) return;

      const sent = await sendGroupReply({
        groupId,
        senderId,
        replyText: finalReply,
        atSender: true,
        retries: 2,
        waitMs: 500
      });
      if (!sent) return;

      backgroundTaskRuntime.markFollowupSent(task.id, true);
      await maybeSendMemeFollowup({
        surface: 'direct',
        groupId,
        senderId,
        sendWithRetry,
        routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
        topRouteType: routeExecutionPlan.topRouteType,
        userText: cleanText,
        replyText: finalReply,
        routeMeta: route.meta || {}
      });
    }).catch(() => {});

    return {
      reply: '',
      usedStreamingSend: true,
      replyOptions: null,
      backgroundHandled: true
    };
  }

  return {
    runBackgroundToolTask
  };
}

module.exports = {
  createMessageBackgroundTaskCoordinator
};
