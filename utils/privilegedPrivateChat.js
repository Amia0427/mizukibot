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

function getPrivateChatTestUserIdSet(runtimeConfig = config) {
  const preferred = normalizeIdSet(runtimeConfig?.PRIVATE_CHAT_TEST_USER_IDS);
  if (preferred.size > 0) return preferred;
  return normalizeIdSet(runtimeConfig?.PRIVATE_CHAT_ALLOWED_USER_IDS);
}

function getProactivePrivateTouchUserIdSet(runtimeConfig = config) {
  const explicit = normalizeIdSet(runtimeConfig?.PROACTIVE_PRIVATE_TOUCH_USER_IDS);
  const sourceSet = explicit.size > 0 ? explicit : getPrivateChatTestUserIdSet(runtimeConfig);
  const allowWildcard = runtimeConfig?.PROACTIVE_PRIVATE_TOUCH_ALLOW_WILDCARD === true;
  const result = new Set();
  for (const userId of sourceSet) {
    if (userId === '*' && !allowWildcard) continue;
    result.add(userId);
  }
  return result;
}

function isProactivePrivateTouchUser({
  userId = '',
  config: runtimeConfig = config
} = {}) {
  const normalizedUserId = normalizeText(userId);
  if (!normalizedUserId) return false;
  const allowSet = getProactivePrivateTouchUserIdSet(runtimeConfig);
  return allowSet.has('*') || allowSet.has(normalizedUserId);
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

function isPrivilegedPrivateChatUser({
  chatType = '',
  userId = '',
  config: runtimeConfig = config
} = {}) {
  if (!isPrivateChatTestUser({ chatType, userId, config: runtimeConfig })) return false;
  const normalizedUserId = normalizeText(userId);

  const adminSet = normalizeIdSet(runtimeConfig?.ADMIN_USER_IDS);
  return adminSet.has(normalizedUserId);
}

module.exports = {
  getPrivateChatTestUserIdSet,
  getProactivePrivateTouchUserIdSet,
  isPrivateChatTestUser,
  isPrivateChatType,
  isProactivePrivateTouchUser,
  isPrivilegedPrivateChatUser
};
