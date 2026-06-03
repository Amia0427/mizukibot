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

function normalizeText(value = '') {
  return String(value || '').trim();
}

function splitCommandPayload(payload = '') {
  return normalizeText(payload).split(/\s+/).filter(Boolean);
}

function parseMemoryOpsPayload(rawText = '') {
  const text = normalizeText(rawText);
  if (!/^\/memoryops(?:\s|$)/i.test(text)) return null;
  const payload = text.replace(/^\/memoryops/i, '').trim();
  return payload ? splitCommandPayload(payload) : ['diagnose', '--limit', '20'];
}

function formatSummaryCooldownReply(remainingMs = 0) {
  const seconds = Math.max(1, Math.ceil((Number(remainingMs || 0) || 0) / 1000));
  return `当前会话总结刚生成过，请 ${seconds} 秒后再试。`;
}

function createMessageAdminCoordinator(deps = {}) {
  const {
    config,
    chatHistory,
    shortTermMemory,
    resolveShortTermSessionKey,
    getSessionSummaryCooldownStatus,
    saveSessionContextSummary,
    generateSessionContextSummary,
    isAdminUser,
    getGroupInitiativeState,
    clearGroupMute,
    setGroupMute,
    scheduleGroupMessage,
    createScheduledCommand,
    runMemoryOpsFromArgv = null,
    formatMemoryOpsAdminReply = null
  } = deps;

  async function handleSessionSummaryCommand({
    rawText = '',
    senderId = '',
    groupId = '',
    summarizeSessionContext = generateSessionContextSummary
  } = {}) {
    const text = String(rawText || '').trim();
    if (!/^\s*\/sr(?:\s|$)/i.test(text)) return null;
    if (!String(groupId || '').trim()) {
      return { handled: true, replyText: '仅群聊会话支持 /sr。' };
    }

    const sessionKey = resolveShortTermSessionKey(senderId, { groupId });
    const cooldownStatus = getSessionSummaryCooldownStatus(sessionKey);
    if (cooldownStatus.limited) {
      return {
        handled: true,
        replyText: formatSummaryCooldownReply(cooldownStatus.remainingMs)
      };
    }

    const summaryResult = await summarizeSessionContext({
      userId: senderId,
      sessionKey,
      routeMeta: { groupId },
      chatHistory,
      shortTermMemory
    });

    const summaryText = String(summaryResult?.summary || '').trim();
    if (!summaryText) {
      return {
        handled: true,
        replyText: '这次会话总结没生成稳。等一下再试一次吧。'
      };
    }

    const saved = saveSessionContextSummary({
      sessionKey,
      userId: senderId,
      groupId,
      trigger: 'manual_sr',
      summary: summaryText,
      structured: summaryResult?.structured || null
    });

    if (saved.cooldownLimited) {
      return {
        handled: true,
        replyText: formatSummaryCooldownReply(saved.remainingMs)
      };
    }

    if (saved.duplicate) {
      return {
        handled: true,
        replyText: '当前会话总结已是最新，无需重复保存。'
      };
    }

    if (!saved.saved) {
      return {
        handled: true,
        replyText: '会话总结保存那下没稳住。等一下再试一次吧。'
      };
    }

    return {
      handled: true,
      replyText: '当前会话总结已保存。'
    };
  }

  async function handleInitiativeAdminCommand({ rawText = '', groupId = '', userId = '' } = {}) {
    const text = String(rawText || '').trim();
    if (!/^\s*\/initiative(?:\s|$)/i.test(text)) return null;
    if (!String(groupId || '').trim()) {
      return { handled: true, replyText: '这个要在群里才接得住啦。' };
    }
    if (!isAdminUser(userId)) {
      return { handled: true, replyText: '这个按钮现在只给管理员按哦。' };
    }
    const parts = text.split(/\s+/).slice(1);
    const sub = String(parts[0] || 'status').trim().toLowerCase();
    if (sub === 'mute') {
      const minutes = Math.max(1, Number(parts[1] || 30) || 30);
      const until = Date.now() + (minutes * 60 * 1000);
      setGroupMute(groupId, {
        until,
        by: userId,
        at: Date.now()
      });
      return { handled: true, replyText: `当前群主动回复已静音 ${minutes} 分钟。` };
    }
    if (sub === 'resume' || sub === 'unmute') {
      clearGroupMute(groupId, Date.now());
      return { handled: true, replyText: '当前群主动回复已恢复。' };
    }
    const state = getGroupInitiativeState(groupId, Date.now());
    const muteUntil = Number(state?.mute?.until || 0) || 0;
    return {
      handled: true,
      replyText: [
        `主动策略：${config.INITIATIVE_POLICY_ENABLED ? '已启用' : '已关闭'}`,
        `静音状态：${muteUntil > Date.now() ? '静音中' : '正常'}`,
        `今日主动次数：${Math.max(0, Number(state?.daily?.count || 0) || 0)}/${Math.max(1, Number(config.INITIATIVE_GROUP_MAX_PER_DAY || 8))}`,
        `最近主动来源：${String(state?.daily?.lastSource || '无').trim() || '无'}`,
        `最近跳过原因：${String(state?.lastSkipReason || '无').trim() || '无'}`
      ].join('\n')
    };
  }

  async function handleRestartAdminCommand({ rawText = '', userId = '' } = {}) {
    const text = normalizeText(rawText);
    if (!/^\/restart$/i.test(text)) return null;
    if (!isAdminUser(userId)) {
      return { handled: true, replyText: '这个按钮现在只给管理员按哦。' };
    }
    return {
      handled: true,
      restartRequested: true,
      replyText: '收到，正在重启 bot 和所有子 agent 进程。'
    };
  }

  async function handleQqScheduleAdminCommand(command = {}, context = {}) {
    const payload = parseJsonTail(command.payload);
    const kind = String(payload.kind || '').trim().toLowerCase();
    if (kind === 'message') {
      return scheduleGroupMessage(payload.message, payload.when, context);
    }
    if (kind === 'command') {
      return createScheduledCommand(payload.action, payload.when, {
        content: payload.content,
        mode: payload.mode,
        hint: payload.hint
      }, context);
    }
    throw new Error('schedule_create.kind 仅支持 message 或 command');
  }

  async function handleMemoryOpsAdminCommand({ rawText = '', userId = '' } = {}) {
    const argv = parseMemoryOpsPayload(rawText);
    if (!argv) return null;
    if (!isAdminUser(userId)) {
      return { handled: true, replyText: '这个按钮现在只给管理员按哦。' };
    }
    const runner = runMemoryOpsFromArgv || require('../scripts/diagnose-memory-ops').runMemoryOpsFromArgv;
    const formatter = formatMemoryOpsAdminReply || require('../scripts/diagnose-memory-ops').formatMemoryOpsAdminReply;
    const report = await runner(argv);
    return {
      handled: true,
      report,
      replyText: formatter(report)
    };
  }

  return {
    handleInitiativeAdminCommand,
    handleMemoryOpsAdminCommand,
    handleQqScheduleAdminCommand,
    handleRestartAdminCommand,
    handleSessionSummaryCommand,
    parseMemoryOpsPayload,
    parseJsonTail
  };
}

module.exports = {
  createMessageAdminCoordinator,
  parseMemoryOpsPayload
};
