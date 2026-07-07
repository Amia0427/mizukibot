const config = require('../config');

const DISABLED_REASON = 'proactive-group-outbound-disabled';
const ENV_KEY = 'PROACTIVE_GROUP_OUTBOUND_ENABLED';
const AFFECTED_SOURCES = Object.freeze([
  'tick_touch',
  'fallback_greeting',
  'daily_share',
  'life_scheduler'
]);

function isProactiveGroupOutboundEnabled(runtimeConfig = config) {
  return runtimeConfig.PROACTIVE_GROUP_OUTBOUND_ENABLED !== false;
}

function shouldAllowProactiveGroupOutbound({
  source = '',
  groupId = '',
  runtimeConfig = config
} = {}) {
  if (isProactiveGroupOutboundEnabled(runtimeConfig)) {
    return {
      allowed: true,
      reason: 'enabled',
      source: String(source || '').trim(),
      groupId: String(groupId || '').trim()
    };
  }

  return {
    allowed: false,
    reason: DISABLED_REASON,
    source: String(source || '').trim(),
    groupId: String(groupId || '').trim()
  };
}

function buildProactiveGroupOutboundStatus(runtimeConfig = config) {
  return {
    enabled: isProactiveGroupOutboundEnabled(runtimeConfig),
    envKey: ENV_KEY,
    defaultEnabled: true,
    disabledReason: DISABLED_REASON,
    affectedSources: AFFECTED_SOURCES.slice(),
    unaffected: ['explicit_at_bot_main_reply']
  };
}

module.exports = {
  AFFECTED_SOURCES,
  DISABLED_REASON,
  ENV_KEY,
  buildProactiveGroupOutboundStatus,
  isProactiveGroupOutboundEnabled,
  shouldAllowProactiveGroupOutbound
};
