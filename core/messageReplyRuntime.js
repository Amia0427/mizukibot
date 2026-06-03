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
const { prepareSubagentFallbackReply } = require('../utils/subagentStyleGuard');
const { buildCuteRefusalReply } = require('./refusalReply');
const {
  cleanToolReplyText,
  resolveToolReplyFormattingPreferences
} = require('../utils/toolReplyFormatting');
const {
  findExplicitSegmentBreakIndex,
  findNaturalSplitIndex,
  getStreamingSplitIndex
} = require('./streamingSegmentation');

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

function extractReplyTextValue(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => extractReplyTextValue(item)).join('');
  }
  if (!value || typeof value !== 'object') return '';
  return String(
    value.visibleText
    || value.persistedText
    || value.finalReply
    || value.text
    || value.content
    || ''
  );
}

function normalizeUserFacingReply(text, routeContext = {}, runtimeConfig = {}) {
  const t = sanitizeUserFacingText(extractReplyTextValue(text)).trim();
  const routePolicyKey = typeof routeContext === 'string'
    ? String(routeContext || '').trim()
    : getEffectivePolicyKey(routeContext);
  const topRouteType = typeof routeContext === 'string'
    ? ''
    : String(routeContext?.topRouteType || '').trim();
  const routeCapability = String(routeExecution.getPolicyDefinition(routePolicyKey)?.capability || '').trim();
  const toolReplyRoute = isToolReplyRoute(routeContext);
  const subagentRefill = typeof routeContext === 'string'
    ? false
    : (
        routeContext?.subagentRefill === true
        || /subagent/i.test(String(routeContext?.source || routeContext?.executor || '').trim())
      );
  const formattingPreferences = resolveToolReplyFormattingPreferences(
    typeof routeContext === 'string' ? '' : String(routeContext?.requestText || '').trim()
  );
  const shouldBypassLocalHumanize = routeCapability === 'admin' || toolReplyRoute;

  if (!t) {
    return '刚刚空了一拍……你再说一次，我接住。';
  }

  if (!isReplyFailure(t)) {
    if (toolReplyRoute) {
      const cleanedToolReply = cleanToolReplyText(t, formattingPreferences);
      return subagentRefill
        ? prepareSubagentFallbackReply(cleanedToolReply, {
            requestText: typeof routeContext === 'string' ? '' : String(routeContext?.requestText || '').trim()
          })
        : cleanedToolReply;
    }
    if (shouldBypassLocalHumanize) {
      return subagentRefill
        ? prepareSubagentFallbackReply(t, {
            requestText: typeof routeContext === 'string' ? '' : String(routeContext?.requestText || '').trim()
          })
        : t;
    }
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
    return '记忆那边刚刚绕住了。你把想找的点再捏具体一点，我接着翻。';
  }

  if (failure.type === 'tool_error') {
    return '刚刚翻记忆没翻稳。换个更具体的关键词问我，我再捞一次。';
  }

  if (failure.type === 'provider_auth') {
    return '这边配置像是没扣好，先检查一下模型钥匙吧。';
  }

  if (failure.type === 'provider_quota') {
    return '模型额度好像见底了。先换个模型或者补一下额度，我再继续。';
  }

  if (failure.type === 'generic_model_failure') {
    return '刚刚那句没组织稳。你再发一次，我继续接。';
  }

  if (toolReplyRoute) {
    return '这个任务刚刚被卡住了。等一下再丢给我，我重新跑。';
  }

  return '刚刚那句被卡掉了。你换个更短更明确的说法，我马上接。';
}

function buildBackgroundAckText() {
  return '这类任务我先放后台跑。你随时发“任务状态”“取消任务”“结束任务”，或者用“任务补充 ...”加要求。';
}

