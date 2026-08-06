const assert = require('assert');

const {
  buildPlatformRuntimeConfig,
  validatePlatformRuntimeEnv
} = require('../config/platformRuntime');

(() => {
  assert.throws(
    () => validatePlatformRuntimeEnv({ DISCORD_ENABLE: 'true' }),
    /DISCORD_BOT_TOKEN/
  );
  assert.throws(
    () => validatePlatformRuntimeEnv({ TG_ENABLE: 'true' }),
    /TG_BOT_TOKEN/
  );
  assert.throws(
    () => validatePlatformRuntimeEnv({ WEIXIN_ENABLED: 'true' }),
    /WEIXIN_CREDENTIAL_MASTER_KEY/
  );
  assert.throws(
    () => validatePlatformRuntimeEnv({
      WEIXIN_ENABLED: 'true',
      WEIXIN_CREDENTIAL_MASTER_KEY: 'not-a-valid-key'
    }),
    /strict Base64 for exactly 32 bytes/
  );
  assert.doesNotThrow(() => validatePlatformRuntimeEnv({
    DISCORD_ENABLE: 'true',
    DISCORD_BOT_TOKEN: 'discord-token',
    TG_ENABLE: 'true',
    TG_BOT_TOKEN: 'telegram-token',
    WEIXIN_ENABLED: 'true',
    WEIXIN_CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 7).toString('base64')
  }));

  const values = {
    TG_ALLOWED_CHAT_IDS: ['legacy-chat']
  };
  const config = buildPlatformRuntimeConfig({
    dataDir: 'data',
    pick: (key, fallback) => values[key] ?? fallback,
    pickBool: (_key, fallback) => fallback,
    pickList: (key, fallback) => values[key] ?? fallback,
    pickNum: (_key, fallback) => fallback
  });
  assert.deepStrictEqual(config.TG_PASSIVE_CHAT_IDS, ['legacy-chat']);
  assert.strictEqual(config.PLATFORM_BIND_TTL_MS, 600000);
  assert.strictEqual(config.PLATFORM_GROUP_CONTEXT_MAX_MESSAGES, 500);
  assert.strictEqual(config.WEIXIN_ENABLED, false);
  assert.strictEqual(config.WEIXIN_DB_FILE, require('path').join('data', 'weixin.sqlite'));
  assert.deepStrictEqual(config.WEIXIN_OUTBOUND_ALLOWED_ROOTS, [
    require('path').join('data', 'create-agent', 'output'),
    require('path').join('data', 'weixin-media')
  ]);

  console.log('platformConfig.test.js passed');
})();
