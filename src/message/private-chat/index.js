const {
  isPrivateChatTestUser,
  isPrivilegedPrivateChatUser
} = require('../../../utils/privilegedPrivateChat');

const PRIVATE_GROUP_ONLY_REPLY = '该能力当前仅支持群聊中使用，请在目标群内 @我。';
const PRIVATE_CHAT_WHITELIST_REPLY = '当前私聊接入仅对白名单用户开放。';

function isPrivateChatType(chatType = '') {
  return String(chatType || '').trim().toLowerCase() === 'private';
}

function isPrivateChatUserAllowed(userId = '', runtimeConfig = {}) {
  return isPrivateChatTestUser({
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
