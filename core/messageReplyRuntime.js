const {
  buildQqRichMessagePayload,
  getReplyChunkChars,
  parseQqRichMessage,
  recordSystemGroupSend,
  sendGroupReply: sendSystemGroupReply,
  sendPrivateReply: sendSystemPrivateReply,
  splitReplyForSend
} = require('./systemGroupReply');
const routeExecution = require('./routeExecution');
const { humanizeReply } = require('../utils/humanizer');
const { classifyReplyFailure, isReplyFailure } = require('../utils/replyFailure');
const { sanitizeUserFacingText } = require('../utils/userFacingText');
const { buildCuteRefusalReply } = require('./refusalReply');
const {
  cleanToolReplyText,
  resolveToolReplyFormattingPreferences
} = require('../utils/toolReplyFormatting');

function createReplyTelemetryEvent(type = '', payload = {}) {
  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    type: String(type || 'event').trim() || 'event',
    ...payload
  };
}

function getEffectivePolicyKey(routeExecutionPlan = {}) {
  return String(
    routeExecutionPlan?.policyKey
    || routeExecutionPlan?.routePolicyKey
    || routeExecutionPlan?.routeDebugKey
    || 'chat/default'
  ).trim() || 'chat/default';
}

function isToolStyleRoute(routeKey = '') {
  return /^(?:lookup|transform|plan|act|tool)\//i.test(String(routeKey || '').trim());
}

function isToolReplyRoute(routeContext = {}) {
  const routePolicyKey = typeof routeContext === 'string'
    ? String(routeContext || '').trim()
    : String(
      routeContext?.policyKey
      || routeContext?.routePolicyKey
      || routeContext?.routeDebugKey
      || ''
    ).trim();
  const allowTools = typeof routeContext === 'string'
    ? false
    : Boolean(routeContext?.allowTools);
  const routeCapability = String(routeExecution.getPolicyDefinition(routePolicyKey)?.capability || '').trim();

  return allowTools || routeCapability === 'tool' || isToolStyleRoute(routePolicyKey);
}

function normalizeUserFacingReply(text, routeContext = {}, runtimeConfig = {}) {
  const t = sanitizeUserFacingText(text).trim();
  const routePolicyKey = typeof routeContext === 'string'
    ? String(routeContext || '').trim()
    : getEffectivePolicyKey(routeContext);
  const topRouteType = typeof routeContext === 'string'
    ? ''
    : String(routeContext?.topRouteType || '').trim();
  const routeCapability = String(routeExecution.getPolicyDefinition(routePolicyKey)?.capability || '').trim();
  const toolReplyRoute = isToolReplyRoute(routeContext);
  const formattingPreferences = resolveToolReplyFormattingPreferences(
    typeof routeContext === 'string' ? '' : String(routeContext?.requestText || '').trim()
  );
  const shouldBypassLocalHumanize = routeCapability === 'admin' || toolReplyRoute;

  if (!t) {
    return '刚才网络有点抖，我再试一次。';
  }

  if (!isReplyFailure(t)) {
    if (toolReplyRoute) return cleanToolReplyText(t, formattingPreferences);
    if (shouldBypassLocalHumanize) return t;
    if (runtimeConfig.HUMANIZER_AGENT_ENABLED || runtimeConfig.LLM_HUMANIZER_ENABLED) return t;
    const cleaned = humanizeReply(t);
    return cleaned || t;
  }

  const failure = classifyReplyFailure(t);
  console.log('[memory] reply failure classified', {
    type: failure.type,
    routePolicyKey,
    topRouteType
  });

  if (failure.type === 'tool_loop_limit') {
    return '这轮查记忆时有点绕住了。你可以把想找的记忆点再说具体一点，我直接接着答。';
  }

  if (failure.type === 'tool_error') {
    return '刚才读记忆时出了点问题，我没拿到稳定结果。你可以换个更具体的记忆点再问我一次。';
  }

  if (failure.type === 'provider_auth') {
    return '当前上游模型鉴权或配置有问题，暂时没法正常回答，需要先检查配置。';
  }

  if (failure.type === 'generic_model_failure') {
    return '刚才回复时出了点问题，你可以再发一次，我继续。';
  }

  if (toolReplyRoute) {
    return '这次工具任务被上游拦截或拒答了。你可以稍后再发一次同样的请求。';
  }

  return '这次回复被上游拦截或拒答了。你可以换个更简短或更明确的问法，我马上继续。';
}

