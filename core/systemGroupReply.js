const config = require('../config');
const {
  shortTermMemory,
  favorites
} = require('../utils/memory');
const {
  resolveShortTermSessionKey,
  updateShortTermPresence
} = require('../utils/shortTermMemory');
const {
  appendGroupMessage,
  updateGroupPresence
} = require('../utils/groupAwarenessState');
const { recordBotReply: recordStyleBotReply } = require('../utils/styleProfileRuntime');
const { recordBotReply: recordSocialBotReply } = require('../utils/socialContextRuntime');
const { recordBotOutbound } = require('./initiativeState');

function getReplyChunkChars(runtimeConfig = config) {
  const n = Number(runtimeConfig.AI_REPLY_CHUNK_CHARS);
  if (!Number.isFinite(n)) return 1200;
  return Math.max(300, Math.min(3000, Math.floor(n)));
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
    if (cut < Math.floor(limit * 0.5)) cut = rest.lastIndexOf('。', limit);
    if (cut < Math.floor(limit * 0.5)) cut = rest.lastIndexOf('！', limit);
    if (cut < Math.floor(limit * 0.5)) cut = rest.lastIndexOf('？', limit);
    if (cut < Math.floor(limit * 0.5)) cut = rest.lastIndexOf(' ', limit);
    if (cut < Math.floor(limit * 0.3)) cut = limit;

    const part = rest.slice(0, cut).trim();
    if (part) chunks.push(part);
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function pushTextSegment(message, text) {
  const value = String(text || '');
  if (!value) return;
  if (message.length > 0 && message[message.length - 1]?.type === 'text') {
    message[message.length - 1].data.text += value;
    return;
  }
  message.push({ type: 'text', data: { text: value } });
}

function parseQqRichMessage(text = '') {
  const input = String(text || '');
  const pattern = /\[\[(qq_face|qq_image|qq_record|qq_video):([\s\S]*?)\]\]/gi;
  const segments = [];
  let lastIndex = 0;
  let hasRichSegment = false;
  let match = pattern.exec(input);

  while (match) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', data: { text: input.slice(lastIndex, match.index) } });
    }

    const rawType = String(match[1] || '').toLowerCase();
    const file = String(match[2] || '').trim();
    if (file) {
      if (rawType === 'qq_face' && /^\d+$/.test(file)) {
        hasRichSegment = true;
        segments.push({ type: 'face', data: { id: file } });
      } else if (rawType === 'qq_image') {
        hasRichSegment = true;
        segments.push({ type: 'image', data: { file } });
      } else if (rawType === 'qq_record') {
        hasRichSegment = true;
        segments.push({ type: 'record', data: { file } });
      } else if (rawType === 'qq_video') {
        hasRichSegment = true;
        segments.push({ type: 'video', data: { file } });
      } else {
        segments.push({ type: 'text', data: { text: match[0] } });
      }
    } else {
      segments.push({ type: 'text', data: { text: match[0] } });
    }

    lastIndex = pattern.lastIndex;
    match = pattern.exec(input);
  }

  if (lastIndex < input.length) {
    segments.push({ type: 'text', data: { text: input.slice(lastIndex) } });
  }

  return {
    hasRichSegment,
    segments
  };
}

function buildQqRichMessagePayload(text, { atSender = true, senderId } = {}) {
  const parsed = parseQqRichMessage(text);
  if (!parsed.hasRichSegment) return null;

  const message = [];
  if (atSender && senderId) {
    message.push({ type: 'at', data: { qq: String(senderId) } });
    message.push({ type: 'text', data: { text: ' ' } });
  }

  for (const segment of parsed.segments) {
    if (segment.type === 'text') {
      pushTextSegment(message, segment.data.text);
      continue;
    }
    message.push(segment);
  }

  return message.length ? message : null;
}

const groupReplySendQueueByGroupId = new Map();

function enqueueGroupSend(groupId = '', task = async () => false) {
  const normalizedGroupId = String(groupId || '').trim();
  if (!normalizedGroupId) {
    return Promise.resolve().then(task);
  }

  const previous = groupReplySendQueueByGroupId.get(normalizedGroupId) || Promise.resolve();
  let cleanupAttached = false;
  const runTask = async () => task();
  const next = previous
    .catch(() => {})
    .then(runTask, runTask);

  const cleanup = () => {
    if (cleanupAttached) return;
    cleanupAttached = true;
    next.finally(() => {
      if (groupReplySendQueueByGroupId.get(normalizedGroupId) === next) {
        groupReplySendQueueByGroupId.delete(normalizedGroupId);
      }
    });
  };

  groupReplySendQueueByGroupId.set(normalizedGroupId, next);
  cleanup();
  return next;
}

function getGroupReplySendQueueSize() {
  return groupReplySendQueueByGroupId.size;
}

