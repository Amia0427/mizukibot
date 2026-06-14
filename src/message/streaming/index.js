const { sanitizeUserFacingText } = require('../../../utils/userFacingText');
const {
  findExplicitSegmentBreakIndex,
  findNaturalSplitIndex,
  getGroupChatStreamSendGapMs,
  getStreamingSplitIndex
} = require('../../../core/streamingSegmentation');

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
  telemetry = null
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
    sendQueue: Promise.resolve(),
    sendStartedAt: 0,
    sendFinishedAt: 0,
    totalSendDurationMs: 0,
    totalGapWaitMs: 0,
    failedChunks: 0
  };

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
    const chunkIndex = state.sentSegments + 1;

    const task = async () => {
      if (typeof shouldSend === 'function' && shouldSend() === false) return false;
      // Keep streamed chunk sending strictly serialized (unit-test anchor).
      const now = Date.now();
      const isPrivate = String(chatType || '').trim().toLowerCase() === 'private';
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
      if (typeof shouldSend === 'function' && shouldSend() === false) return false;

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
      const startedAt = Date.now();
      if (!state.sendStartedAt) state.sendStartedAt = startedAt;
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
    const pending = state.fullText.slice(state.sentLength);
    if (!pending) return false;

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
