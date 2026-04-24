const { buildRoutePromptBundle } = require('../utils/routePromptPolicy');
const { buildSessionId } = require('../api/subagentSessionManager');
const { getClaudeSessionRuntime } = require('../utils/claudeSessionRuntime');
const { buildImageModelConfig } = require('../utils/imageModelConfigResolver');
const {
  buildReplyEnvelope,
  buildRouteDecisionContext
} = require('./messageContracts');
const { buildLlmPerception } = require('./llmPerception');
const { buildRouteMetaEnvelope } = require('./executablePlan');
const {
  formatGroupMainModelStreamStatus,
  setGroupMainModelStreamEnabled,
  setGroupPublic,
  shouldForceDisableGroupMainModelStream
} = require('../utils/groupMainModelStreamPolicy');

function parseJsonTail(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON must be an object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`JSON 解析失败: ${error.message || error}`);
  }
}

function buildUnavailableRouteReply(route = {}, routeExecutionPlan = {}, { isAdminUser } = {}) {
  const unavailableReason = String(routeExecutionPlan?.unavailableReason || '').trim().toLowerCase();
  if (unavailableReason === 'private-group-only') {
    const command = String(route?.meta?.command?.cmd || '').trim().toLowerCase();
    if (command === 'full') {
      return '私聊不支持 /full，请在目标群内 @我后使用。';
    }
    return '该能力当前仅支持群聊中使用，请在目标群内 @我。';
  }
  if (unavailableReason === 'private-write-disabled') {
    return '私聊当前仅支持问答和只读能力，暂不支持执行动作。';
  }
  if (unavailableReason !== 'no-allowed-tools') {
    return 'The required tool is temporarily unavailable. Please try again later.';
  }

  const qqActionKey = String(route?.meta?.qqActionKey || '').trim().toLowerCase();
  const userId = String(route?.meta?.userId || '').trim();
  const adminUser = typeof isAdminUser === 'function' ? isAdminUser(userId) : false;

  if (qqActionKey === 'qq_publish_qzone') {
    return adminUser
      ? 'QQ 空间发布工具暂时不可用。你可以稍后重试，或直接使用 /qzone_post。'
      : 'QQ 空间发布当前仅管理员可用。';
  }

  if (qqActionKey === 'qq_schedule_qzone') {
    return adminUser
      ? '定时 QQ 空间工具暂时不可用。你可以稍后重试，或直接使用 /schedule_create。'
      : '定时 QQ 空间发布当前仅管理员可用。';
  }

  if (qqActionKey === 'qq_schedule_message') {
    return '定时消息工具当前不可用。你可以换个更清晰的时间表达再试一次。';
  }

  return '这轮没有可用工具可以处理这个请求。你可以稍后重试，或把需求说得更具体一些。';
}

function buildQzoneAutodraftPrompt(requestText = '') {
  return [
    '你现在只负责代写一条可以直接发布到 QQ 空间的中文正文。',
    '必须使用第一人称，语气自然，像今天写的日记或状态。',
    '优先根据用户原话推断主题、心情、长度和风格。',
    '默认写成 80 到 180 字。',
    '不要解释，不要提问，不要使用标题、项目符号、引号、标签或前缀。',
    '不要提到自己是 AI。',
    '只输出最终可发布正文。',
    `用户请求: ${String(requestText || '').trim()}`
  ].join('\n');
}

function buildSupplementedTaskText(session = {}, supplement = '') {
  const parts = [];
  const originalText = String(session?.original_text || '').trim();
  const latestSummary = String(session?.latest_summary || session?.latest_result_excerpt || '').trim();
  const cleanSupplement = String(supplement || '').trim();

  if (originalText) parts.push(`原始请求：${originalText}`);
  if (latestSummary) parts.push(`最近结果摘要：${latestSummary}`);
  if (cleanSupplement) parts.push(`补充要求：${cleanSupplement}`);

  return parts.join('\n');
}

function composeDirectRoutePrompt({
  toolGuidancePrompt = null,
  bridgeGuidancePrompt = null,
  perceptionPrompt = null,
  safetyBoundaryRoutePrompt = null,
  streamingSegmentationPrompt = null,
  qqRichReplyPrompt = null
} = {}) {
  return [
    toolGuidancePrompt,
    bridgeGuidancePrompt,
    perceptionPrompt,
    safetyBoundaryRoutePrompt,
    streamingSegmentationPrompt,
    qqRichReplyPrompt
  ].filter(Boolean).join('\n\n');
}