async function sendGroupReply({
  sendWithRetry,
  groupId,
  senderId,
  replyText,
  atSender = true,
  retries = 2,
  waitMs = 500,
  runtimeConfig = config
}) {
  return enqueueGroupSend(groupId, async () => {
    const normalized = String(replyText || '').trim() || '刚才网络有点抖，我再试一次。';
    const richPayload = buildQqRichMessagePayload(normalized, { atSender, senderId });
    if (richPayload) {
      const ok = await sendWithRetry({
        action: 'send_group_msg',
        params: { group_id: groupId, message: richPayload }
      }, retries, waitMs);

      if (!ok) {
        console.error('[reply] send_group_msg failed', {
          groupId,
          senderId,
          chunkIndex: 0,
          chunkCount: 1,
          richMessage: true
        });
      }

      return ok;
    }

    const chunks = splitReplyForSend(normalized, getReplyChunkChars(runtimeConfig));
    if (!chunks.length) return false;

    let sentAny = false;
    for (let i = 0; i < chunks.length; i += 1) {
      const prefix = (atSender && i === 0 && senderId) ? `[CQ:at,qq=${senderId}] ` : '';
      const ok = await sendWithRetry({
        action: 'send_group_msg',
        params: { group_id: groupId, message: `${prefix}${chunks[i]}` }
      }, retries, waitMs);

      if (!ok) {
        console.error('[reply] send_group_msg failed', {
          groupId,
          senderId,
          chunkIndex: i,
          chunkCount: chunks.length
        });
        return sentAny;
      }

      sentAny = true;
      if (i < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 140));
      }
    }

    return sentAny;
  });
}

async function sendPrivateReply({
  sendWithRetry,
  userId,
  replyText,
  retries = 2,
  waitMs = 500,
  runtimeConfig = config
}) {
  const normalized = String(replyText || '').trim() || '刚才网络有点抖，我再试一次。';
  const richPayload = buildQqRichMessagePayload(normalized, { atSender: false, senderId: '' });
  if (richPayload) {
    const ok = await sendWithRetry({
      action: 'send_private_msg',
      params: { user_id: userId, message: richPayload }
    }, retries, waitMs);

    if (!ok) {
      console.error('[reply] send_private_msg failed', {
        userId,
        chunkIndex: 0,
        chunkCount: 1,
        richMessage: true
      });
    }

    return ok;
  }

  const chunks = splitReplyForSend(normalized, getReplyChunkChars(runtimeConfig));
  if (!chunks.length) return false;

  let sentAny = false;
  for (let i = 0; i < chunks.length; i += 1) {
    const ok = await sendWithRetry({
      action: 'send_private_msg',
      params: { user_id: userId, message: chunks[i] }
    }, retries, waitMs);

    if (!ok) {
      console.error('[reply] send_private_msg failed', {
        userId,
        chunkIndex: i,
        chunkCount: chunks.length
      });
      return sentAny;
    }

    sentAny = true;
    if (i < chunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 140));
    }
  }

  return sentAny;
}

function markSystemSessionPresenceReplied({ groupId, senderId, now = Date.now() }) {
  const gid = String(groupId || '').trim();
  const sid = String(senderId || '').trim();
  if (!gid || !sid) return;

  const sessionKey = resolveShortTermSessionKey(sid, { groupId: gid });
  updateShortTermPresence(sessionKey, shortTermMemory, {}, (current) => ({
    ...current,
    state: 'waiting',
    lastAction: 'reply',
    stateUpdatedAt: now,
    lastInboundAt: now,
    lastBotReplyAt: now,
    humanTurnsSinceBotReply: 0,
    waitingSince: now,
    closedAt: 0
  }));
}

function recordSystemGroupSend({
  groupId,
  senderId = '',
  text = '',
  senderName = '瑞希',
  updatePresence = true,
  updateBotPresence = true,
  now = Date.now(),
  source = '',
  routePolicyKey = ''
}) {
  const gid = String(groupId || '').trim();
  const botId = String(config.BOT_QQ || 'bot').trim() || 'bot';
  if (!gid) return;

  appendGroupMessage(gid, {
    sender_id: botId,
    sender_name: senderName,
    text: String(text || '').trim(),
    timestamp: now
  }, config.PASSIVE_AWARENESS_CONTEXT_SIZE);
  recordStyleBotReply({
    groupId: gid,
    senderId: botId,
    senderName,
    text: String(text || '').trim(),
    timestamp: now
  });
  recordSocialBotReply({
    groupId: gid,
    senderId: botId,
    senderName,
    text: String(text || '').trim(),
    timestamp: now
  });
  recordBotOutbound(gid, {
    source,
    routePolicyKey
  }, now);

  if (updatePresence) {
    updateGroupPresence(gid, (current) => ({
      ...current,
      state: updateBotPresence ? 'cooling' : current.state,
      last_action: updateBotPresence ? 'reply' : current.last_action,
      state_updated_at: now,
      last_inbound_at: now,
      last_bot_reply_at: updateBotPresence ? now : current.last_bot_reply_at,
      human_turns_since_bot_reply: updateBotPresence ? 0 : current.human_turns_since_bot_reply,
      waiting_since: updateBotPresence ? now : current.waiting_since,
      cooling_until: updateBotPresence
        ? now + Math.max(0, Number(config.PASSIVE_AWARENESS_REPLY_COOLDOWN_MS || 300000))
        : current.cooling_until,
      closed_at: 0,
      last_addressee: String(senderId || current.last_addressee || '').trim()
    }));
  }

  if (senderId) {
    markSystemSessionPresenceReplied({ groupId: gid, senderId: String(senderId), now });
  }
}

function buildDailyShareUserInfo(groupId, extra = {}) {
  const gid = String(groupId || '').trim();
  return {
    points: 0,
    level: 'group',
    relationship: 'group',
    attitude: 'neutral',
    trust_score: 0,
    group_id: gid,
    last_group_seen_at: Date.now(),
    last_seen_at: Date.now(),
    ...(favorites?.[String(extra.userId || '')] || {}),
    ...extra
  };
}

module.exports = {
  buildQqRichMessagePayload,
  buildDailyShareUserInfo,
  getGroupReplySendQueueSize,
  getReplyChunkChars,
  parseQqRichMessage,
  recordSystemGroupSend,
  sendGroupReply,
  sendPrivateReply,
  splitReplyForSend
};
