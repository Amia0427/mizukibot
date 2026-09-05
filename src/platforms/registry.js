const { getDeliveryContext } = require('./deliveryContext');
const {
  isInboundMessage,
  parseConversationKey,
  toLegacyMessage
} = require('./contracts');

function normalizeText(value) {
  return String(value || '').trim();
}

function createRegistryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function audioModeForPlatform(platform) {
  if (platform === 'qq') return 'record';
  if (platform === 'weixin') return 'file';
  return 'attachment';
}

function collectLegacyMessageParts(message) {
  const textParts = [];
  const images = [];
  const files = [];
  const segments = Array.isArray(message) ? message : null;
  if (segments) {
    for (const segment of segments) {
      const type = normalizeText(segment?.type).toLowerCase();
      if (type === 'text') textParts.push(String(segment?.data?.text || ''));
      if (type === 'image') {
        const image = normalizeText(segment?.data?.file || segment?.data?.url);
        if (image) images.push(image);
      }
      if (type === 'file') {
        const file = normalizeText(segment?.data?.file || segment?.data?.path);
        if (file) files.push(file);
      }
    }
  } else {
    const raw = String(message || '');
    for (const match of raw.matchAll(/\[CQ:image,[^\]]*?(?:file|url)=([^,\]]+)/gi)) {
      const image = normalizeText(match[1]).replace(/&amp;/g, '&');
      if (image) images.push(image);
    }
    for (const match of raw.matchAll(/\[\[qq_image:([\s\S]*?)\]\]/gi)) {
      const image = normalizeText(match[1]);
      if (image) images.push(image);
    }
    for (const match of raw.matchAll(/\[CQ:file,[^\]]*?(?:file|path)=([^,\]]+)/gi)) {
      const file = normalizeText(match[1]).replace(/&amp;/g, '&');
      if (file) files.push(file);
    }
    textParts.push(raw
      .replace(/\[CQ:(?:at|reply|image|file),[^\]]*\]/gi, ' ')
      .replace(/\[\[qq_(?:face|image|record|video):[\s\S]*?\]\]/gi, ' '));
  }
  return {
    text: textParts.join('').replace(/\s+/g, ' ').trim(),
    images: [...new Set(images)],
    files: [...new Set(files)]
  };
}

function flattenForwardMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map((node) => {
      const content = node?.data?.content ?? node?.content ?? '';
      return collectLegacyMessageParts(content).text;
    })
    .filter(Boolean)
    .join('\n\n');
}

