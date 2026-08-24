const { isReplayablePrivateMessage } = require('../utils/privateMessageRecoveryStore');

function toId(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function messageTimeMs(message = {}) {
  const seconds = Number(message.time || 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

function isInboundPrivateMessage(message = {}, botQq = '') {
  if (toId(message.post_type).toLowerCase() !== 'message') return false;
  if (toId(message.message_type).toLowerCase() !== 'private') return false;
  return toId(message.user_id) !== toId(botQq || message.self_id);
}

function hasText(message = {}) {
  if (Array.isArray(message.message)) {
    return message.message.some((segment) => (
      segment?.type === 'text' && String(segment?.data?.text || '').trim()
    ));
  }
  const raw = String(message.raw_message || '').trim();
  return raw && !/^\[CQ:(?:image|json),/i.test(raw);
}

function isBotTextReply(message = {}, botQq = '') {
  if (toId(message.message_type).toLowerCase() !== 'private') return false;
  const senderId = toId(message.sender?.user_id || message.user_id);
  const sentByBot = toId(message.post_type).toLowerCase() === 'message_sent'
    || (botQq && senderId === toId(botQq));
  return sentByBot && hasText(message);
}

function hasLaterBotTextReply(history, inbound, botQq, replyWindowMs = 15 * 60 * 1000) {
  const inboundTime = messageTimeMs(inbound);
  return history.some((message) => {
    const replyTime = messageTimeMs(message);
    return replyTime >= inboundTime
      && replyTime - inboundTime <= replyWindowMs
      && isBotTextReply(message, botQq);
  });
}

function extractHistory(result) {
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.messages) ? result.messages : [];
}

function createPrivateMessageRecoveryRuntime(options = {}) {
  const store = options.store;
  const actionClient = options.actionClient;
  const dispatchMessage = options.dispatchMessage;
  const botQq = toId(options.botQq);
  const now = options.now || Date.now;
  const logger = options.logger || console;
  const enabled = options.enabled !== false;
  const maxLookbackMs = Math.max(60_000, Number(options.maxLookbackMs) || 6 * 60 * 60 * 1000);
  const configuredOverlapMs = Number(options.overlapMs);
  const overlapMs = Number.isFinite(configuredOverlapMs)
    ? Math.max(0, configuredOverlapMs)
    : 2 * 60 * 1000;
  const recentContactLimit = Math.max(1, Number(options.recentContactLimit) || 100);
  const historyCount = Math.max(5, Number(options.historyCount) || 30);
  const replyWindowMs = Math.max(60_000, Number(options.replyWindowMs) || 15 * 60 * 1000);

  if (!store || !actionClient || typeof dispatchMessage !== 'function') {
    throw new Error('private message recovery runtime dependencies are required');
  }

  async function getHistory(userId) {
    const result = await actionClient.callAction('get_friend_msg_history', {
      user_id: toId(userId),
      count: historyCount
    });
    return extractHistory(result);
  }

  async function replay(message) {
    const claim = store.claim(message);
    if (!claim.accepted) return false;
    try {
      await dispatchMessage(message, claim);
      store.complete(message);
      return true;
    } catch (error) {
      store.fail(message, error);
      throw error;
    }
  }

  async function reconcilePending(summary) {
    for (const message of store.listPending()) {
      if (!isReplayablePrivateMessage(message)) {
        store.complete(message);
        summary.reconciledPending += 1;
        continue;
      }
      const history = await getHistory(message.user_id);
      if (hasLaterBotTextReply(history, message, botQq, replyWindowMs)) {
        store.complete(message);
        summary.reconciledPending += 1;
        continue;
      }
      if (await replay(message)) summary.replayedPending += 1;
    }
  }

  async function recoverMissedMessages(sinceMs, summary) {
    const contacts = await actionClient.callAction('get_recent_contact', { count: recentContactLimit });
    const candidates = [];

    for (const contact of Array.isArray(contacts) ? contacts : []) {
      if (Number(contact?.chatType) !== 1) continue;
      const latest = contact?.lastestMsg;
      if (!isInboundPrivateMessage(latest, botQq)) continue;
      if (messageTimeMs(latest) < sinceMs) continue;

      const history = await getHistory(contact.peerUin || latest.user_id);
      const unanswered = history
        .filter((message) => isInboundPrivateMessage(message, botQq))
        .filter(isReplayablePrivateMessage)
        .filter((message) => messageTimeMs(message) >= sinceMs)
        .filter((message) => !hasLaterBotTextReply(history, message, botQq, replyWindowMs))
        .sort((left, right) => messageTimeMs(right) - messageTimeMs(left))[0];
      if (unanswered) candidates.push(unanswered);
    }

    candidates.sort((left, right) => messageTimeMs(left) - messageTimeMs(right));
    for (const message of candidates) {
      if (await replay(message)) summary.replayedMissed += 1;
    }
  }

  async function recover(options = {}) {
    const summary = {
      enabled,
      replayedPending: 0,
      reconciledPending: 0,
      replayedMissed: 0,
      sinceMs: 0
    };
    if (!enabled) return summary;

    const currentTime = now();
    const baseline = Math.max(
      Number(store.getCursorAt() || 0),
      Number(options.fallbackSinceMs || 0)
    );
    summary.sinceMs = baseline > 0
      ? Math.max(currentTime - maxLookbackMs, baseline - overlapMs)
      : Math.max(0, currentTime - overlapMs);

    await reconcilePending(summary);
    await recoverMissedMessages(summary.sinceMs, summary);
    store.checkpoint(currentTime);
    logger.log?.('[private-message-recovery] completed', summary);
    return summary;
  }

  return { recover };
}

module.exports = {
  createPrivateMessageRecoveryRuntime,
  hasLaterBotTextReply,
  isInboundPrivateMessage,
  messageTimeMs
};
