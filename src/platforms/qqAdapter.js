const {
  createInboundMessage
} = require('./contracts');

const CAPABILITIES = Object.freeze([
  'text',
  'image',
  'reply',
  'mention',
  'typing',
  'reaction',
  'forward',
  'history',
  'poke',
  'qzone'
]);

function collectSegments(rawMessage) {
  return Array.isArray(rawMessage?.message) ? rawMessage.message : [];
}

function collectImageAttachments(rawMessage) {
  const attachments = [];
  for (const segment of collectSegments(rawMessage)) {
    if (String(segment?.type || '').toLowerCase() !== 'image') continue;
    const url = String(segment?.data?.url || segment?.data?.file || '').trim();
    if (url) attachments.push({ kind: 'image', url });
  }
  const raw = String(rawMessage?.raw_message || '');
  for (const match of raw.matchAll(/\[CQ:image,[^\]]*?(?:url|file)=([^,\]]+)/gi)) {
    const url = String(match[1] || '').replace(/&amp;/g, '&').trim();
    if (url && !attachments.some((item) => item.url === url)) attachments.push({ kind: 'image', url });
  }
  return attachments;
}

function collectText(rawMessage, botId) {
  const text = collectSegments(rawMessage)
    .filter((segment) => String(segment?.type || '').toLowerCase() === 'text')
    .map((segment) => String(segment?.data?.text || ''))
    .join('')
    .trim();
  if (text) return text;
  return String(rawMessage?.raw_message || '')
    .replace(/\[CQ:reply,[^\]]*\]/gi, ' ')
    .replace(botId ? new RegExp(`\\[CQ:at,qq=${String(botId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'gi') : /^$/, ' ')
    .replace(/\[CQ:image,[^\]]*\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findReplyId(rawMessage) {
  const segment = collectSegments(rawMessage).find((item) => String(item?.type || '').toLowerCase() === 'reply');
  if (segment?.data?.id) return String(segment.data.id);
  return String(String(rawMessage?.raw_message || '').match(/\[CQ:reply,[^\]]*id=([^,\]]+)/i)?.[1] || '').trim();
}

function normalizeQqMessage(rawMessage = {}, options = {}) {
  if (rawMessage.post_type !== 'message') return null;
  const botExternalId = String(rawMessage.self_id || options.botExternalId || '').trim();
  const chatType = String(rawMessage.message_type || '').toLowerCase() === 'private' ? 'private' : 'group';
  const externalUserId = String(rawMessage.user_id || '').trim();
  const conversationId = chatType === 'private' ? externalUserId : String(rawMessage.group_id || '').trim();
  const eventId = String(rawMessage.message_id || '').trim();
  if (!eventId || !externalUserId || !conversationId) return null;
  const replyId = findReplyId(rawMessage);
  return createInboundMessage({
    platform: 'qq',
    eventId,
    occurredAt: Number(rawMessage.time || 0) > 0 ? Number(rawMessage.time) * 1000 : Date.now(),
    actor: {
      externalId: externalUserId,
      displayName: rawMessage.sender?.card || rawMessage.sender?.nickname || externalUserId
    },
    conversation: {
      chatType,
      conversationId,
      displayName: rawMessage.group_name || ''
    },
    text: collectText(rawMessage, botExternalId),
    attachments: collectImageAttachments(rawMessage),
    replyTo: replyId ? { messageId: replyId } : null,
    mentionsBot: Boolean(botExternalId) && String(rawMessage.raw_message || '').includes(`[CQ:at,qq=${botExternalId}]`),
    botExternalId,
    allowPassiveContext: chatType === 'group',
    allowLongTermGroupMemory: true,
    capabilities: CAPABILITIES
  });
}

function mergeQqLegacyMessage(rawMessage = {}, legacyMessage = {}) {
  return {
    ...rawMessage,
    ...legacyMessage,
    message_id: rawMessage.message_id ?? legacyMessage.message_id,
    raw_message: rawMessage.raw_message ?? legacyMessage.raw_message,
    message: rawMessage.message ?? legacyMessage.message
  };
}

function createQqAdapter(options = {}) {
  return {
    platform: 'qq',
    capabilities: CAPABILITIES,
    normalize: (message) => normalizeQqMessage(message, options),
    async start() {},
    async stop() {},
    getHealth: () => typeof options.getHealth === 'function'
      ? options.getHealth()
      : { platform: 'qq', enabled: true, status: 'unknown' }
  };
}

module.exports = {
  CAPABILITIES,
  createQqAdapter,
  mergeQqLegacyMessage,
  normalizeQqMessage
};