function buildBackgroundAckText() {
  return '这类任务我先在后台跑。你可以随时发“任务状态”“取消任务”“结束任务”，或用“任务补充 ...”追加要求。';
}

function buildNoTaskControlText() {
  return '当前没有可控制的后台任务。';
}

function buildSessionStatusReply(session = {}, activeTask = null) {
  if (activeTask) {
    const summary = String(activeTask.latest_summary || '').trim();
    const summaryLine = summary ? `最近摘要：${summary}` : '最近摘要：还在处理中。';
    return [
      `当前任务状态：${activeTask.status || 'running'} / ${activeTask.stage || 'running'}`,
      `最近更新时间：${String(activeTask.updated_at || '').trim() || 'unknown'}`,
      summaryLine
    ].join('\n');
  }

  if (session && String(session.status || '').trim() === 'retained') {
    const summary = String(session.latest_summary || session.latest_result_excerpt || '').trim();
    return summary
      ? `当前没有运行中的后台任务。\n最近一次结果：${summary}\n如果要继续，可以发“任务补充 ...”。`
      : '当前没有运行中的后台任务。如果要继续，可以发“任务补充 ...”。';
  }

  if (session && String(session.status || '').trim()) {
    const latestSummary = String(session.latest_summary || '').trim();
    const latestError = String(session.latest_error || '').trim();
    const summaryLine = latestSummary ? `最近摘要：${latestSummary}` : '';
    const errorLine = latestError ? `最近错误：${latestError}` : '';
    return [
      `远程会话状态：${String(session.status || '').trim()}`,
      summaryLine,
      errorLine
    ].filter(Boolean).join('\n');
  }

  return buildNoTaskControlText();
}

function normalizeControlText(text = '') {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseBackgroundControlCommand(text = '') {
  const normalized = normalizeControlText(text);
  if (!normalized) return null;
  const plain = normalized.replace(/^\/+/, '').trim();
  if (!plain) return null;
  if (plain === '任务状态') return { type: 'status', payload: '' };
  if (plain === '取消任务') return { type: 'cancel', payload: '' };
  if (plain === '结束任务') return { type: 'close', payload: '' };
  if (/^批准(?:\s|$)/i.test(plain)) {
    return {
      type: 'approve',
      payload: plain.replace(/^批准\s*/i, '').trim()
    };
  }
  if (/^拒绝(?:\s|$)/i.test(plain)) {
    return {
      type: 'deny',
      payload: plain.replace(/^拒绝\s*/i, '').trim()
    };
  }
  if (/^切\s*agent(?:\s|$)/i.test(plain)) {
    return {
      type: 'switch_agent',
      payload: plain.replace(/^切\s*agent\s*/i, '').trim()
    };
  }
  if (/^重连会话(?:\s|$)/i.test(plain)) {
    return {
      type: 'resume_session',
      payload: plain.replace(/^重连会话\s*/i, '').trim()
    };
  }
  if (/^任务(?:补充|继续)\s+/i.test(plain)) {
    return {
      type: 'supplement',
      payload: plain.replace(/^任务(?:补充|继续)\s+/i, '').trim()
    };
  }
  if (plain === '任务补充' || plain === '任务继续') {
    return { type: 'supplement', payload: '' };
  }
  return null;
}

function getModelSegmentBreakIndex(text) {
  const input = String(text || '');
  if (!input) return -1;

  const rn = input.indexOf('\r\n\r\n');
  const nn = input.indexOf('\n\n');

  if (rn === -1 && nn === -1) return -1;
  if (rn === -1) return nn + 2;
  if (nn === -1) return rn + 4;
  return Math.min(rn + 4, nn + 2);
}

function getNaturalSplitIndex(text) {
  const input = String(text || '');
  if (!input) return -1;

  const strongStops = ['\n', '?', '？', '。', '!', '！', '~', '～', ';', '；'];
  for (let i = input.length - 1; i >= 0; i -= 1) {
    if (strongStops.includes(input[i])) return i + 1;
  }

  if (input.length >= 24) {
    const weakStops = [',', '，', '、', ':', '：'];
    for (let i = input.length - 1; i >= 0; i -= 1) {
      if (weakStops.includes(input[i])) return i + 1;
    }
  }

  return -1;
}

function getStreamSendGapMs(runtimeConfig = {}) {
  const n = Number(runtimeConfig.AI_STREAM_SEND_GAP_MS);
  if (!Number.isFinite(n)) return 260;
  return Math.max(80, Math.floor(n));
}

function getStreamMaxSegments(runtimeConfig = {}) {
  const n = Number(runtimeConfig.AI_STREAM_MAX_SEGMENTS);
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(6, Math.floor(n)));
}

