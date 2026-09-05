const { createDiscordAdapter } = require('./discordAdapter');
const { createDeliveryTarget } = require('./contracts');
const { getDeliveryContext } = require('./deliveryContext');
const { createPlatformGroupContextStore } = require('./groupContextStore');
const { createPlatformIdentityStore } = require('./identityStore');
const { createQqAdapter } = require('./qqAdapter');
const { createPlatformRegistry } = require('./registry');
const { createTelegramAdapter } = require('./telegramAdapter');
const { createWeixinAdapter } = require('./weixin/adapter');
const { createWeixinStore } = require('./weixin/store');
const { getWeixinWorkerHealth } = require('../../utils/weixinWorkerSupervisor');

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
  const weixinStore = options.weixinStore || (config.WEIXIN_ENABLED === true
    ? createWeixinStore({
      databaseFile: config.WEIXIN_DB_FILE,
      masterKey: config.WEIXIN_CREDENTIAL_MASTER_KEY
    })
    : null);

  function bindWeixinIdentity(binding, previousBinding = null) {
    if (!binding) return null;
    if (
      previousBinding
      && previousBinding.ilinkUserId
      && previousBinding.ilinkUserId !== binding.ilinkUserId
    ) {
      return identityStore.replaceExternalIdentityForQq({
        platform: 'weixin',
        externalUserId: binding.ilinkUserId,
        previousExternalUserId: previousBinding.ilinkUserId,
        qqUserId: binding.qqUserId
      });
    }
    return identityStore.bindExternalIdentityToQq({
      platform: 'weixin',
      externalUserId: binding.ilinkUserId,
      qqUserId: binding.qqUserId
    });
  }

  function unbindWeixinIdentity(binding) {
    if (!binding) return { ok: false, reason: 'identity_not_found' };
    return identityStore.unlink({
      platform: 'weixin',
      externalUserId: binding.ilinkUserId,
      confirm: true
    });
  }

  for (const binding of weixinStore?.listActiveBindings() || []) bindWeixinIdentity(binding);

  let registry = null;

  function isTargetOnline(target) {
    if (!target || target.chatType !== 'private') return false;
    const adapter = registry?.get(target.platform);
    if (!adapter || adapter.enabled === false) return false;
    return adapter.getHealth?.().status === 'online';
  }

  function resolvePreferredPrivateTarget(principalId) {
    const qqIdentity = identityStore.listBindings(principalId)
      .find((identity) => identity.platform === 'qq');
    if (qqIdentity) {
      const binding = weixinStore?.getBindingByQqUserId(qqIdentity.externalUserId);
      const weixinTarget = binding?.status === 'active' && binding.notificationPlatform === 'weixin'
        ? createDeliveryTarget({
        platform: 'weixin',
        chatType: 'private',
        conversationId: binding.ilinkUserId,
        containerId: binding.accountId,
        externalUserId: binding.ilinkUserId
        })
        : null;
      if (isTargetOnline(weixinTarget)) return weixinTarget;
    }

    const recentTarget = identityStore.getLastPrivateTarget(principalId);
    if (!recentTarget) return null;
    const target = createDeliveryTarget(recentTarget);
    return isTargetOnline(target) ? target : null;
  }

  registry = createPlatformRegistry({
    identityStore,
    groupContextStore,
    resolvePreferredPrivateTarget
  });
  registry.register(createQqAdapter({
    actionClient: qqActionClient,
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
  registry.register(createWeixinAdapter({
    enabled: config.WEIXIN_ENABLED,
    store: weixinStore,
    pollIntervalMs: config.WEIXIN_INBOX_POLL_INTERVAL_MS,
    voiceSpoolDir: config.WEIXIN_VOICE_SPOOL_DIR,
    nativeVoiceEnabled: config.COMPANION_VOICE_WEIXIN_NATIVE_ENABLED,
    ffmpegPath: config.COMPANION_VOICE_WEIXIN_FFMPEG_PATH,
    getWorkerHealth: options.getWeixinWorkerHealth || (() => getWeixinWorkerHealth({
      stateFile: config.WEIXIN_WORKER_STATE_FILE,
      maxAgeMs: config.WEIXIN_WORKER_READINESS_MAX_AGE_MS
    }))
  }));

  const actionClient = createPlatformActionClient(registry, qqActionClient);
  let storesClosed = false;

  function closeStores() {
    if (storesClosed) return;
    storesClosed = true;
    groupContextStore.close();
    identityStore.close();
    weixinStore?.close();
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
    bindWeixinIdentity,
    canSendAudio: (target) => registry.canSendAudio(target),
    close,
    closeStores,
    getReadinessSnapshot,
    groupContextStore,
    identityStore,
    registry,
    resolvePrivateTarget: resolvePreferredPrivateTarget,
    sendAudio: (target, audio, sendOptions = {}) => registry.sendAudio(target, audio, sendOptions),
    sendText: (target, text, sendOptions = {}) => registry.sendText(target, text, sendOptions),
    unbindWeixinIdentity,
    weixinStore,
    start: (onMessage) => registry.startEnabled(onMessage),
    stop: () => registry.stopAll()
  };
}

module.exports = {
  createPlatformActionClient,
  createPlatformRuntime
};
