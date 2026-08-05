const PLATFORM_NAMES = new Set(['qq', 'discord', 'telegram']);

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizePlatform(value) {
  const platform = normalizeText(value).toLowerCase();
  if (!PLATFORM_NAMES.has(platform)) throw new Error(`Unsupported platform: ${platform || 'empty'}`);
  return platform;
}

function createExternalIdentityKey(platform, externalUserId) {
  const normalizedPlatform = normalizePlatform(platform);
  const userId = normalizeText(externalUserId);
  if (!userId) throw new Error('externalUserId is required');
  return `${normalizedPlatform}:${userId}`;
}

function createConversationKey(input = {}) {
  const platform = normalizePlatform(input.platform);
  const chatType = normalizeText(input.chatType).toLowerCase() === 'private' ? 'private' : 'group';
  const conversationId = normalizeText(input.conversationId);
  const containerId = normalizeText(input.containerId);
  const threadId = normalizeText(input.threadId);
  if (!conversationId) throw new Error('conversationId is required');

  if (platform === 'qq' && chatType === 'group') return conversationId;
  return [platform, chatType, containerId, conversationId, threadId]
    .map((part) => encodeURIComponent(part))
    .join(':');
}

function createDeliveryTarget(input = {}) {
  const platform = normalizePlatform(input.platform);
  const chatType = normalizeText(input.chatType).toLowerCase() === 'private' ? 'private' : 'group';
  const conversationId = normalizeText(input.conversationId);
  if (!conversationId) throw new Error('conversationId is required');
  const target = {
    platform,
    chatType,
    conversationId,
    containerId: normalizeText(input.containerId),
    threadId: normalizeText(input.threadId),
    externalUserId: normalizeText(input.externalUserId)
  };
  target.key = createConversationKey(target);
  return Object.freeze(target);
}

function parseConversationKey(value) {
  const key = normalizeText(value);
  if (!key) return null;
  const parts = key.split(':').map((part) => decodeURIComponent(part));
  if (parts.length !== 5 || !PLATFORM_NAMES.has(parts[0])) return null;
  try {
    return createDeliveryTarget({
      platform: parts[0],
      chatType: parts[1],
      containerId: parts[2],
      conversationId: parts[3],
      threadId: parts[4]
    });
  } catch (_) {
    return null;
  }
}

function normalizeAttachment(value = {}) {
  const url = normalizeText(value.url || value.file);
  if (!url) return null;
  return Object.freeze({
    kind: normalizeText(value.kind || value.type || 'file').toLowerCase() || 'file',
    url,
    name: normalizeText(value.name),
    mimeType: normalizeText(value.mimeType || value.contentType),
    size: Math.max(0, Number(value.size || 0) || 0)
  });
}

function normalizeReply(value) {
  if (!value || typeof value !== 'object') return null;
  const messageId = normalizeText(value.messageId || value.id);
  const text = normalizeText(value.text);
  const imageUrls = (Array.isArray(value.imageUrls) ? value.imageUrls : [])
    .map((item) => normalizeText(item))
    .filter(Boolean);
  if (!messageId && !text && imageUrls.length === 0) return null;
  return Object.freeze({
    messageId,
    senderId: normalizeText(value.senderId),
    senderName: normalizeText(value.senderName),
    text,
    imageUrls
  });
}