function createStreamingDispatcher({
  runtimeConfig = {},
  config = runtimeConfig,
  sendWithRetry,
  chatType = 'group',
  groupId,
  userId,
  senderId
}) {
  const effectiveConfig = runtimeConfig && Object.keys(runtimeConfig).length ? runtimeConfig : (config || {});
  const maxSegments = getStreamMaxSegments(effectiveConfig);
  const state = {
    fullText: '',
    sentLength: 0,
    sentSegments: 0,
    hasSentAny: false,
    lastSendAt: 0,
    sendQueue: Promise.resolve()
  };

  async function sendChunk(chunk) {
    const text = String(chunk || '').trim();
    if (!text) return false;

    const task = async () => {
      const now = Date.now();
      const minGap = getStreamSendGapMs(effectiveConfig);
      const elapsed = now - state.lastSendAt;
      if (state.lastSendAt > 0 && elapsed < minGap) {
        await new Promise((resolve) => setTimeout(resolve, minGap - elapsed));
      }

      const isPrivate = String(chatType || '').trim() === 'private';
      const payload = isPrivate
        ? {
            action: 'send_private_msg',
            params: { user_id: userId, message: text }
          }
        : {
            action: 'send_group_msg',
            params: {
              group_id: groupId,
              message: `${state.hasSentAny ? '' : `[CQ:at,qq=${senderId}] `}${text}`
            }
          };
      const sent = await sendWithRetry(payload, 1, 300);

      if (!sent) {
        console.error(isPrivate ? '[stream] send_private_msg failed' : '[stream] send_group_msg failed', {
          chatType: isPrivate ? 'private' : 'group',
          groupId,
          userId,
          senderId
        });
        return false;
      }

      state.hasSentAny = true;
      state.lastSendAt = Date.now();
      return true;
    };

    state.sendQueue = state.sendQueue.then(task, task);
    return state.sendQueue;
  }

  async function flush(force = false) {
    const pending = state.fullText.slice(state.sentLength);
    if (!pending) return false;

    let sendUntil = -1;
    const canSplitMore = state.sentSegments < (maxSegments - 1);
    if (canSplitMore) {
      sendUntil = getModelSegmentBreakIndex(pending);
      if (sendUntil <= 0) {
        const natural = getNaturalSplitIndex(pending);
        if (natural > 0) sendUntil = natural;
      }
    }

    if (sendUntil <= 0 && force) sendUntil = pending.length;
    if (sendUntil <= 0) return false;

    const rawChunk = pending.slice(0, sendUntil);
    const chunk = rawChunk.trim();
    state.sentLength += sendUntil;

    if (!chunk) return true;

    const sent = await sendChunk(chunk);
    if (!sent) return false;

    state.sentSegments += 1;
    return true;
  }

  return {
    async onDelta(_delta, fullText) {
      state.fullText = sanitizeUserFacingText(fullText);
      await flush(false);
    },
    async finish(finalReply) {
      const visibleFinalReply = sanitizeUserFacingText(finalReply).trim();
      state.fullText = visibleFinalReply || state.fullText || '';
      while (state.sentSegments < maxSegments && await flush(true)) {}

      if (!state.hasSentAny && state.fullText.trim()) {
        await sendChunk(state.fullText.trim());
        state.sentLength = state.fullText.length;
        state.sentSegments = Math.max(1, state.sentSegments);
      }
    }
  };
}