function resolveVisionFallbackModelConfig(route = {}, imageUrl = null, userId = '') {
  if (!String(imageUrl || '').trim()) return null;
  const visualContext = route?.meta?.visualContext && typeof route.meta.visualContext === 'object'
    ? route.meta.visualContext
    : null;
  if (!visualContext || visualContext?.worker?.succeeded === true) return null;
  return buildImageModelConfig(null, userId, { routeMeta: route?.meta || {} });
}

function parseToggleSubcommand(command = {}) {
  return String(command?.args?.[0] || command?.payload || 'status').trim().toLowerCase() || 'status';
}

function handleGroupPublicAdminCommand(command = {}, groupId = '', senderId = '') {
  if (!String(groupId || '').trim()) return '仅群聊可用。';
  const subcommand = parseToggleSubcommand(command);
  if (subcommand === 'status') return formatGroupMainModelStreamStatus(groupId);
  if (subcommand === 'on') {
    setGroupPublic(groupId, true, senderId, Date.now());
    return '已开启当前群公开群标记。\n主模型流式默认仍为关闭。\n如需开启，请发送 /main_stream on';
  }
  if (subcommand === 'off') {
    setGroupPublic(groupId, false, senderId, Date.now());
    return '已关闭当前群公开群标记，并移除主模型流式配置。';
  }
  return '用法: /group_public on|off|status';
}

function handleMainStreamAdminCommand(command = {}, groupId = '', senderId = '') {
  if (!String(groupId || '').trim()) return '仅群聊可用。';
  const subcommand = parseToggleSubcommand(command);
  if (subcommand === 'status') return formatGroupMainModelStreamStatus(groupId);
  if (subcommand === 'on') {
    const result = setGroupMainModelStreamEnabled(groupId, true, senderId, Date.now());
    return result.ok ? '已开启当前群主模型流式。' : '请先 /group_public on';
  }
  if (subcommand === 'off') {
    const result = setGroupMainModelStreamEnabled(groupId, false, senderId, Date.now());
    return result.ok ? '已关闭当前群主模型流式。' : '请先 /group_public on';
  }
  return '用法: /main_stream on|off|status';
}