function buildNoTaskControlText() {
  return '现在没有正在挂着的后台任务哦。';
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
      ? `现在没有正在跑的后台任务。\n最近一次结果：${summary}\n要继续的话，发“任务补充 ...”就行。`
      : '现在没有正在跑的后台任务。要继续的话，发“任务补充 ...”就行。';
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
  return findExplicitSegmentBreakIndex(text);
}

function getNaturalSplitIndex(text) {
  return findNaturalSplitIndex(text);
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
  senderId,
  shouldSend = null
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
      if (typeof shouldSend === 'function' && shouldSend() === false) return false;
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
      sendUntil = getStreamingSplitIndex(pending);
    }

    if (sendUntil <= 0 && force) sendUntil = getStreamingSplitIndex(pending, { force: true });
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
      if (typeof shouldSend === 'function' && shouldSend() === false) return;
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

function createMessageReplyRuntime({ sendWithRetry, runtimeConfig = {}, inboundTimingLogger = null } = {}) {
  const logInboundTiming = typeof inboundTimingLogger === 'function' ? inboundTimingLogger : null;
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
    telemetry = null,
    shouldSend = null
  }) {
    if (typeof shouldSend === 'function' && shouldSend() === false) return false;
    const startedAt = Date.now();
    if (logInboundTiming) {
      logInboundTiming({
        stage: 'reply_send_start',
        channel: 'group',
        groupId: String(groupId || '').trim(),
        senderId: String(senderId || '').trim(),
        replyLength: String(replyText || '').trim().length,
        routePolicyKey: String(telemetry?.routePolicyKey || '').trim(),
        topRouteType: String(telemetry?.topRouteType || '').trim(),
        threadId: String(telemetry?.threadId || '').trim()
      });
    }
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
    if (logInboundTiming) {
      logInboundTiming({
        stage: sent ? 'reply_send_success' : 'reply_send_failure',
        channel: 'group',
        groupId: String(groupId || '').trim(),
        senderId: String(senderId || '').trim(),
        replyLength: String(replyText || '').trim().length,
        routePolicyKey: String(telemetry?.routePolicyKey || '').trim(),
        topRouteType: String(telemetry?.topRouteType || '').trim(),
        threadId: String(telemetry?.threadId || '').trim(),
        durationMs: Math.max(0, Date.now() - startedAt)
      });
    }

    return sent;
  }

  async function sendPrivateReply({
    userId,
    replyText,
    retries = 2,
    waitMs = 500,
    telemetry = null,
    shouldSend = null
  }) {
    if (typeof shouldSend === 'function' && shouldSend() === false) return false;
    const startedAt = Date.now();
    if (logInboundTiming) {
      logInboundTiming({
        stage: 'reply_send_start',
        channel: 'private',
        userId: String(userId || '').trim(),
        replyLength: String(replyText || '').trim().length,
        routePolicyKey: String(telemetry?.routePolicyKey || '').trim(),
        topRouteType: String(telemetry?.topRouteType || '').trim(),
        threadId: String(telemetry?.threadId || '').trim()
      });
    }
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
    if (logInboundTiming) {
      logInboundTiming({
        stage: sent ? 'reply_send_success' : 'reply_send_failure',
        channel: 'private',
        userId: String(userId || '').trim(),
        replyLength: String(replyText || '').trim().length,
        routePolicyKey: String(telemetry?.routePolicyKey || '').trim(),
        topRouteType: String(telemetry?.topRouteType || '').trim(),
        threadId: String(telemetry?.threadId || '').trim(),
        durationMs: Math.max(0, Date.now() - startedAt)
      });
    }

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
    telemetry = null,
    shouldSend = null
  }) {
    if (String(chatType || '').trim() === 'private') {
      return sendPrivateReply({
        userId: userId || senderId,
        replyText,
        retries,
        waitMs,
        telemetry,
        shouldSend
      });
    }
    return sendGroupReply({
      groupId,
      senderId,
      replyText,
      atSender,
      retries,
      waitMs,
      telemetry,
      shouldSend
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
