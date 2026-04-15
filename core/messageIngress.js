const {
  clearGroupBindingsByGroupId
} = require('../utils/memory');

/**
 * @typedef {Object} InboundMessageContext
 * @property {object} msg
 * @property {object} effectiveMsg
 * @property {string} groupId
 * @property {string} senderId
 * @property {string} rawText
 * @property {string} cleanText
 * @property {string|null} imageUrl
 * @property {boolean} isAtBot
 * @property {string} botQQ
 * @property {string} platform
 * @property {'group'|'private'} chatType
 * @property {string|null} groupName
 * @property {object|null} sessionTiming
 * @property {object|null} continuousMeta
 * @property {object|null} directedContext
 * @property {object} messageMeta
 */

function shouldHandleNotice(msg = {}, runtimeConfig = {}) {
  if (msg.post_type !== 'notice') return { handled: false };

  const noticeType = String(msg.notice_type || '').trim().toLowerCase();
  const subType = String(msg.sub_type || '').trim().toLowerCase();
  const operatorId = String(msg.operator_id || '');
  const userId = String(msg.user_id || '');
  const selfId = String(msg.self_id || runtimeConfig.BOT_QQ || '');
  const groupId = msg.group_id;

  if (noticeType === 'group_decrease' || noticeType === 'group_increase') {
    const targetIsBot = selfId && userId === selfId;
    const botWasRemoved = targetIsBot && (subType === 'kick_me' || subType === 'leave' || operatorId !== selfId);
    if (botWasRemoved && groupId) {
      const cleared = clearGroupBindingsByGroupId(groupId);
      if (cleared > 0) {
        console.warn('[group-binding] cleared cached group bindings after bot left group', { groupId, cleared, subType });
      }
    }
  }

  return { handled: true };
}

function shouldSkipNonGroupMessage(msg = {}) {
  if (msg.post_type !== 'message') return true;
  const messageType = String(msg.message_type || '').trim().toLowerCase();
  return !new Set(['group', 'private']).has(messageType);
}

function shouldSkipSelfMessage(msg = {}, runtimeConfig = {}) {
  const senderId = String(msg.user_id || '');
  const selfId = String(msg.self_id || runtimeConfig.BOT_QQ || '');
  if (!selfId || senderId !== selfId) return false;

  console.log('[message] skip self message', {
    selfId,
    groupId: msg.group_id,
    messageId: msg.message_id
  });
  return true;
}

function resolveEffectiveBotQQ(msg = {}, runtimeConfig = {}) {
  const selfId = String(msg.self_id || runtimeConfig.BOT_QQ || '').trim();
  return selfId || String(runtimeConfig.BOT_QQ || '').trim();
}

function safePlatform(msg = {}) {
  return String(msg.platform || 'qq').trim() || 'qq';
}

function safeGroupName(msg = {}) {
  return String(
    msg.group_name
    || msg.groupName
    || msg.group?.group_name
    || ''
  ).trim();
}

function buildInboundMessageContext({
  msg,
  effectiveMsg = null,
  rawText = '',
  cleanText = '',
  imageUrl = null,
  isAtBot = false,
  botQQ = '',
  sessionTiming = null,
  continuousMeta = null,
  directedContext = null
} = {}) {
  const nextMsg = effectiveMsg || msg || {};
  return {
    msg: msg || {},
    effectiveMsg: nextMsg,
    groupId: String(nextMsg.group_id || msg?.group_id || '').trim(),
    senderId: String(nextMsg.user_id || msg?.user_id || '').trim(),
    rawText: String(rawText || ''),
    cleanText: String(cleanText || ''),
    imageUrl: imageUrl || null,
    isAtBot: Boolean(isAtBot),
    botQQ: String(botQQ || '').trim(),
    platform: safePlatform(nextMsg),
    chatType: String(nextMsg.message_type || 'group').trim() === 'private' ? 'private' : 'group',
    groupName: safeGroupName(nextMsg) || null,
    sessionTiming: sessionTiming && typeof sessionTiming === 'object'
      ? { ...sessionTiming }
      : null,
    continuousMeta: continuousMeta || null,
    directedContext: directedContext && typeof directedContext === 'object'
      ? { ...directedContext }
      : null,
    messageMeta: {
      messageId: String(nextMsg.message_id || '').trim(),
      senderName: String(
        nextMsg.sender?.card
        || nextMsg.sender?.nickname
        || nextMsg.sender?.nick
        || nextMsg.user_id
        || ''
      ).trim(),
      groupName: safeGroupName(nextMsg) || ''
    }
  };
}

module.exports = {
  buildInboundMessageContext,
  resolveEffectiveBotQQ,
  shouldHandleNotice,
  shouldSkipNonGroupMessage,
  shouldSkipSelfMessage
};
