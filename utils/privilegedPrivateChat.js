const config = require('../config');

function normalizeText(value = '') {
  return String(value || '').trim();
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

function isPrivilegedPrivateChatUser({
  chatType = '',
  userId = '',
  config: runtimeConfig = config
} = {}) {
  if (!isPrivateChatType(chatType)) return false;
  const normalizedUserId = normalizeText(userId);
  if (!normalizedUserId) return false;

  const privateAllowSet = normalizeIdSet(runtimeConfig?.PRIVATE_CHAT_ALLOWED_USER_IDS);
  if (!privateAllowSet.has(normalizedUserId)) return false;

  const adminSet = normalizeIdSet(runtimeConfig?.ADMIN_USER_IDS);
  return adminSet.has(normalizedUserId);
}

module.exports = {
  isPrivateChatType,
  isPrivilegedPrivateChatUser
};
