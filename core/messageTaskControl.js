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
    config,
    hapiControlRuntime = null,
    createHapiControlClient = null
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
    const remoteSession = hapiControlRuntime?.getSession(sessionId) || null;
    const pendingApproval = hapiControlRuntime?.findPendingApprovalBySession(sessionId) || null;

    if (command.type === 'status') {
      await sendGroupReply({
        groupId,
        senderId,
        replyText: [
          buildSessionStatusReply(session || remoteSession, activeTask),
          pendingApproval ? `待处理权限请求：${String(pendingApproval.summary || 'remote permission request').trim()}` : ''
        ].filter(Boolean).join('\n'),
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

    if (command.type === 'approve' || command.type === 'deny') {
      const approvalId = String(command.payload || '').trim();
      const approval = approvalId
        ? hapiControlRuntime?.getApproval(approvalId)
        : pendingApproval;
      if (!approval || !createHapiControlClient) {
        await sendGroupReply({
          groupId,
          senderId,
          replyText: '当前没有待处理的远程权限请求。',
          atSender: true,
          retries: 1,
          waitMs: 300
        });
        return true;
      }

      try {
        const client = createHapiControlClient();
        const resolution = command.type === 'approve' ? 'approve' : 'deny';
        const action = resolution === 'approve' ? 'approve' : 'deny';
        const requestId = String(approval.request_id || approval.id || '').trim();
        await client.post(
          `/api/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}/${action}`,
          {
            note: resolution === 'approve' ? 'approved from QQ control' : 'denied from QQ control'
          }
        );
        hapiControlRuntime.resolveApproval(String(approval.id || '').trim(), resolution, `resolved by ${senderId}`);
        await sendGroupReply({
          groupId,
          senderId,
          replyText: resolution === 'approve' ? '已批准远程权限请求。' : '已拒绝远程权限请求。',
          atSender: true,
          retries: 1,
          waitMs: 300
        });
      } catch (error) {
        await sendGroupReply({
          groupId,
          senderId,
          replyText: `远程权限处理失败：${String(error?.message || error || 'unknown error').trim()}`,
          atSender: true,
          retries: 1,
          waitMs: 300
        });
      }
      return true;
    }

    if (command.type === 'switch_agent') {
      const machineId = String(command.payload || '').trim();
      if (!machineId || !createHapiControlClient) {
        await sendGroupReply({
          groupId,
          senderId,
          replyText: '请发送“切 agent codex-local”或“切 agent claude-local”。',
          atSender: true,
          retries: 1,
          waitMs: 300
        });
        return true;
      }

      try {
        const client = createHapiControlClient();
        await client.post(`/api/sessions/${encodeURIComponent(sessionId)}/switch`, {
          machineId
        });
        hapiControlRuntime?.markSessionEvent(sessionId, {
          machine_id: machineId,
          status: 'idle',
          last_event_type: 'switch'
        });
        await sendGroupReply({
          groupId,
          senderId,
          replyText: `远程会话已切换到 ${machineId}。`,
          atSender: true,
          retries: 1,
          waitMs: 300
        });
      } catch (error) {
        await sendGroupReply({
          groupId,
          senderId,
          replyText: `切换远程 agent 失败：${String(error?.message || error || 'unknown error').trim()}`,
          atSender: true,
          retries: 1,
          waitMs: 300
        });
      }
      return true;
    }

    if (command.type === 'resume_session') {
      if (!createHapiControlClient) {
        await sendGroupReply({
          groupId,
          senderId,
          replyText: '当前未启用远程 HAPI 控制。',
          atSender: true,
          retries: 1,
          waitMs: 300
        });
        return true;
      }

      try {
        const client = createHapiControlClient();
        await client.post(`/api/sessions/${encodeURIComponent(sessionId)}/resume`, {
          reason: String(command.payload || '').trim() || 'resumed from QQ control'
        });
        hapiControlRuntime?.markSessionEvent(sessionId, {
          status: 'running',
          last_event_type: 'resume'
        });
        await sendGroupReply({
          groupId,
          senderId,
          replyText: '远程会话已请求恢复。',
          atSender: true,
          retries: 1,
          waitMs: 300
        });
      } catch (error) {
        await sendGroupReply({
          groupId,
          senderId,
          replyText: `重连远程会话失败：${String(error?.message || error || 'unknown error').trim()}`,
          atSender: true,
          retries: 1,
          waitMs: 300
        });
      }
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
