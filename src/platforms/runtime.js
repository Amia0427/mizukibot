const { createDiscordAdapter } = require('./discordAdapter');
const { createDeliveryTarget } = require('./contracts');
const { getDeliveryContext } = require('./deliveryContext');
const { createPlatformGroupContextStore } = require('./groupContextStore');
const { createPlatformIdentityStore } = require('./identityStore');
const { createQqAdapter } = require('./qqAdapter');
const { createPlatformRegistry } = require('./registry');
const { createTelegramAdapter } = require('./telegramAdapter');

function createPlatformActionClient(registry, qqActionClient) {
  if (!registry || !qqActionClient) throw new Error('platform registry and QQ action client are required');
  return new Proxy(qqActionClient, {
    get(target, property) {
      if (property === 'callAction') {
        return async (action, params, options) => {
          const routed = await registry.routeLegacyAction({ action, params });
          if (routed.handled) return routed.result;
          return target.callAction(action, params, options);
        };
      }
      if (property === 'getConnectionState') {
        return () => {
          const platform = getDeliveryContext()?.target?.platform;
          if (platform && platform !== 'qq') {
            const health = registry.get(platform)?.getHealth?.() || {};
            const connected = health.status === 'online';
            return {
              connected,
              readyStateName: connected ? 'open' : String(health.status || 'degraded')
            };
          }
          return target.getConnectionState();
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function createPlatformRuntime(config, options = {}) {
  if (!config) throw new Error('config is required');
  const qqActionClient = options.qqActionClient;
  if (!qqActionClient) throw new Error('qqActionClient is required');

  const identityStore = options.identityStore || createPlatformIdentityStore({
    databaseFile: config.PLATFORM_IDENTITY_DB_FILE,
    linkCodeTtlMs: config.PLATFORM_BIND_TTL_MS,
    adminUserIds: config.ADMIN_USER_IDS
  });
  const groupContextStore = options.groupContextStore || createPlatformGroupContextStore({
    databaseFile: config.PLATFORM_GROUP_CONTEXT_DB_FILE,
    retentionMs: config.PLATFORM_GROUP_CONTEXT_RETENTION_MS,
    maxMessages: config.PLATFORM_GROUP_CONTEXT_MAX_MESSAGES
  });
  let registry = null;

  function resolvePrivateTarget(principalId) {
    const recentTarget = identityStore.getLastPrivateTarget(principalId);
    if (!recentTarget) return null;
    const target = createDeliveryTarget(recentTarget);
    const adapter = registry?.get(target.platform);
    if (!adapter || adapter.enabled === false) return null;
    return adapter.getHealth?.().status === 'online' ? target : null;
  }

  registry = createPlatformRegistry({ identityStore, groupContextStore });
  registry.register(createQqAdapter({
    getHealth() {
      const connection = qqActionClient.getConnectionState();
      return {
        status: connection?.connected ? 'online' : 'degraded',
        connection
      };
    }
  }));
  registry.register(createDiscordAdapter({
    enabled: config.DISCORD_ENABLE,
    token: config.DISCORD_BOT_TOKEN,
    passiveChannelIds: config.DISCORD_PASSIVE_CHANNEL_IDS,
    commandGuildIds: config.DISCORD_COMMAND_GUILD_IDS,
    registerCommands: config.DISCORD_REGISTER_COMMANDS,
    client: options.discordClient,
    discordModule: options.discordModule
  }));
  registry.register(createTelegramAdapter({
    enabled: config.TG_ENABLE,
    token: config.TG_BOT_TOKEN,
    passiveChatIds: config.TG_PASSIVE_CHAT_IDS,
    bot: options.telegramBot,
    TelegramBot: options.TelegramBot
  }));

  const actionClient = createPlatformActionClient(registry, qqActionClient);
  let storesClosed = false;

  function closeStores() {
    if (storesClosed) return;
    storesClosed = true;
    groupContextStore.close();
    identityStore.close();
  }

  async function close() {
    await registry.stopAll();
    closeStores();
  }

  function getReadinessSnapshot() {
    const platforms = registry.getHealth();
    const enabled = platforms.filter((item) => item.enabled !== false);
    return {
      messageIngressReady: enabled.length === 0 || enabled.some((item) => item.status === 'online'),
      platforms
    };
  }

  return {
    actionClient,
    close,
    closeStores,
    getReadinessSnapshot,
    groupContextStore,
    identityStore,
    registry,
    resolvePrivateTarget,
    start: (onMessage) => registry.startEnabled(onMessage),
    stop: () => registry.stopAll()
  };
}

module.exports = {
  createPlatformActionClient,
  createPlatformRuntime
};