function createMessageRouteFlow(deps = {}) {
  const {
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
    sendGroupReply,
    sendReply,
    updateFavor,
    saveData,
    recordMemoryScope,
    buildToolGuidancePrompt,
    buildBridgeGuidancePrompt,
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
    buildSubagentContextSummary
  } = deps;
  const claudeSessionRuntime = getClaudeSessionRuntime();

  function isAdminPrivateChat(chatType = '', senderId = '') {
    return String(chatType || '').trim().toLowerCase() === 'private'
      && typeof isAdminUser === 'function'
      && isAdminUser(senderId);
  }

  function buildClaudeSessionKey(chatType = '', senderId = '', groupId = '') {
    return buildSessionId(senderId, {
      sessionChannel: String(chatType || '').trim().toLowerCase() === 'private' ? 'qq-private' : 'qq-group',
      sessionChatId: String(chatType || '').trim().toLowerCase() === 'private'
        ? `direct_${senderId}`
        : `group_${groupId}_user_${senderId}`
    });
  }

  async function runClaudeWrapperMetadata(message = '', session = null) {
    const child_process = require('child_process');
    const scriptPath = 'D:/waifu/scripts/hapi-runners/run-claude.ps1';
    const workspaceRoot = 'D:/waifu';
    const args = [
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-Message',
      String(message || '').trim(),
      '-WorkspaceRoot',
      workspaceRoot,
      '-ReturnMetadata'
    ];
    const resumeSessionId = String(session?.claude_session_id || '').trim();
    if (resumeSessionId) {
      args.push('-ResumeSessionId', resumeSessionId);
    }

    return new Promise((resolve, reject) => {
      const child = child_process.spawn(
        'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
        args,
        {
          cwd: workspaceRoot,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        }
      );

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (buf) => { stdout += String(buf); });
      child.stderr.on('data', (buf) => { stderr += String(buf); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (Number(code) !== 0) {
          return reject(new Error(String(stderr || stdout || `claude wrapper exited with code ${code}`)));
        }
        try {
          const parsed = JSON.parse(String(stdout || '').trim());
          return resolve(parsed);
        } catch (error) {
          return reject(new Error(`claude metadata parse failed: ${error.message || error}`));
        }
      });
    });
  }

  async function handleClaudeSessionAdminCommand({
    route,
    groupId,
    senderId,
    chatType = 'group'
  }) {
    const normalizedChatType = String(chatType || '').trim().toLowerCase() === 'private' ? 'private' : 'group';
    if (!isAdminPrivateChat(normalizedChatType, senderId)) {
      await sendGroupReply({
        chatType: normalizedChatType,
        groupId,
        userId: senderId,
        senderId,
        replyText: '仅管理员私聊可用。',
        atSender: false,
        retries: 1,
        waitMs: 300
      });
      return true;
    }

    const command = route?.meta?.command || {};
    const cmd = String(command.cmd || '').trim().toLowerCase();
    const payload = String(command.payload || '').trim();
    const sessionKey = buildClaudeSessionKey(normalizedChatType, senderId, groupId);
    const currentSession = claudeSessionRuntime.getSession(sessionKey);

    if (cmd === 'claude-open') {
      if (currentSession && ['open', 'running', 'idle'].includes(String(currentSession.status || '').trim().toLowerCase())) {
        await sendGroupReply({
          chatType: normalizedChatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: [
            `Claude 会话已存在。`,
            `session_id: ${String(currentSession.claude_session_id || 'unknown').trim() || 'unknown'}`,
            `status: ${String(currentSession.status || 'unknown').trim() || 'unknown'}`
          ].join('\n'),
          atSender: false,
          retries: 1,
          waitMs: 300
        });
        return true;
      }

      try {
        const metadata = await runClaudeWrapperMetadata('进入会话，等待后续指令。', null);
        const nextSession = claudeSessionRuntime.openSession({
          sessionKey,
          claudeSessionId: String(metadata.session_id || '').trim(),
          transcriptPath: String(metadata.transcript_path || '').trim(),
          status: 'open',
          lastPrompt: '进入会话，等待后续指令。'
        });
        await sendGroupReply({
          chatType: normalizedChatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: [
            'Claude 会话已建立。',
            `session_id: ${String(nextSession?.claude_session_id || 'unknown').trim() || 'unknown'}`,
            `status: ${String(nextSession?.status || 'open').trim() || 'open'}`
          ].join('\n'),
          atSender: false,
          retries: 1,
          waitMs: 300
        });
      } catch (error) {
        await sendGroupReply({
          chatType: normalizedChatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: `Claude 会话创建失败：${String(error?.message || error || 'unknown error').trim()}`,
          atSender: false,
          retries: 1,
          waitMs: 300
        });
      }
      return true;
    }

    if (cmd === 'claude-send') {
      if (!currentSession || !['open', 'running', 'idle'].includes(String(currentSession.status || '').trim().toLowerCase())) {
        await sendGroupReply({
          chatType: normalizedChatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: '当前没有活跃 Claude 会话，请先发送 /claude-open。',
          atSender: false,
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
          replyText: '/claude-send 后面需要跟具体内容。',
          atSender: false,
          retries: 1,
          waitMs: 300
        });
        return true;
      }

      try {
        claudeSessionRuntime.updateSession(sessionKey, {
          status: 'running',
          last_prompt: payload,
          active_run_id: `${Date.now()}`
        });
        void runClaudeWrapperMetadata(payload, currentSession)
          .then((metadata) => {
            claudeSessionRuntime.updateSession(sessionKey, {
              claude_session_id: String(metadata.session_id || currentSession.claude_session_id || '').trim(),
              transcript_path: String(metadata.transcript_path || currentSession.transcript_path || '').trim(),
              status: 'idle',
              last_error: ''
            });
          })
          .catch((error) => {
            claudeSessionRuntime.updateSession(sessionKey, {
              status: 'failed',
              last_error: String(error?.message || error || 'unknown error').trim()
            });
          });

        await sendGroupReply({
          chatType: normalizedChatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: '已发送到 Claude 会话，使用 /claude-tail 查看输出。',
          atSender: false,
          retries: 1,
          waitMs: 300
        });
      } catch (error) {
        await sendGroupReply({
          chatType: normalizedChatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: `Claude 会话发送失败：${String(error?.message || error || 'unknown error').trim()}`,
          atSender: false,
          retries: 1,
          waitMs: 300
        });
      }
      return true;
    }

    if (cmd === 'claude-tail') {
      if (!currentSession) {
        await sendGroupReply({
          chatType: normalizedChatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: '当前没有 Claude 会话，请先发送 /claude-open。',
          atSender: false,
          retries: 1,
          waitMs: 300
        });
        return true;
      }
      const tailResult = claudeSessionRuntime.readTail(sessionKey);
      const replyText = !tailResult.ok
        ? `Claude 会话输出不可读：${tailResult.reason}`
        : (tailResult.hasNewOutput
          ? tailResult.text
          : '当前没有新的 Claude 输出。');
      await sendGroupReply({
        chatType: normalizedChatType,
        groupId,
        userId: senderId,
        senderId,
        replyText,
        atSender: false,
        retries: 1,
        waitMs: 300
      });
      return true;
    }

    if (cmd === 'claude-stop') {
      if (!currentSession) {
        await sendGroupReply({
          chatType: normalizedChatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: '当前没有可关闭的 Claude 会话。',
          atSender: false,
          retries: 1,
          waitMs: 300
        });
        return true;
      }
      claudeSessionRuntime.closeSession(sessionKey);
      await sendGroupReply({
        chatType: normalizedChatType,
        groupId,
        userId: senderId,
        senderId,
        replyText: 'Claude 会话已关闭。',
        atSender: false,
        retries: 1,
        waitMs: 300
      });
      return true;
    }

    return false;
  }

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
        initialStage: config.FULL_SUBAGENT_MULTI_AGENT_ENABLED ? 'planning' : 'running'
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
        requestText: payload
      }),
      atSender: normalizedChatType !== 'private',
      retries: 1,
      waitMs: 300
    });
    return true;
  }

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
        contextSummary: plannerContextSummary
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
      userInfo,
      senderId,
      groupId,
      inboundContext,
      freshness = null
    } = routeDecision;
    const chatType = String(route?.meta?.chatType || inboundContext?.chatType || 'group').trim().toLowerCase() === 'private'
      ? 'private'
      : 'group';
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
      buildBridgeGuidancePrompt: routeExecutionPlan?.executor === 'full_subagent'
        ? (currentRoute) => buildBridgeGuidancePrompt(currentRoute, config.SUBAGENT_BACKEND || 'command', routeExecutionPlan)
        : null,
      buildStreamingSegmentationPrompt,
      shouldPreferQqRichReply,
      buildQqRichReplyPrompt
    });
    const {
      toolGuidancePrompt,
      bridgeGuidancePrompt,
      streamingSegmentationPrompt,
      qqRichReplyPrompt,
      disableStreamForReply
    } = promptBundle;
    const safetyBoundaryRoutePrompt = buildSafetyBoundaryRoutePrompt(route);
    const perceptionBuilder = typeof injectedBuildLlmPerception === 'function'
      ? injectedBuildLlmPerception
      : buildLlmPerception;
    const perceptionResult = perceptionBuilder(inboundContext || {}, {
      passive: false
    });
    const perceptionPrompt = String(perceptionResult?.text || '').trim() || null;

    try {
      if (routeExecutionPlan.unavailableReason) {
        maybeCaptureUnavailableFeatureRequest?.({
          routeExecutionPlan,
          cleanText,
          senderId,
          groupId,
          route
        });
        reply = buildUnavailableRouteReply(route, routeExecutionPlan, { isAdminUser });
      } else if (routeExecutionPlan.allowTools || routeExecutionPlan.executor === 'background_direct') {
        const toolTaskOptions = {
          routePrompt: [toolGuidancePrompt, bridgeGuidancePrompt, perceptionPrompt].filter(Boolean).join('\n\n') || null,
          sessionChannel: chatType === 'private' ? 'qq-private' : 'qq-group',
          sessionChatId: chatType === 'private' ? `direct_${senderId}` : `group_${groupId}_user_${senderId}`,
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          routeDebugKey: routeExecutionPlan.routeDebugKey,
          topRouteType: routeExecutionPlan.topRouteType,
          allowTools: routeExecutionPlan.allowTools,
          allowedTools: routeExecutionPlan.allowedTools,
          plannerExecutionPlan: route?.meta?.toolPlanner?.executionPlan || route?.meta?.directChatPlanner?.executionPlan || null,
          disableDirectToolLoop: true,
          routeMeta: buildRouteMetaEnvelope(route, routeExecutionPlan, route?.meta?.toolPlanner || route?.meta?.directChatPlanner || null, { groupId, chatType })
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
            userInfo,
            senderId,
            groupId,
            toolTaskOptions
          });
          return buildReplyEnvelope({
            replyText: backgroundResult.reply || '',
            allowStream: false,
            atSender: true,
            routeContext: routeDecision,
            sendStrategy: backgroundResult.backgroundHandled ? 'background_ack' : 'standard',
            backgroundTaskState: {
              handled: Boolean(backgroundResult.backgroundHandled)
            }
          });
        }

        const qzoneDraftMode = detectQzonePostDraftMode(route, cleanText);
        if (qzoneDraftMode === 'bot_diary') {
          const diaryDraft = await generateBotDiaryDraft({
            groupId: String(groupId || ''),
            hint: cleanText
          });
          if (!diaryDraft.ok) {
            reply = `生成 bot 日记草稿失败。\n\n原因：${diaryDraft.reason || '未知错误'}`;
          } else {
            const publishResult = await publishQzoneForContext({
              mode: 'manual',
              content: diaryDraft.content
            }, {
              userId: String(senderId || ''),
              routeMeta: {
                ...(route.meta || {}),
                userId: String(senderId || ''),
                groupId: String(groupId || '')
              }
            });
            reply = publishResult?.ok
              ? `已发布 bot 日记到 QQ 空间。\n\n内容：\n${diaryDraft.content}`
              : `bot 日记生成成功，但发布到 QQ 空间失败。\n\n原因：${publishResult?.text || '未知错误'}`;
          }
        } else if (qzoneDraftMode === 'generic_autodraft' || shouldAutoDraftQzonePostRequest?.(route, cleanText)) {
          const drafted = await generateGenericQzoneDraft({
            requestText: cleanText,
            groupId: String(groupId || '')
          });
          const draftedContent = drafted.ok ? normalizeGeneratedQzoneContent(drafted.content) : '';

          if (!draftedContent) {
            reply = '这次没能生成可发布的 QQ 空间草稿。';
          } else {
            const publishResult = await publishQzoneForContext(draftedContent, {
              userId: String(senderId || ''),
              qzoneSource: 'generic_autodraft',
              qzoneType: 'generic_autodraft',
              lens: drafted?.meta?.lens,
              emotion: drafted?.meta?.emotion,
              anchor: drafted?.meta?.anchor,
              structure: drafted?.meta?.structure,
              ending: drafted?.meta?.ending,
              routeMeta: {
                ...(route.meta || {}),
                userId: String(senderId || ''),
                groupId: String(groupId || '')
              }
            });
            reply = publishResult?.ok
              ? `已发布到 QQ 空间。\n\n内容：\n${draftedContent}`
              : `QQ 空间草稿已生成，但发布失败。\n\n原因：${publishResult?.text || '未知错误'}\n\n草稿内容：\n${draftedContent}`;
          }
        } else {
          await markThinkingEmojiBeforeLlm?.({
            messageId: String(inboundContext?.messageMeta?.messageId || input.sourceMessageId || '').trim(),
            routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
            routeMeta: route.meta || {}
          });
          reply = await askToolTaskLocally(cleanText, userInfo, senderId, null, imageUrl, toolTaskOptions);
        }
      } else {
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
            bridgeGuidancePrompt,
            perceptionPrompt,
            safetyBoundaryRoutePrompt,
            streamingSegmentationPrompt,
            qqRichReplyPrompt
          }),
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          routeDebugKey: routeExecutionPlan.routeDebugKey,
          topRouteType: routeExecutionPlan.topRouteType,
          disableTools: !routeExecutionPlan.allowTools,
          allowTools: routeExecutionPlan.allowTools,
          allowedTools: routeExecutionPlan.allowedTools,
          disableDirectToolLoop: true,
          routeMeta: buildRouteMetaEnvelope(route, routeExecutionPlan, route?.meta?.toolPlanner || route?.meta?.directChatPlanner || null, {
            groupId,
            chatType,
            messageId: String(inboundContext?.messageMeta?.messageId || input.sourceMessageId || '').trim(),
            threadId: String(inboundContext?.threadId || inboundContext?.messageMeta?.threadId || '').trim()
          }),
          disableStream: disableStreamForReply,
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
        if (chatType === 'group') {
          replyOptions.disableStream = true;
        }
        if (cotDisplayOnce) {
          replyOptions.disableStream = true;
        }
        finalReplyOptions = replyOptions;

        const thinkingEmojiStartedAt = Date.now();
        const thinkingEmojiApplied = await markThinkingEmojiBeforeLlm?.({
          messageId: String(inboundContext?.messageMeta?.messageId || input.sourceMessageId || '').trim(),
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          routeMeta: route.meta || {}
        });
        inboundContext?.onEvent?.({
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          ts: Date.now(),
          type: 'thinking_emoji_done',
          node: 'pre_model',
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          topRouteType: String(routeExecutionPlan?.topRouteType || '').trim(),
          applied: Boolean(thinkingEmojiApplied),
          durationMs: Math.max(0, Date.now() - thinkingEmojiStartedAt)
        });
        reply = await askAIDispatch(cleanText, userInfo, senderId, null, imageUrl, replyOptions);
        persistedReplyText = String(replyOptions?.persistedReplyText || reply || '').trim();
        if (replyOptions.streamCompleted && replyOptions.streamHadOutput) {
          usedStreamingSend = true;
          await streamingDispatcher.finish(reply);
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
        reply = '这次处理过程中出了点问题。你可以稍后再试一次。';
      }
    }

    return buildReplyEnvelope({
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
      freshness
    });
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
      adminReply = '仅管理员可用。';
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
    } else if (cmd === 'claude') {
      return handleClaudeAdminCommand({
        route,
        groupId,
        senderId,
        userInfo,
        rawText,
        chatType: normalizedChatType
      });
    } else if (cmd === 'claude-open' || cmd === 'claude-send' || cmd === 'claude-tail' || cmd === 'claude-stop') {
      return handleClaudeSessionAdminCommand({
        route,
        groupId,
        senderId,
        chatType: normalizedChatType
      });
    } else if (cmd === 'hapi') {
      const hapiAdminResult = await handleHapiAdminCommand({
        rawText: route?.meta?.command?.raw || route?.cleanText || rawText,
        groupId,
        userId: senderId
      });
      adminReply = String(hapiAdminResult?.replyText || '').trim() || 'HAPI 管理命令已处理。';
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
      adminReply = '可用命令: /claude <任务>, /claude-open, /claude-send <内容>, /claude-tail, /claude-stop, /create <prompt>, /full <任务>, /debug on|off, /status, /reload, /hapi status|approve <id>|deny <id>, /learn recent [limit], /learn search <query>, /learn patterns [limit], /learn rules [limit], /learn guide <pattern_key>, /learn style, /learn social, /learn graph <userId>, /group_public on|off|status, /main_stream on|off|status, /meme ..., /qzone_post {...}, /schedule_create {...}, /schedule_list [all], /schedule_cancel <jobId>, /schedule_delete <jobId>';
    } else if (cmd === 'status') {
      adminReply = '状态命令已收到。';
    } else if (cmd === 'reload') {
      adminReply = '重载命令已收到。';
    } else if (cmd === 'debug') {
      adminReply = `debug 参数: ${args.join(' ') || '无'}`;
    } else {
      adminReply = '未知管理员命令。可以发 /help 查看支持项。';
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
    handleClaudeSessionAdminCommand,
    handleClaudeAdminCommand,
    dispatchAdminRoute,
    dispatchByRoutePlan,
    dispatchFormalRoute: dispatchByRoutePlan,
    handleBackgroundTaskControl,
    handleBackgroundControl: handleBackgroundTaskControl,
    handleFullAdminCommand,
    handleFullAdmin: handleFullAdminCommand
  };
}

module.exports = {
  buildQzoneAutodraftPrompt,
  buildUnavailableRouteReply,
  buildSupplementedTaskText,
  createMessageRouteFlow
};
