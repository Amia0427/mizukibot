const crypto = require('crypto');

const NO_VOICE_TRANSCRIPT_REPLY = '当前语音未提供可识别文字，请改用文字发送';
const WEIXIN_CAPABILITIES = Object.freeze(['text', 'image', 'file']);

function normalizedId(value) {
  return String(value ?? '').trim();
}

function auditRejection(store, binding, reason, senderId) {
  const event = {
    event: 'inbound_rejected',
    accountId: binding.accountId || binding.ilinkBotId,
    reason
  };
  if (senderId) event.senderId = senderId;
  store.appendAudit(event);
}

function stableMessageId(message, accountId) {
  const officialId = normalizedId(message.message_id || message.client_id || message.seq);
  if (officialId) return officialId;
  return `fallback-${crypto.createHash('sha256').update(JSON.stringify({
    accountId,
    fromUserId: normalizedId(message.from_user_id),
    toUserId: normalizedId(message.to_user_id),
    createdAt: Number(message.create_time_ms || message.create_time || 0),
    items: message.item_list || []
  })).digest('hex')}`;
}

async function evaluateInboundMessage(message, binding, deps) {
  const accountId = binding.accountId || binding.ilinkBotId;

  if (normalizedId(message.group_id)) {
    auditRejection(deps.store, binding, 'group_message');
    return { accepted: false, reason: 'group_message' };
  }
  if (message.message_type !== 1) {
    auditRejection(deps.store, binding, 'not_user_message');
    return { accepted: false, reason: 'not_user_message' };
  }
  if (normalizedId(message.to_user_id) !== normalizedId(binding.ilinkBotId)) {
    auditRejection(deps.store, binding, 'wrong_bot');
    return { accepted: false, reason: 'wrong_bot' };
  }
  if (normalizedId(message.from_user_id) !== normalizedId(binding.ilinkUserId)) {
    auditRejection(deps.store, binding, 'unbound_sender', normalizedId(message.from_user_id));
    return { accepted: false, reason: 'unbound_sender' };
  }

  const textParts = [];
  const attachments = [];
  let directReplyText = '';
  for (const item of message.item_list || []) {
    if (item.type === 1 && item.text_item?.text?.trim()) {
      textParts.push(item.text_item.text.trim());
      continue;
    }
    if (item.type === 3) {
      if (item.voice_item?.text?.trim()) {
        textParts.push(item.voice_item.text.trim());
      } else {
        directReplyText = NO_VOICE_TRANSCRIPT_REPLY;
      }
      continue;
    }
    if (item.type === 2 || item.type === 4) {
      const attachment = await deps.mediaLoader(item);
      if (attachment) attachments.push(attachment);
    }
  }
  const messageId = stableMessageId(message, accountId);
  const peerId = normalizedId(message.from_user_id);
  const payload = {
    messageId,
    platform: 'weixin',
    canonicalUserId: normalizedId(binding.qqUserId),
    platformUserId: peerId,
    accountId,
    peerId,
    chatType: 'private',
    text: textParts.join('\n'),
    attachments,
    deliveryRoute: {
      platform: 'weixin',
      accountId,
      peerId,
      chatType: 'private'
    },
    capabilities: [...WEIXIN_CAPABILITIES],
    occurredAt: Number(message.create_time_ms || Date.now())
  };
  let enqueueResult = null;
  if (textParts.length > 0 || attachments.length > 0) {
    enqueueResult = deps.store.enqueueInbox({
      accountId,
      messageId,
      qqUserId: payload.canonicalUserId,
      peerId,
      contextToken: message.context_token,
      payload
    });
  }
  if (directReplyText) {
    if (!enqueueResult && message.context_token) {
      deps.store.setContextToken(accountId, peerId, message.context_token);
    }
    deps.store.enqueueOutbox({
      clientId: `voice-no-transcript:${accountId}:${messageId}`,
      accountId,
      peerId,
      payload: { text: directReplyText, attachments: [] }
    });
  }
  return {
    accepted: true,
    envelope: payload,
    enqueueResult,
    ...(directReplyText ? { directReplyText } : {})
  };
}

module.exports = {
  NO_VOICE_TRANSCRIPT_REPLY,
  WEIXIN_CAPABILITIES,
  evaluateInboundMessage
};