function createInboundMessage(input = {}) {
  const platform = normalizePlatform(input.platform);
  const eventId = normalizeText(input.eventId);
  const actorExternalId = normalizeText(input.actor?.externalId || input.externalUserId);
  if (!eventId) throw new Error('eventId is required');
  if (!actorExternalId) throw new Error('actor.externalId is required');

  const deliveryTarget = createDeliveryTarget({
    ...input.conversation,
    ...(input.deliveryTarget || {}),
    platform,
    externalUserId: actorExternalId
  });
  const attachments = (Array.isArray(input.attachments) ? input.attachments : [])
    .map((item) => normalizeAttachment(item))
    .filter(Boolean);

  return {
    kind: 'inbound_message_v1',
    platform,
    eventId,
    occurredAt: Math.max(0, Number(input.occurredAt || Date.now()) || Date.now()),
    actor: {
      externalId: actorExternalId,
      personId: normalizeText(input.actor?.personId),
      displayName: normalizeText(input.actor?.displayName || actorExternalId)
    },
    conversation: {
      key: deliveryTarget.key,
      chatType: deliveryTarget.chatType,
      conversationId: deliveryTarget.conversationId,
      containerId: deliveryTarget.containerId,
      threadId: deliveryTarget.threadId,
      displayName: normalizeText(input.conversation?.displayName)
    },
    deliveryTarget,
    text: String(input.text || '').trim(),
    attachments,
    replyTo: normalizeReply(input.replyTo),
    mentionsBot: input.mentionsBot === true,
    command: normalizeText(input.command),
    botExternalId: normalizeText(input.botExternalId),
    allowPassiveContext: input.allowPassiveContext === true,
    allowLongTermGroupMemory: input.allowLongTermGroupMemory !== false,
    capabilities: Array.isArray(input.capabilities) ? [...new Set(input.capabilities.map(normalizeText).filter(Boolean))] : []
  };
}

function isInboundMessage(value) {
  return value?.kind === 'inbound_message_v1' && PLATFORM_NAMES.has(value.platform);
}

function buildLegacySegments(message) {
  const segments = [];
  if (message.replyTo?.messageId) {
    segments.push({ type: 'reply', data: { id: message.replyTo.messageId } });
  }
  if (message.mentionsBot && message.botExternalId) {
    segments.push({ type: 'at', data: { qq: message.botExternalId } });
  }
  if (message.text) segments.push({ type: 'text', data: { text: message.text } });
  for (const attachment of message.attachments) {
    if (attachment.kind === 'image') {
      segments.push({ type: 'image', data: { url: attachment.url, file: attachment.url } });
    }
  }
  return segments;
}

function buildLegacyRawText(message) {
  const parts = [];
  if (message.replyTo?.messageId) parts.push(`[CQ:reply,id=${message.replyTo.messageId}]`);
  if (message.mentionsBot && message.botExternalId) parts.push(`[CQ:at,qq=${message.botExternalId}]`);
  if (message.text) parts.push(message.text);
  for (const attachment of message.attachments) {
    if (attachment.kind === 'image') parts.push(`[CQ:image,url=${attachment.url}]`);
  }
  return parts.join(' ').trim();
}

function toLegacyMessage(message) {
  if (!isInboundMessage(message)) throw new Error('InboundMessage is required');
  const personId = normalizeText(message.actor.personId || createExternalIdentityKey(message.platform, message.actor.externalId));
  const isPrivate = message.conversation.chatType === 'private';
  return {
    post_type: 'message',
    message_type: isPrivate ? 'private' : 'group',
    message_id: message.eventId,
    user_id: personId,
    external_user_id: message.actor.externalId,
    person_id: personId,
    group_id: isPrivate ? undefined : message.conversation.key,
    group_name: message.conversation.displayName,
    self_id: message.botExternalId,
    time: Math.floor(message.occurredAt / 1000),
    raw_message: buildLegacyRawText(message),
    message: buildLegacySegments(message),
    sender: {
      nickname: message.actor.displayName,
      card: message.actor.displayName
    },
    platform: message.platform,
    delivery_target: message.deliveryTarget,
    platform_capabilities: message.capabilities,
    allow_passive_context: message.allowPassiveContext,
    allow_long_term_group_memory: message.allowLongTermGroupMemory,
    canonical_message: message
  };
}

module.exports = {
  PLATFORM_NAMES,
  createConversationKey,
  createDeliveryTarget,
  createExternalIdentityKey,
  createInboundMessage,
  isInboundMessage,
  normalizePlatform,
  parseConversationKey,
  toLegacyMessage
};
