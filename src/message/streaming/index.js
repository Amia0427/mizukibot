const { sanitizeUserFacingText } = require('../../../utils/userFacingText');
const defaultConfig = require('../../../config');
const {
  findExplicitSegmentBreakIndex,
  findNaturalSplitIndex,
  getGroupChatStreamSendGapMs,
  getStreamingSplitIndex
} = require('../../../core/streamingSegmentation');
const {
  buildOutboundMessageMeta,
  recordOutboundMessageEvent
} = require('../../../core/outboundMessageDiagnostics');
const { getGroupReplySensitiveGuard } = require('../../../utils/groupReplySensitiveGuard');
const { isAdminUserId } = require('../../../utils/privilegedPrivateChat');
const {
  getSensitiveOutputHoldbackChars,
  protectFinalOutput
} = require('../../../utils/promptSecurity');
const { createGroupReplySendLease } = require('../../../core/systemGroupReply');

function getReplyChunkChars(config = {}) {
  const n = Number(config.AI_REPLY_CHUNK_CHARS);
  if (!Number.isFinite(n)) return 1200;
  return Math.max(300, Math.min(3000, Math.floor(n)));
}

function getStreamSendGapMs(config = {}) {
  const n = Number(config.AI_STREAM_SEND_GAP_MS);
  if (!Number.isFinite(n)) return 260;
  return Math.max(80, Math.floor(n));
}

function getStreamMaxSegments(config = {}) {
  const n = Number(config.AI_STREAM_MAX_SEGMENTS);
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(6, Math.floor(n)));
}

function getModelSegmentBreakIndex(text) {
  return findExplicitSegmentBreakIndex(text);
}

function getNaturalSplitIndex(text) {
  return findNaturalSplitIndex(text);
}

