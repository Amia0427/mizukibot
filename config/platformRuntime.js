const path = require('path');

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
  if (missing.length) {
    throw new Error(`[config] Missing required platform tokens: ${missing.join(', ')}.`);
  }
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
    TG_ALLOWED_CHAT_IDS: pickList('TG_ALLOWED_CHAT_IDS', [])
  };
}

module.exports = {
  buildPlatformRuntimeConfig,
  validatePlatformRuntimeEnv
};
