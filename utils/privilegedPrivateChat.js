const config = require('../config');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function normalizeIdSet(list = []) {
  return new Set(
    (Array.isArray(list) ? list : [])
      .map((item) => normalizeText(item))
      .filter(Boolean)
  );
}

function isPrivateChatType(chatType = '') {
  return normalizeText(chatType).toLowerCase() === 'private';
}

function getPrivateChatTestUserIdSet(runtimeConfig = config) {
  const preferred = normalizeIdSet(runtimeConfig?.PRIVATE_CHAT_TEST_USER_IDS);
  if (preferred.size > 0) return preferred;
  return normalizeIdSet(runtimeConfig?.PRIVATE_CHAT_ALLOWED_USER_IDS);
}

function isPrivateChatTestUser({
  chatType = '',
  userId = '',
  config: runtimeConfig = config
} = {}) {
  if (!isPrivateChatType(chatType)) return false;
  const normalizedUserId = normalizeText(userId);
  if (!normalizedUserId) return false;
  const allowSet = getPrivateChatTestUserIdSet(runtimeConfig);
  return allowSet.has('*') || allowSet.has(normalizedUserId);
}

function isAdminUserId(userId = '', runtimeConfig = config) {
  const normalizedUserId = normalizeText(userId);
  if (!normalizedUserId) return false;
  const adminSet = normalizeIdSet(runtimeConfig?.ADMIN_USER_IDS);
  return adminSet.has(normalizedUserId);
}

function resolvePrivateChatContext(input = {}) {
  const source = normalizeObject(input, {});
  const routeMeta = normalizeObject(source.routeMeta || source.meta, {});
  return {
    chatType: normalizeText(
      source.chatType
      || source.chat_type
      || routeMeta.chatType
      || routeMeta.chat_type
      || routeMeta.messageType
      || routeMeta.message_type
    ),
    userId: normalizeText(
      source.userId
      || source.user_id
      || source.senderId
      || source.sender_id
      || routeMeta.userId
      || routeMeta.user_id
      || routeMeta.senderId
      || routeMeta.sender_id
    ),
    routeMeta
  };
}

function isAdminPrivateChatContext(input = {}, runtimeConfig = config) {
  const context = resolvePrivateChatContext(input);
  return isPrivateChatType(context.chatType) && isAdminUserId(context.userId, runtimeConfig);
}

function isPrivateChatAccessAllowed({
  chatType = '',
  userId = '',
  config: runtimeConfig = config
} = {}) {
  if (!isPrivateChatType(chatType)) return false;
  return isPrivateChatTestUser({ chatType, userId, config: runtimeConfig })
    || isAdminUserId(userId, runtimeConfig);
}

function isPrivilegedPrivateChatUser({
  chatType = '',
  userId = '',
  config: runtimeConfig = config
} = {}) {
  return isPrivateChatAccessAllowed({ chatType, userId, config: runtimeConfig });
}

module.exports = {
  getPrivateChatTestUserIdSet,
  isAdminPrivateChatContext,
  isAdminUserId,
  isPrivateChatAccessAllowed,
  isPrivateChatTestUser,
  isPrivateChatType,
  isPrivilegedPrivateChatUser,
  resolvePrivateChatContext
};