function createMessageReplyRuntime({ sendWithRetry, runtimeConfig = {} } = {}) {
  function emitReplyTelemetry(telemetry = null, type = '', payload = {}) {
    if (!telemetry || typeof telemetry.onEvent !== 'function') return;
    try {
      telemetry.onEvent(createReplyTelemetryEvent(type, payload));
    } catch (_) {}
  }

  async function sendGroupReply({
    groupId,
    senderId,
    replyText,
    atSender = true,
    retries = 2,
    waitMs = 500,
    telemetry = null
  }) {
    const startedAt = Date.now();
    emitReplyTelemetry(telemetry, 'reply_send_start', {
      node: 'reply_send',
      channel: 'group',
      threadId: String(telemetry?.threadId || '').trim(),
      routePolicyKey: String(telemetry?.routePolicyKey || '').trim(),
      topRouteType: String(telemetry?.topRouteType || '').trim(),
      groupId: String(groupId || '').trim(),
      senderId: String(senderId || '').trim(),
      atSender: atSender !== false,
      replyLength: String(replyText || '').trim().length
    });

    const sent = await sendSystemGroupReply({
      sendWithRetry,
      groupId,
      senderId,
      replyText,
      atSender,
      retries,
      waitMs,
      runtimeConfig
    });

    emitReplyTelemetry(telemetry, sent ? 'reply_send_success' : 'reply_send_failure', {
      node: 'reply_send',
      channel: 'group',
      threadId: String(telemetry?.threadId || '').trim(),
      routePolicyKey: String(telemetry?.routePolicyKey || '').trim(),
      topRouteType: String(telemetry?.topRouteType || '').trim(),
      groupId: String(groupId || '').trim(),
      senderId: String(senderId || '').trim(),
      atSender: atSender !== false,
      replyLength: String(replyText || '').trim().length,
      durationMs: Math.max(0, Date.now() - startedAt)
    });

    return sent;
  }

  async function sendPrivateReply({
    userId,
    replyText,
    retries = 2,
    waitMs = 500,
    telemetry = null
  }) {
    const startedAt = Date.now();
    emitReplyTelemetry(telemetry, 'reply_send_start', {
      node: 'reply_send',
      channel: 'private',
      threadId: String(telemetry?.threadId || '').trim(),
      routePolicyKey: String(telemetry?.routePolicyKey || '').trim(),
      topRouteType: String(telemetry?.topRouteType || '').trim(),
      userId: String(userId || '').trim(),
      replyLength: String(replyText || '').trim().length
    });

    const sent = await sendSystemPrivateReply({
      sendWithRetry,
      userId,
      replyText,
      retries,
      waitMs,
      runtimeConfig
    });

    emitReplyTelemetry(telemetry, sent ? 'reply_send_success' : 'reply_send_failure', {
      node: 'reply_send',
      channel: 'private',
      threadId: String(telemetry?.threadId || '').trim(),
      routePolicyKey: String(telemetry?.routePolicyKey || '').trim(),
      topRouteType: String(telemetry?.topRouteType || '').trim(),
      userId: String(userId || '').trim(),
      replyLength: String(replyText || '').trim().length,
      durationMs: Math.max(0, Date.now() - startedAt)
    });

    return sent;
  }

  async function sendReply({
    chatType = 'group',
    groupId = '',
    userId = '',
    senderId = '',
    replyText,
    atSender = true,
    retries = 2,
    waitMs = 500,
    telemetry = null
  }) {
    if (String(chatType || '').trim() === 'private') {
      return sendPrivateReply({
        userId: userId || senderId,
        replyText,
        retries,
        waitMs,
        telemetry
      });
    }
    return sendGroupReply({
      groupId,
      senderId,
      replyText,
      atSender,
      retries,
      waitMs,
      telemetry
    });
  }

  function recordBotReply({
    chatType = 'group',
    groupId,
    senderId,
    replyText,
    senderName = 'Mizuki'
  }) {
    if (String(chatType || '').trim() === 'private') return;
    recordSystemGroupSend({
      groupId,
      senderId,
      text: replyText,
      senderName,
      updatePresence: true,
      updateBotPresence: true,
      now: Date.now()
    });
  }

  return {
    buildBackgroundAckText,
    buildNoTaskControlText,
    buildSessionStatusReply,
    createStreamingDispatcher: (options = {}) => createStreamingDispatcher({
      ...options,
      runtimeConfig
    }),
    getEffectivePolicyKey,
    normalizeUserFacingReply: (text, routeContext = {}) => normalizeUserFacingReply(text, routeContext, runtimeConfig),
    parseBackgroundControlCommand,
    recordBotReply,
    sendGroupReply,
    sendPrivateReply,
    sendReply
  };
}

module.exports = {
  buildBackgroundAckText,
  buildCuteRefusalReply,
  buildNoTaskControlText,
  buildQqRichMessagePayload,
  buildSessionStatusReply,
  createMessageReplyRuntime,
  createStreamingDispatcher,
  getEffectivePolicyKey,
  getNaturalSplitIndex,
  getReplyChunkChars,
  normalizeUserFacingReply,
  parseBackgroundControlCommand,
  parseQqRichMessage,
  splitReplyForSend
};
