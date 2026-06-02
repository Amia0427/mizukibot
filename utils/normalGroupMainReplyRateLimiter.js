const DEFAULT_RPM_LIMIT = 12;
const DEFAULT_WINDOW_MS = 60 * 1000;
const NORMAL_GROUP_MAIN_REPLY_RPM_LIMITED_CODE = 'normal_group_main_reply_rpm_limited';

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeBool(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizePositiveInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

function resolveLimiterConfig(runtimeConfig = {}) {
  return {
    enabled: normalizeBool(runtimeConfig.NORMAL_GROUP_MAIN_REPLY_RPM_LIMIT_ENABLED, true),
    limit: normalizePositiveInt(runtimeConfig.NORMAL_GROUP_MAIN_REPLY_RPM_LIMIT, DEFAULT_RPM_LIMIT),
    windowMs: normalizePositiveInt(runtimeConfig.NORMAL_GROUP_MAIN_REPLY_RPM_WINDOW_MS, DEFAULT_WINDOW_MS)
  };
}

function shouldRateLimitNormalGroupMainReply(input = {}, options = {}) {
  const userId = normalizeText(input.userId || input.senderId);
  const groupId = normalizeText(input.groupId);
  const chatType = normalizeText(input.chatType || input.routeMeta?.chatType || input.routeMeta?.chat_type).toLowerCase();
  const topRouteType = normalizeText(
    input.topRouteType
    || input.routeExecutionPlan?.topRouteType
    || input.executionPlan?.topRouteType
    || input.routeMeta?.topRouteType
  ).toLowerCase();

  if (chatType !== 'group') return { eligible: false, reason: 'not_group_chat' };
  if (!groupId) return { eligible: false, reason: 'missing_group_id' };
  if (!userId) return { eligible: false, reason: 'missing_user_id' };
  if (topRouteType && topRouteType !== 'direct_chat') return { eligible: false, reason: 'not_direct_chat' };
  if (typeof options.isAdminUser === 'function' && options.isAdminUser(userId)) {
    return { eligible: false, reason: 'admin_user' };
  }

  return {
    eligible: true,
    reason: 'eligible',
    userId,
    groupId,
    chatType: 'group',
    topRouteType: topRouteType || 'direct_chat'
  };
}

function createNormalGroupMainReplyRateLimiter(runtimeConfig = {}, options = {}) {
  let timestamps = [];
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();

  function prune(now = nowFn(), windowMs = resolveLimiterConfig(runtimeConfig).windowMs) {
    const cutoff = Math.max(0, Number(now || 0) - Math.max(0, Number(windowMs || 0)));
    timestamps = timestamps.filter((ts) => Number(ts || 0) > cutoff);
  }

  function snapshot(options = {}) {
    const cfg = resolveLimiterConfig(runtimeConfig);
    const now = Number(options.now || nowFn()) || 0;
    prune(now, cfg.windowMs);
    return {
      enabled: cfg.enabled,
      limit: cfg.limit,
      windowMs: cfg.windowMs,
      count: timestamps.length,
      timestamps: timestamps.slice()
    };
  }

  function reset() {
    timestamps = [];
  }

  function tryAcquire(input = {}, options = {}) {
    const cfg = resolveLimiterConfig(runtimeConfig);
    const now = Number(options.now || nowFn()) || 0;
    const eligibility = shouldRateLimitNormalGroupMainReply(input, options);

    if (!eligibility.eligible) {
      return {
        allowed: true,
        limited: false,
        bypassed: true,
        reason: eligibility.reason,
        code: ''
      };
    }

    if (!cfg.enabled || cfg.limit <= 0 || cfg.windowMs <= 0) {
      return {
        allowed: true,
        limited: false,
        bypassed: true,
        reason: cfg.enabled ? 'disabled_by_non_positive_config' : 'disabled',
        code: '',
        limit: cfg.limit,
        windowMs: cfg.windowMs
      };
    }

    prune(now, cfg.windowMs);

    if (timestamps.length >= cfg.limit) {
      const oldest = timestamps.length > 0 ? timestamps[0] : now;
      return {
        allowed: false,
        limited: true,
        bypassed: false,
        reason: NORMAL_GROUP_MAIN_REPLY_RPM_LIMITED_CODE,
        code: NORMAL_GROUP_MAIN_REPLY_RPM_LIMITED_CODE,
        limit: cfg.limit,
        windowMs: cfg.windowMs,
        count: timestamps.length,
        remaining: 0,
        retryAfterMs: Math.max(0, oldest + cfg.windowMs - now),
        userId: eligibility.userId,
        groupId: eligibility.groupId,
        chatType: eligibility.chatType,
        topRouteType: eligibility.topRouteType
      };
    }

    timestamps.push(now);

    return {
      allowed: true,
      limited: false,
      bypassed: false,
      reason: 'allowed',
      code: '',
      limit: cfg.limit,
      windowMs: cfg.windowMs,
      count: timestamps.length,
      remaining: Math.max(0, cfg.limit - timestamps.length),
      retryAfterMs: 0,
      userId: eligibility.userId,
      groupId: eligibility.groupId,
      chatType: eligibility.chatType,
      topRouteType: eligibility.topRouteType
    };
  }

  return {
    tryAcquire,
    reset,
    snapshot
  };
}

module.exports = {
  DEFAULT_RPM_LIMIT,
  DEFAULT_WINDOW_MS,
  NORMAL_GROUP_MAIN_REPLY_RPM_LIMITED_CODE,
  createNormalGroupMainReplyRateLimiter,
  resolveLimiterConfig,
  shouldRateLimitNormalGroupMainReply
};
