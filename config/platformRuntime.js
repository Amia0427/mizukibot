const path = require('path');
const { decodeMasterKey } = require('../src/platforms/weixin/crypto');

function isEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function validatePlatformRuntimeEnv(env = process.env) {
  const missing = [];
  if (isEnabled(env.DISCORD_ENABLE) && !String(env.DISCORD_BOT_TOKEN || '').trim()) {
    missing.push('DISCORD_BOT_TOKEN');
  }
  if (isEnabled(env.TG_ENABLE) && !String(env.TG_BOT_TOKEN || '').trim()) {
    missing.push('TG_BOT_TOKEN');
  }
  if (isEnabled(env.WEIXIN_ENABLED) && !String(env.WEIXIN_CREDENTIAL_MASTER_KEY || '').trim()) {
    missing.push('WEIXIN_CREDENTIAL_MASTER_KEY');
  }
  if (missing.length) {
    throw new Error(`[config] Missing required platform tokens: ${missing.join(', ')}.`);
  }
  if (isEnabled(env.WEIXIN_ENABLED)) decodeMasterKey(env.WEIXIN_CREDENTIAL_MASTER_KEY);
}

function buildPlatformRuntimeConfig({ dataDir, pick, pickBool, pickList, pickNum }) {
  return {
    PLATFORM_IDENTITY_DB_FILE: pick('PLATFORM_IDENTITY_DB_FILE', path.join(dataDir, 'platform-identities.sqlite')),
    PLATFORM_GROUP_CONTEXT_DB_FILE: pick(
      'PLATFORM_GROUP_CONTEXT_DB_FILE',
      path.join(dataDir, 'platform-group-context.sqlite')
    ),
    PLATFORM_BIND_TTL_MS: Math.max(60_000, pickNum('PLATFORM_BIND_TTL_MS', 10 * 60_000)),
    PLATFORM_GROUP_CONTEXT_RETENTION_MS: Math.max(
      60_000,
      pickNum('PLATFORM_GROUP_CONTEXT_RETENTION_MS', 24 * 60 * 60_000)
    ),
    PLATFORM_GROUP_CONTEXT_MAX_MESSAGES: Math.max(
      20,
      Math.min(5_000, pickNum('PLATFORM_GROUP_CONTEXT_MAX_MESSAGES', 500))
    ),
    DISCORD_ENABLE: pickBool('DISCORD_ENABLE', false),
    DISCORD_BOT_TOKEN: pick('DISCORD_BOT_TOKEN', ''),
    DISCORD_PASSIVE_CHANNEL_IDS: pickList('DISCORD_PASSIVE_CHANNEL_IDS', []),
    DISCORD_COMMAND_GUILD_IDS: pickList('DISCORD_COMMAND_GUILD_IDS', []),
    DISCORD_REGISTER_COMMANDS: pickBool('DISCORD_REGISTER_COMMANDS', true),
    TG_ENABLE: pickBool('TG_ENABLE', false),
    TG_BOT_TOKEN: pick('TG_BOT_TOKEN', ''),
    TG_PASSIVE_CHAT_IDS: pickList('TG_PASSIVE_CHAT_IDS', pickList('TG_ALLOWED_CHAT_IDS', [])),
    TG_ALLOWED_CHAT_IDS: pickList('TG_ALLOWED_CHAT_IDS', []),
    WEIXIN_ENABLED: pickBool('WEIXIN_ENABLED', false),
    WEIXIN_CREDENTIAL_MASTER_KEY: pick('WEIXIN_CREDENTIAL_MASTER_KEY', ''),
    WEIXIN_DB_FILE: pick('WEIXIN_DB_FILE', path.join(dataDir, 'weixin.sqlite')),
    WEIXIN_MEDIA_CACHE_DIR: pick('WEIXIN_MEDIA_CACHE_DIR', path.join(dataDir, 'weixin-media')),
    WEIXIN_VOICE_SPOOL_DIR: pick(
      'WEIXIN_VOICE_SPOOL_DIR',
      path.join(dataDir, 'weixin-media', 'outbound-voice')
    ),
    WEIXIN_MEDIA_MAX_AGE_MS: Math.max(60_000, pickNum('WEIXIN_MEDIA_MAX_AGE_MS', 24 * 60 * 60_000)),
    WEIXIN_OUTBOUND_ALLOWED_ROOTS: pickList('WEIXIN_OUTBOUND_ALLOWED_ROOTS', [
      path.join(dataDir, 'create-agent', 'output'),
      path.join(dataDir, 'weixin-media'),
      path.join(dataDir, 'weixin-media', 'outbound-voice')
    ]),
    WEIXIN_INBOX_POLL_INTERVAL_MS: Math.max(50, pickNum('WEIXIN_INBOX_POLL_INTERVAL_MS', 250)),
    WEIXIN_QR_TTL_MS: Math.max(60_000, pickNum('WEIXIN_QR_TTL_MS', 5 * 60_000)),
    WEIXIN_WORKER_SUPERVISOR_ENABLED: pickBool('WEIXIN_WORKER_SUPERVISOR_ENABLED', true),
    WEIXIN_WORKER_HEARTBEAT_MS: Math.max(1_000, pickNum('WEIXIN_WORKER_HEARTBEAT_MS', 15_000)),
    WEIXIN_WORKER_STATE_FILE: pick(
      'WEIXIN_WORKER_STATE_FILE',
      path.join(dataDir, 'runtime', 'weixin-worker', 'worker-state.json')
    ),
    WEIXIN_WORKER_READINESS_MAX_AGE_MS: Math.max(
      5_000,
      pickNum('WEIXIN_WORKER_READINESS_MAX_AGE_MS', 60_000)
    ),
    WEIXIN_WORKER_SHUTDOWN_DRAIN_MS: Math.max(
      1_000,
      pickNum('WEIXIN_WORKER_SHUTDOWN_DRAIN_MS', 15_000)
    ),
    WEIXIN_WORKER_PID_FILE: pick('WEIXIN_WORKER_PID_FILE', path.join(dataDir, 'runtime', 'weixin-worker.pid')),
    WEIXIN_WORKER_LOCK_FILE: pick('WEIXIN_WORKER_LOCK_FILE', path.join(dataDir, 'runtime', 'weixin-worker.lock'))
  };
}

module.exports = {
  buildPlatformRuntimeConfig,
  validatePlatformRuntimeEnv
};
