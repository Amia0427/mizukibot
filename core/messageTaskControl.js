function createMessageTaskControlCoordinator(deps = {}) {
  const {
    buildSessionId,
    buildNoTaskControlText,
    buildSessionStatusReply,
    buildSupplementedTaskText,
    buildSubagentContextSummary,
    routeResolver,
    planDirectChat,
    routeExecution,
    backgroundTaskRuntime,
    buildRoutePromptBundle,
    getStreamMaxSegments,
    buildToolGuidancePrompt,
    buildBridgeGuidancePrompt,
    buildStreamingSegmentationPrompt,
    shouldPreferQqRichReply,
    buildQqRichReplyPrompt,
    getEffectivePolicyKey,
    sendGroupReply,
    runBackgroundToolTask,
    config
  } = deps;

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
        replyText: cancelled ? '??????????' : buildNoTaskControlText(),
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
        replyText: closed ? '????????????' : buildNoTaskControlText(),
        atSender: true,
        retries: 1,
        waitMs: 300
      });
      return true;
    }

    if (command.type === 'supplement') {
      if (!String(command.payload || '').trim()) {
        await sendGroupReply({
          groupId,
          senderId,
          replyText: '???????????????? ...??????? ...??',
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
      const routerContextSummary = buildSubagentContextSummary(senderId, groupId, { maxLength: 180 });
      const plannerContextSummary = buildSubagentContextSummary(senderId, groupId, { maxLength: 320 });
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
          contextSummary: plannerContextSummary
        });
        route.meta = {
          ...(route.meta || {}),
          directChatPlanner: plannerDecision
        };
      }
      const routeExecutionPlan = routeExecution.resolveRouteExecution(route, config, {});

      if (String(routeExecutionPlan.executor || '').trim() !== 'background_direct' && !routeExecutionPlan.allowTools) {
        await sendGroupReply({
          groupId,
          senderId,
          replyText: '????????????????????????????????????????????',
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
        buildBridgeGuidancePrompt: (currentRoute) => buildBridgeGuidancePrompt(currentRoute, config.SUBAGENT_BACKEND || 'command', routeExecutionPlan),
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
          routeMeta: {
            ...(route.meta || {}),
            groupId,
            topRouteType: routeExecutionPlan.topRouteType,
            routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
            allowedTools: routeExecutionPlan.allowedTools
          }
        },
        sendAckOnly: false
      });
      return true;
    }

    return false;
  }

  return {
    handleBackgroundTaskControl
  };
}

module.exports = {
  createMessageTaskControlCoordinator
};
