const {
  isPrivateChatAccessAllowed,
  isPrivilegedPrivateChatUser
} = require('../../../utils/privilegedPrivateChat');

const PRIVATE_GROUP_ONLY_REPLY = '这个得在目标群里喊我才行哦。';
const PRIVATE_CHAT_WHITELIST_REPLY = '私聊现在先收起来了，只对白名单和管理员开放哦。';

function isPrivateChatType(chatType = '') {
  return String(chatType || '').trim().toLowerCase() === 'private';
}

function isPrivateChatUserAllowed(userId = '', runtimeConfig = {}) {
  return isPrivateChatAccessAllowed({
    chatType: 'private',
    userId,
    config: runtimeConfig
  });
}

function canBypassPrivateGroupOnly({ chatType = '', userId = '', runtimeConfig = {} } = {}) {
  if (!isPrivateChatType(chatType)) return false;
  return isPrivilegedPrivateChatUser({
    chatType,
    userId,
    config: runtimeConfig
  });
}

module.exports = {
  PRIVATE_CHAT_WHITELIST_REPLY,
  PRIVATE_GROUP_ONLY_REPLY,
  canBypassPrivateGroupOnly,
  isPrivateChatType,
  isPrivateChatUserAllowed
};