function createStreamingDispatcher({
  runtimeConfig = null,
  config = runtimeConfig || {},
  sendWithRetry,
  chatType = 'group',
  groupId,
  userId,
  senderId,
  shouldSend = null,
  telemetry = null,
  source = '',
  routePolicyKey = '',
  triggerReason = '',
  topRouteType = '',
  routeMeta = null,
  requestTrace = null
} = {}) {
  const effectiveConfig = runtimeConfig && typeof runtimeConfig === 'object'
    ? runtimeConfig
    : (config || {});
  const maxSegments = getStreamMaxSegments(effectiveConfig);
  const state = {
    fullText: '',
    sentLength: 0,
    sentSegments: 0,
    hasSentAny: false,
    lastSendAt: 0,
    operationQueue: Promise.resolve(),
    sendQueue: Promise.resolve(),
    groupSendLease: null,
    aborted: false,
    sendStartedAt: 0,
    sendFinishedAt: 0,
    totalSendDurationMs: 0,
    totalGapWaitMs: 0,
    failedChunks: 0
  };

  function enqueueOperation(task) {
    state.operationQueue = state.operationQueue.then(task, task);
    return state.operationQueue;
  }

  async function waitForGroupSendTurn() {
    const isPrivate = String(chatType || '').trim().toLowerCase() === 'private';
    if (isPrivate) return;
    if (!state.groupSendLease) {
      state.groupSendLease = createGroupReplySendLease(groupId);
    }
    await state.groupSendLease?.waitForTurn();
  }

  async function releaseGroupSendTurn() {
    if (!state.groupSendLease) return;
    const lease = state.groupSendLease;
    state.groupSendLease = null;
    await lease.release();
  }

  function emitStreamingTelemetry(type = '', payload = {}) {
    if (!telemetry || typeof telemetry.onEvent !== 'function') return;
    try {
      telemetry.onEvent({
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ts: Date.now(),
        type: String(type || 'event').trim() || 'event',
        ...payload
      });
    } catch (_) {}
  }

  async function sendChunk(chunk) {
    const text = String(chunk || '').trim();
    if (!text) return false;

    const task = async () => {
      if (state.aborted || (typeof shouldSend === 'function' && shouldSend() === false)) return false;
      await waitForGroupSendTurn();
      if (state.aborted || (typeof shouldSend === 'function' && shouldSend() === false)) return false;
      const now = Date.now();
      const isPrivate = String(chatType || '').trim().toLowerCase() === 'private';
      const chunkIndex = state.sentSegments + 1;
      const groupGap = getGroupChatStreamSendGapMs(text, {
        chatType,
        groupId,
        userId,
        senderId,
        chunkIndex,
        sentSegments: state.sentSegments
      });
      const minGap = groupGap > 0 && !isPrivate
        ? groupGap
        : getStreamSendGapMs(effectiveConfig);
      const elapsed = now - state.lastSendAt;
      if (state.lastSendAt > 0 && elapsed < minGap) {
        const gapWaitMs = minGap - elapsed;
        state.totalGapWaitMs += gapWaitMs;
        await new Promise((r) => setTimeout(r, gapWaitMs));
      }
      if (state.aborted || (typeof shouldSend === 'function' && shouldSend() === false)) return false;

      let sendText = protectFinalOutput(text).text;
      const adminConfig = effectiveConfig && Object.keys(effectiveConfig).length ? effectiveConfig : defaultConfig;
      const shouldGuard = !isPrivate || !isAdminUserId(userId, adminConfig);
      if (shouldGuard) {
        const guard = getGroupReplySensitiveGuard();
        const check = guard.check(text);
        if (check.blocked) {
          sendText = guard.replacementText;
          console.warn('[reply-sensitive-guard] reply blocked', {
            channel: isPrivate ? 'private' : 'group',
            groupId: String(groupId || '').trim(),
            userId: String(userId || '').trim(),
            senderId: String(senderId || '').trim(),
            matchedCount: check.matchedWords.length
          });
          emitStreamingTelemetry('group_reply_sensitive_blocked', {
            node: 'reply_sensitive_guard',
            channel: isPrivate ? 'private' : 'group',
            groupId: String(groupId || '').trim(),
            userId: String(userId || '').trim(),
            senderId: String(senderId || '').trim(),
            matchedCount: check.matchedWords.length,
            source: 'stream_chunk'
          });
        }
      }

      const payload = isPrivate
        ? {
            action: 'send_private_msg',
            params: { user_id: userId, message: sendText }
          }
        : {
            action: 'send_group_msg',
            params: {
              group_id: groupId,
              message: `${state.hasSentAny ? '' : `[CQ:at,qq=${senderId}] `}${sendText}`
            }
          };
      const startedAt = Date.now();
      if (!state.sendStartedAt) state.sendStartedAt = startedAt;
      const outboundMeta = buildOutboundMessageMeta({
        source,
        routePolicyKey,
        triggerReason,
        topRouteType,
        routeMeta,
        requestTrace,
        telemetry
      }, {
        source: 'main_reply_stream',
        triggerReason: 'stream_chunk'
      });
      const outboundPayload = {
        channel: isPrivate ? 'private' : 'group',
        action: payload.action,
        groupId: String(groupId || '').trim(),
        userId: String(userId || '').trim(),
        senderId: String(senderId || '').trim(),
        chunkIndex,
        chunkCount: 0,
        messageLength: String(sendText || '').length
      };
      recordOutboundMessageEvent('send_start', outboundMeta, outboundPayload);
      emitStreamingTelemetry('reply_stream_chunk_start', {
        node: 'reply_stream_send',
        channel: isPrivate ? 'private' : 'group',
        groupId: String(groupId || '').trim(),
        userId: String(userId || '').trim(),
        senderId: String(senderId || '').trim(),
        chunkIndex,
        chunkLength: text.length
      });
      const sent = await sendWithRetry(payload, 1, 300);
      recordOutboundMessageEvent(sent ? 'send_success' : 'send_failure', outboundMeta, {
        ...outboundPayload,
        durationMs: Math.max(0, Date.now() - startedAt)
      });

      if (!sent) {
        state.failedChunks += 1;
        emitStreamingTelemetry('reply_stream_chunk_failure', {
          node: 'reply_stream_send',
          channel: isPrivate ? 'private' : 'group',
          groupId: String(groupId || '').trim(),
          userId: String(userId || '').trim(),
          senderId: String(senderId || '').trim(),
          chunkIndex,
          chunkLength: text.length,
          durationMs: Math.max(0, Date.now() - startedAt)
        });
        console.error(isPrivate ? '[stream] send_private_msg failed' : '[stream] send_group_msg failed', {
          chatType: isPrivate ? 'private' : 'group',
          groupId,
          userId,
          senderId
        });
        return false;
      }

      emitStreamingTelemetry('reply_stream_chunk_success', {
        node: 'reply_stream_send',
        channel: isPrivate ? 'private' : 'group',
        groupId: String(groupId || '').trim(),
        userId: String(userId || '').trim(),
        senderId: String(senderId || '').trim(),
        chunkIndex,
        chunkLength: text.length,
        durationMs: Math.max(0, Date.now() - startedAt)
      });
      state.hasSentAny = true;
      state.lastSendAt = Date.now();
      state.sendFinishedAt = state.lastSendAt;
      state.totalSendDurationMs += Math.max(0, state.lastSendAt - startedAt);
      return true;
    };

    state.sendQueue = state.sendQueue.then(task, task);
    return state.sendQueue;
  }

  async function flush(force = false) {
    let pending = state.fullText.slice(state.sentLength);
    if (!pending) return false;

    if (!force) {
      const releasableChars = pending.length - getSensitiveOutputHoldbackChars();
      if (releasableChars <= 0) return false;
      pending = pending.slice(0, releasableChars);
    }

    let sendUntil = -1;
    const canSplitMore = state.sentSegments < (maxSegments - 1);
    if (canSplitMore) {
      sendUntil = getStreamingSplitIndex(pending, {
        chatType,
        groupId,
        userId,
        senderId,
        sentSegments: state.sentSegments
      });
    }

    if (sendUntil <= 0 && force) {
      sendUntil = getStreamingSplitIndex(pending, {
        force: true,
        chatType,
        groupId,
        userId,
        senderId,
        sentSegments: state.sentSegments
      });
    }
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
    onDelta(_delta, fullText) {
      const visibleText = sanitizeUserFacingText(fullText);
      return enqueueOperation(async () => {
        if (state.aborted) return false;
        state.fullText = visibleText;
        const protectedOutput = protectFinalOutput(state.fullText);
        if (protectedOutput.blocked) {
          state.fullText = `${state.fullText.slice(0, state.sentLength)}${protectedOutput.text}`;
        }
        return flush(false);
      });
    },
    finish(finalReply) {
      const visibleFinalReply = sanitizeUserFacingText(finalReply).trim();
      return enqueueOperation(async () => {
        try {
          if (state.aborted || (typeof shouldSend === 'function' && shouldSend() === false)) return;
          const protectedOutput = protectFinalOutput(visibleFinalReply || state.fullText || '');
          state.fullText = protectedOutput.blocked
            ? `${state.fullText.slice(0, state.sentLength)}${protectedOutput.text}`
            : protectedOutput.text;
          while (state.sentSegments < maxSegments && await flush(true)) {}

          if (!state.hasSentAny && state.fullText.trim()) {
            await sendChunk(state.fullText.trim());
            state.sentLength = state.fullText.length;
            state.sentSegments = Math.max(1, state.sentSegments);
          }
          await state.sendQueue;
        } finally {
          await releaseGroupSendTurn();
        }
      });
    },
    abort() {
      state.aborted = true;
      return enqueueOperation(async () => {
        try {
          await state.sendQueue;
        } finally {
          await releaseGroupSendTurn();
        }
      });
    },
    getStats() {
      const wallMs = state.sendStartedAt && state.sendFinishedAt
        ? Math.max(0, state.sendFinishedAt - state.sendStartedAt)
        : 0;
      return {
        sentSegments: state.sentSegments,
        hasSentAny: state.hasSentAny,
        failedChunks: state.failedChunks,
        totalSendDurationMs: Math.max(0, state.totalSendDurationMs),
        totalGapWaitMs: Math.max(0, state.totalGapWaitMs),
        wallMs
      };
    }
  };
}

function splitReplyForSend(text, maxChars) {
  const input = String(text || '').trim();
  if (!input) return [];

  const limit = Math.max(300, Number(maxChars) || 1200);
  if (input.length <= limit) return [input];

  const chunks = [];
  let rest = input;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < Math.floor(limit * 0.5)) cut = rest.lastIndexOf('?', limit);
    if (cut < Math.floor(limit * 0.5)) cut = rest.lastIndexOf('?', limit);
    if (cut < Math.floor(limit * 0.5)) cut = rest.lastIndexOf(' ', limit);
    if (cut < Math.floor(limit * 0.3)) cut = limit;

    const part = rest.slice(0, cut).trim();
    if (part) chunks.push(part);
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);

  return chunks;
}

module.exports = {
  createStreamingDispatcher,
  getModelSegmentBreakIndex,
  getNaturalSplitIndex,
  getReplyChunkChars,
  getStreamMaxSegments,
  getStreamSendGapMs,
  splitReplyForSend
};
