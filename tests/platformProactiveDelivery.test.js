const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function restoreEnv(snapshot = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;
}

module.exports = (async () => {
  const envSnapshot = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-platform-proactive-'));
  try {
    process.env.API_KEY = 'test-key';
    process.env.DATA_DIR = tempDir;
    process.env.SHORT_TERM_SESSION_SCOPE_ENABLED = 'true';
    clearProjectCache();

    const { createPrivateProactiveEngine } = require('../core/privateProactiveEngine');
    const { createDeliveryTarget } = require('../src/platforms/contracts');
    const { chatHistory, shortTermMemory } = require('../utils/memory');
    const { resolveShortTermSessionKey } = require('../utils/shortTermMemory');

    const target = createDeliveryTarget({
      platform: 'telegram',
      chatType: 'private',
      conversationId: 'tg-chat-42',
      externalUserId: 'tg-user-42'
    });
    const sent = [];
    const engine = createPrivateProactiveEngine({
      config: {
        DATA_DIR: tempDir,
        TIMEZONE: 'UTC',
        PRIVATE_PROACTIVE_ENABLED: true,
        PRIVATE_PROACTIVE_GLOBAL_MODEL_DAILY_LIMIT: 0
      },
      stateFile: path.join(tempDir, 'state.json'),
      resolvePrivateTarget: (principalId) => principalId === 'person-42' ? target : null,
      sendPrivateMessage: async (principalId, message, deliveryTarget) => {
        sent.push({ principalId, message, deliveryTarget });
      }
    });

    await engine.registerPrivateUser('person-42');
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].principalId, 'person-42');
    assert.deepStrictEqual(sent[0].deliveryTarget, target);

    const sessionKey = resolveShortTermSessionKey('person-42', {
      platform: 'telegram',
      chatType: 'private',
      conversationKey: target.key
    });
    assert.ok(chatHistory[sessionKey].some((item) => item.role === 'assistant'));
    assert.ok(shortTermMemory[sessionKey].interaction.recentTurns.some((item) => item.role === 'assistant'));
    assert.deepStrictEqual(chatHistory['direct:person-42'], []);

    let unavailableSends = 0;
    const unavailable = createPrivateProactiveEngine({
      config: {
        DATA_DIR: tempDir,
        TIMEZONE: 'UTC',
        PRIVATE_PROACTIVE_ENABLED: true,
        PRIVATE_PROACTIVE_GLOBAL_MODEL_DAILY_LIMIT: 0
      },
      stateFile: path.join(tempDir, 'unavailable-state.json'),
      resolvePrivateTarget: () => null,
      sendPrivateMessage: async () => { unavailableSends += 1; }
    });
    const registration = await unavailable.registerPrivateUser('person-offline');
    assert.deepStrictEqual(registration, { registered: true, isNew: true, notified: false });
    assert.strictEqual(unavailableSends, 0);

    class FakeDiscordClient extends EventEmitter {
      constructor() {
        super();
        this.user = { id: 'discord-bot' };
        this.channels = { fetch: async () => null };
      }

      async login() {
        this.emit('ready');
      }

      destroy() {}
    }

    const qqActionClient = {
      async callAction() { return true; },
      getConnectionState() { return { connected: false, readyStateName: 'closed' }; }
    };
    const { createPlatformRuntime } = require('../src/platforms/runtime');
    const discordClient = new FakeDiscordClient();
    const runtime = createPlatformRuntime({
      PLATFORM_IDENTITY_DB_FILE: ':memory:',
      PLATFORM_GROUP_CONTEXT_DB_FILE: ':memory:',
      PLATFORM_BIND_TTL_MS: 600000,
      PLATFORM_GROUP_CONTEXT_RETENTION_MS: 86400000,
      PLATFORM_GROUP_CONTEXT_MAX_MESSAGES: 500,
      ADMIN_USER_IDS: [],
      DISCORD_ENABLE: true,
      DISCORD_BOT_TOKEN: 'test-token',
      DISCORD_REGISTER_COMMANDS: false,
      TG_ENABLE: false,
      WEIXIN_ENABLED: false
    }, { qqActionClient, discordClient, discordModule: {} });
    await runtime.start(async () => {});
    const discordIdentity = runtime.identityStore.resolveIdentity('discord', 'discord-user');
    const discordTarget = createDeliveryTarget({
      platform: 'discord',
      chatType: 'private',
      conversationId: 'discord-channel',
      externalUserId: 'discord-user'
    });
    runtime.identityStore.recordPrivateActivity(discordIdentity.principalId, discordTarget);
    assert.deepStrictEqual(runtime.resolvePrivateTarget(discordIdentity.principalId), discordTarget);
    discordClient.emit('error', new Error('gateway unavailable'));
    assert.strictEqual(runtime.resolvePrivateTarget(discordIdentity.principalId), null);
    await runtime.close();

    console.log('platformProactiveDelivery.test.js passed');
  } finally {
    restoreEnv(envSnapshot);
    clearProjectCache();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
