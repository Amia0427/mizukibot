const config = require('../config');
const { resolveMainModelConfig } = require('./mainModelFallback');
const { isPrivilegedPrivateChatUser } = require('./privilegedPrivateChat');

function normalizeText(value) {
  return String(value || '').trim();
}

function getAdminUserIdSet() {
  return new Set(
    (Array.isArray(config.ADMIN_USER_IDS) ? config.ADMIN_USER_IDS : [])
      .map((item) => normalizeText(item))
      .filter(Boolean)
  );
}

function isAdminMainModelUser(userId = '', options = {}) {
  const normalizedUserId = normalizeText(userId);
  if (!getAdminUserIdSet().has(normalizedUserId)) return false;
  return isPrivilegedPrivateChatUser({
    chatType: options?.chatType || options?.routeMeta?.chatType || options?.routeMeta?.chat_type,
    userId: normalizedUserId,
    config
  });
}

function shouldBypassMainModelFallback(userId = '', options = {}) {
  return isAdminMainModelUser(userId, options);
}

function resolveRoleAwareMainModelConfig(userId = '', overrides = null, options = {}) {
  const base = overrides && typeof overrides === 'object' ? { ...overrides } : {};
  const isAdmin = isAdminMainModelUser(userId, options);

  return {
    ...base,
    model: normalizeText(
      base.model
      || (isAdmin ? config.ADMIN_AI_MODEL : '')
      || config.AI_MODEL
      || 'gpt-5.4'
    ) || 'gpt-5.4',
    apiBaseUrl: normalizeText(
      base.apiBaseUrl
      || (isAdmin ? config.ADMIN_API_BASE_URL : '')
      || config.API_BASE_URL
      || ''
    ),
    apiKey: normalizeText(
      base.apiKey
      || (isAdmin ? config.ADMIN_API_KEY : '')
      || config.API_KEY
      || ''
    )
  };
}

function resolveUserScopedMainModelConfig(userId = '', overrides = null, options = {}) {
  const primaryConfig = resolveRoleAwareMainModelConfig(userId, overrides, options);
  if (shouldBypassMainModelFallback(userId, options)) {
    return {
      ...primaryConfig,
      __mainFallbackActive: false
    };
  }
  return resolveMainModelConfig(primaryConfig);
}

module.exports = {
  isAdminMainModelUser,
  shouldBypassMainModelFallback,
  resolveRoleAwareMainModelConfig,
  resolveUserScopedMainModelConfig
};
