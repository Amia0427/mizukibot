const { shouldUseFullMultiAgent } = require('./helpers');

function createAdminTaskHandlers(deps = {}) {
  const {
    config,
    routeExecution,
    askToolTaskWithSubagentReview,
    runBackgroundToolTask,
    isAdminUser,
    sendGroupReply,
    normalizeUserFacingReply
  } = deps;

  function hasAdminAccess(route = {}, senderId = '') {
    if (typeof isAdminUser === 'function') {
      return isAdminUser(senderId);
    }
    return Boolean(route?.meta?.admin);
  }

  async function handleFullAdminCommand({
    route,
    groupId,
    senderId,
    userInfo,
    rawText
  }) {
    const command = route?.meta?.command || {};
    const payload = String(command.payload || command.args?.[0] || '').trim();
    if (!hasAdminAccess(route, senderId)) {
      await sendGroupReply({
        groupId,
        senderId,
        replyText: '只有管理员可以使用 /full。',
        atSender: true,
        retries: 1,
        waitMs: 300
      });
      return true;
    }

    if (!payload) {
      await sendGroupReply({
        groupId,
        senderId,
        replyText: '/full 后面需要跟具体任务。',
        atSender: true,
        retries: 1,
        waitMs: 300
      });
      return true;
    }

    const routeExecutionPlan = routeExecution.resolveRouteExecution(route, config, {});
    const sessionChatId = `group_${groupId}_user_${senderId}`;
    const fullPrompt = [
      '这是 /full 管理员任务。',
      '请按 direct_chat 的真实目标完成，不要只做表面回复。',
      payload
    ].join('\n\n');

    const useFullMultiAgent = shouldUseFullMultiAgent(config, payload, {
      routeMeta: route?.meta || {}
    });

    if (config.BACKGROUND_TOOL_TASKS_ENABLED) {
      await runBackgroundToolTask({
        route,
        routeExecutionPlan,
        cleanText: payload,
        imageUrl: route?.imageUrl || null,
        userInfo,
        senderId,
        groupId,
        toolTaskOptions: {
          routePrompt: fullPrompt,
          subagentRoutePrompt: fullPrompt,
          backendOverride: 'openclaw',
          sessionChannel: 'qq-group',
          sessionChatId,
          routePolicyKey: 'admin/full',
          topRouteType: 'admin',
          routeMeta: {
            ...(route?.meta || {}),
            groupId,
            topRouteType: 'admin',
            routePolicyKey: 'admin/full'
          }
        },
        initialStage: useFullMultiAgent ? 'planning' : 'running'
      });
      return true;
    }

    const reply = await askToolTaskWithSubagentReview(payload, userInfo, senderId, null, route?.imageUrl || null, {
      routePrompt: fullPrompt,
      subagentRoutePrompt: fullPrompt,
      backendOverride: 'openclaw',
      sessionChannel: 'qq-group',
      sessionChatId,
      routePolicyKey: 'admin/full',
      topRouteType: 'admin',
      routeMeta: {
        ...(route?.meta || {}),
        groupId,
        topRouteType: 'admin',
        routePolicyKey: 'admin/full',
        rawText
      }
    });

    await sendGroupReply({
      groupId,
      senderId,
      replyText: normalizeUserFacingReply(reply, {
        policyKey: 'admin/full',
        routeDebugKey: 'admin/full',
        topRouteType: 'admin',
        allowTools: false,
        subagentRefill: true,
        requestText: payload
      }),
      atSender: true,
      retries: 1,
      waitMs: 300
    });
    return true;
  }

  async function handleClaudeAdminCommand({
    route,
    groupId,
    senderId,
    userInfo,
    rawText,
    chatType = 'group'
  }) {
    const normalizedChatType = String(chatType || '').trim().toLowerCase() === 'private' ? 'private' : 'group';
    const command = route?.meta?.command || {};
    const payload = String(command.payload || command.args?.[0] || '').trim();
    if (!hasAdminAccess(route, senderId)) {
      await sendGroupReply({
        chatType: normalizedChatType,
        groupId,
        userId: senderId,
        senderId,
        replyText: '仅管理员可用。',
        atSender: normalizedChatType !== 'private',
        retries: 1,
        waitMs: 300
      });
      return true;
    }

    if (!payload) {
      await sendGroupReply({
        chatType: normalizedChatType,
        groupId,
        userId: senderId,
        senderId,
        replyText: '/claude 后面需要跟具体任务。',
        atSender: normalizedChatType !== 'private',
        retries: 1,
        waitMs: 300
      });
      return true;
    }

    const sessionChatId = normalizedChatType === 'private'
      ? `direct_${senderId}`
      : `group_${groupId}_user_${senderId}`;
    const reply = await askToolTaskWithSubagentReview(payload, userInfo, senderId, null, route?.imageUrl || null, {
      routePrompt: payload,
      subagentRoutePrompt: payload,
      backendOverride: 'command',
      sessionChannel: normalizedChatType === 'private' ? 'qq-private' : 'qq-group',
      sessionChatId,
      routePolicyKey: 'admin/claude',
      topRouteType: 'admin',
      routeMeta: {
        ...(route?.meta || {}),
        groupId,
        chatType: normalizedChatType,
        topRouteType: 'admin',
        routePolicyKey: 'admin/claude',
        rawText
      }
    });

    await sendGroupReply({
      chatType: normalizedChatType,
      groupId,
      userId: senderId,
      senderId,
      replyText: normalizeUserFacingReply(reply, {
        policyKey: 'admin/claude',
        routeDebugKey: 'admin/claude',
        topRouteType: 'admin',
        allowTools: false,
        subagentRefill: true,
        requestText: payload
      }),
      atSender: normalizedChatType !== 'private',
      retries: 1,
      waitMs: 300
    });
    return true;
  }

  return {
    hasAdminAccess,
    handleFullAdminCommand,
    handleClaudeAdminCommand
  };
}

module.exports = {
  createAdminTaskHandlers
};
