const { getDeliveryContext } = require('./deliveryContext');
const {
  isInboundMessage,
  parseConversationKey,
  toLegacyMessage
} = require('./contracts');

function normalizeText(value) {
  return String(value || '').trim();
}

function collectLegacyMessageParts(message) {
  const textParts = [];
  const images = [];
  const segments = Array.isArray(message) ? message : null;
  if (segments) {
    for (const segment of segments) {
      const type = normalizeText(segment?.type).toLowerCase();
      if (type === 'text') textParts.push(String(segment?.data?.text || ''));
      if (type === 'image') {
        const image = normalizeText(segment?.data?.file || segment?.data?.url);
        if (image) images.push(image);
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
    textParts.push(raw
      .replace(/\[CQ:(?:at|reply|image),[^\]]*\]/gi, ' ')
      .replace(/\[\[qq_(?:face|image|record|video):[\s\S]*?\]\]/gi, ' '));
  }
  return {
    text: textParts.join('').replace(/\s+/g, ' ').trim(),
    images: [...new Set(images)]
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

  function prepareInbound(message) {
    if (!isInboundMessage(message)) throw new Error('InboundMessage is required');
    const identity = identityStore.resolveIdentity(message.platform, message.actor.externalId);
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
    const context = getDeliveryContext();
    if (context?.target) return { ...context.target, context };
    const params = payload.params || {};
    const groupTarget = parseConversationKey(params.group_id);
    if (groupTarget) return { ...groupTarget, context: null };
    const principalId = normalizeText(params.user_id);
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
    return sent;
  }

  async function routeLegacyAction(payload = {}) {
    const action = normalizeText(payload.action);
    const target = resolveActionTarget(payload);
    if (!target || target.platform === 'qq') return { handled: false, result: false };
    const adapter = get(target.platform);
    if (!adapter) return { handled: true, result: false };

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
    prepareInbound,
    register,
    routeLegacyAction,
    startEnabled,
    stopAll
  };
}

module.exports = {
  collectLegacyMessageParts,
  createPlatformRegistry,
  flattenForwardMessages
};