function createPlatformRegistry(options = {}) {
  const identityStore = options.identityStore;
  const groupContextStore = options.groupContextStore || null;
  const resolvePreferredPrivateTarget = typeof options.resolvePreferredPrivateTarget === 'function'
    ? options.resolvePreferredPrivateTarget
    : null;
  if (!identityStore) throw new Error('identityStore is required');
  const adapters = new Map();

  function register(adapter) {
    const platform = normalizeText(adapter?.platform).toLowerCase();
    if (!platform || typeof adapter !== 'object') throw new Error('valid platform adapter is required');
    if (adapters.has(platform)) throw new Error(`platform adapter already registered: ${platform}`);
    adapters.set(platform, adapter);
    return adapter;
  }

  function get(platform) {
    return adapters.get(normalizeText(platform).toLowerCase()) || null;
  }

  function canSendAudio(target) {
    const platform = normalizeText(target?.platform).toLowerCase();
    const adapter = get(platform);
    return Boolean(
      target
      && adapter
      && adapter.enabled !== false
      && Array.isArray(adapter.capabilities)
      && adapter.capabilities.includes('audio')
      && typeof adapter.sendAudio === 'function'
      && (platform !== 'weixin' || normalizeText(target.chatType).toLowerCase() === 'private')
    );
  }

  async function sendAudio(target, audio, options = {}) {
    const mode = audioModeForPlatform(normalizeText(target?.platform).toLowerCase());
    if (!canSendAudio(target)) return { status: 'not_submitted', mode };
    try {
      const result = await get(target.platform).sendAudio(target, audio, options);
      if (result && ['accepted', 'not_submitted', 'unknown'].includes(result.status)) {
        return { status: result.status, mode: result.mode || mode };
      }
      return result === false
        ? { status: 'not_submitted', mode }
        : { status: 'accepted', mode };
    } catch (_) {
      return { status: 'unknown', mode };
    }
  }

  async function sendText(target, text, options = {}) {
    const adapter = get(target?.platform);
    if (!adapter || adapter.enabled === false || typeof adapter.sendText !== 'function') return false;
    return adapter.sendText(target, text, options);
  }

  function prepareInbound(message) {
    if (!isInboundMessage(message)) throw new Error('InboundMessage is required');
    if (message.platform === 'weixin' && message.conversation.chatType !== 'private') {
      throw createRegistryError('WEIXIN_GROUP_CHAT_DISABLED', 'Weixin group chat is disabled');
    }
    const identity = message.platform === 'weixin'
      ? identityStore.resolveBoundQqPrincipal(message.platform, message.actor.externalId)
      : identityStore.resolveIdentity(message.platform, message.actor.externalId);
    if (!identity) {
      throw createRegistryError('WEIXIN_IDENTITY_NOT_BOUND', 'Weixin identity is not bound to a QQ principal');
    }
    message.actor.personId = identity.principalId;
    if (message.conversation.chatType === 'private') {
      identityStore.recordPrivateActivity(identity.principalId, message.deliveryTarget);
    } else if (message.allowPassiveContext && groupContextStore) {
      groupContextStore.append(message);
    }
    const legacy = toLegacyMessage(message);
    legacy.delivery_context = {
      target: message.deliveryTarget,
      actorExternalId: message.actor.externalId,
      personId: identity.principalId,
      messageId: message.eventId,
      replyToMessageId: message.replyTo?.messageId || ''
    };
    return legacy;
  }

  function resolveActionTarget(payload = {}) {
    const params = payload.params || {};
    const groupId = normalizeText(params.group_id);
    const context = getDeliveryContext();
    if (groupId) {
      const groupTarget = parseConversationKey(groupId);
      if (groupTarget) {
        const matchingContext = context?.target?.key === groupTarget.key ? context : null;
        return { ...groupTarget, context: matchingContext };
      }
      return {
        platform: 'qq',
        chatType: 'group',
        conversationId: groupId,
        context: null
      };
    }
    if (context?.target) return { ...context.target, context };
    const principalId = normalizeText(params.user_id);
    const preferredTarget = principalId ? resolvePreferredPrivateTarget?.(principalId) : null;
    if (preferredTarget) return { ...preferredTarget, context: null };
    if (principalId && resolvePreferredPrivateTarget) return null;
    const privateTarget = principalId ? identityStore.getLastPrivateTarget(principalId) : null;
    return privateTarget ? { ...privateTarget, context: null } : null;
  }

  async function sendLegacyMessage(adapter, target, payload, context) {
    const parts = collectLegacyMessageParts(payload.params?.message);
    let sent = false;
    if (parts.text) {
      sent = await adapter.sendText(target, parts.text, {
        replyToMessageId: context?.messageId || '',
        mentionExternalUserId: target.chatType === 'group' ? context?.actorExternalId || '' : ''
      }) !== false;
    }
    for (const image of parts.images) {
      sent = await adapter.sendImage(target, image, {
        replyToMessageId: context?.messageId || ''
      }) !== false || sent;
    }
    for (const file of parts.files) {
      if (typeof adapter.sendFile !== 'function') continue;
      sent = await adapter.sendFile(target, file, {
        replyToMessageId: context?.messageId || ''
      }) !== false || sent;
    }
    return sent;
  }

  async function routeLegacyAction(payload = {}) {
    const action = normalizeText(payload.action);
    const target = resolveActionTarget(payload);
    if (!target || target.platform === 'qq') return { handled: false, result: false };
    if (target.platform === 'weixin' && target.chatType !== 'private') {
      return { handled: true, result: false };
    }
    const adapter = get(target.platform);
    if (!adapter) return { handled: true, result: false };
    if (target.platform === 'weixin') {
      if (typeof adapter.validateTarget !== 'function' || !await adapter.validateTarget(target)) {
        return { handled: true, result: false };
      }
    }

    if (action === 'send_group_msg' || action === 'send_private_msg') {
      return {
        handled: true,
        result: await sendLegacyMessage(adapter, target, payload, target.context)
      };
    }
    if (action === 'send_group_forward_msg' || action === 'send_private_forward_msg') {
      const text = flattenForwardMessages(payload.params?.messages);
      return {
        handled: true,
        result: Boolean(text) && await adapter.sendText(target, text, {
          replyToMessageId: target.context?.messageId || ''
        }) !== false
      };
    }
    if (action === 'set_msg_emoji_like') {
      return {
        handled: true,
        result: typeof adapter.react === 'function'
          ? await adapter.react(target, normalizeText(payload.params?.message_id || target.context?.messageId), '⏳') !== false
          : false
      };
    }
    if (action === 'group_poke' || action === 'friend_poke') {
      return {
        handled: true,
        result: typeof adapter.react === 'function'
          ? await adapter.react(target, normalizeText(target.context?.messageId), '👋') !== false
          : false
      };
    }
    return { handled: true, result: false };
  }

  async function startEnabled(onMessage) {
    const starts = [];
    for (const adapter of adapters.values()) {
      if (adapter.platform === 'qq' || adapter.enabled === false) continue;
      starts.push(Promise.resolve()
        .then(() => adapter.start({
          onMessage: async (message, source = `${adapter.platform}_ingress`) => {
            const legacy = prepareInbound(message);
            await onMessage(legacy, source);
          }
        }))
        .catch((error) => {
          if (typeof adapter.markDegraded === 'function') adapter.markDegraded(error);
          console.error(`[platform:${adapter.platform}] start failed`, error?.message || error);
          return null;
        }));
    }
    return Promise.all(starts);
  }

  async function stopAll() {
    await Promise.all([...adapters.values()].map(async (adapter) => {
      if (typeof adapter.stop === 'function') await adapter.stop();
    }));
  }

  function getHealth() {
    return [...adapters.values()].map((adapter) => ({
      platform: adapter.platform,
      enabled: adapter.enabled !== false,
      ...(typeof adapter.getHealth === 'function' ? adapter.getHealth() : { status: 'unknown' })
    }));
  }

  return {
    get,
    getHealth,
    canSendAudio,
    prepareInbound,
    register,
    routeLegacyAction,
    sendAudio,
    sendText,
    startEnabled,
    stopAll
  };
}

module.exports = {
  collectLegacyMessageParts,
  createPlatformRegistry,
  flattenForwardMessages
};
