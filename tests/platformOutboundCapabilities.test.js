const assert = require('assert');
const { EventEmitter } = require('events');

const { createDeliveryTarget } = require('../src/platforms/contracts');
const { createDiscordAdapter } = require('../src/platforms/discordAdapter');
const { createQqAdapter } = require('../src/platforms/qqAdapter');
const { createPlatformRegistry } = require('../src/platforms/registry');
const { createTelegramAdapter } = require('../src/platforms/telegramAdapter');

module.exports = (async () => {
  const discordCalls = [];
  const discordMessage = {
    id: 'discord-message',
    content: 'fetched',
    author: { id: 'author', username: 'Alice' },
    attachments: new Map(),
    async react(emoji) { discordCalls.push({ type: 'reaction', emoji }); }
  };
  const discordChannel = {
    async send(payload) { discordCalls.push({ type: 'send', payload }); },
    async sendTyping() { discordCalls.push({ type: 'typing' }); },
    messages: { fetch: async () => discordMessage }
  };
  class FakeDiscordClient extends EventEmitter {
    constructor() {
      super();
      this.user = { id: 'discord-bot' };
      this.channels = { fetch: async () => discordChannel };
    }

    async login() { this.emit('ready'); }
    destroy() {}
  }

  const originalConsoleError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    const discordClient = new FakeDiscordClient();
    const discordAdapter = createDiscordAdapter({
      enabled: true,
      token: 'discord-token',
      registerCommands: false,
      client: discordClient,
      discordModule: {}
    });
    await discordAdapter.start({
      onMessage: async () => {}
    });
    const discordTarget = createDeliveryTarget({
      platform: 'discord',
      chatType: 'group',
      conversationId: 'channel-1',
      containerId: 'guild-1'
    });
    await discordAdapter.sendText(discordTarget, 'hello', {
      mentionExternalUserId: 'user-1',
      replyToMessageId: 'message-0'
    });
    await discordAdapter.sendImage(discordTarget, Buffer.from('image'));
    const discordAudio = await discordAdapter.sendAudio(discordTarget, {
      buffer: Buffer.from('audio'),
      mimeType: 'audio/mpeg',
      format: 'mp3',
      fileName: 'mizuki-voice.mp3'
    });
    assert.deepStrictEqual(discordAudio, { status: 'accepted', mode: 'attachment' });
    await discordAdapter.setTyping(discordTarget);
    await discordAdapter.react(discordTarget, 'message-1', '👍');
    assert.strictEqual((await discordAdapter.fetchMessage(discordTarget, 'message-1')).text, 'fetched');
    assert.strictEqual(discordCalls[0].payload.content, '<@user-1> hello');
    assert.deepStrictEqual(discordCalls[0].payload.reply, {
      messageReference: 'message-0',
      failIfNotExists: false
    });
    assert.ok(discordCalls.some((item) => item.type === 'typing'));
    assert.ok(discordCalls.some((item) => item.type === 'reaction' && item.emoji === '👍'));
    const discordAudioPayload = discordCalls.find((item) => item.type === 'send' && item.payload.files?.[0]?.name === 'mizuki-voice.mp3');
    assert.strictEqual(discordAudioPayload.payload.files[0].attachment.toString(), 'audio');

    const interactionEdits = [];
    const interaction = {
      id: 'interaction-1',
      commandName: 'status',
      guildId: '',
      channelId: 'dm-channel',
      channel: { isThread: () => false, name: 'DM' },
      createdTimestamp: Date.now(),
      user: { id: 'user-1', username: 'Alice' },
      isChatInputCommand: () => true,
      async deferReply() {},
      async editReply(payload) { interactionEdits.push(payload); }
    };
    const interactionListener = discordClient.listeners('interactionCreate')[0];
    await interactionListener(interaction);
    const interactionAudio = await discordAdapter.sendAudio(
      createDeliveryTarget({ platform: 'discord', chatType: 'private', conversationId: 'dm-channel' }),
      { buffer: Buffer.from('interaction-audio'), fileName: 'interaction.mp3', mimeType: 'audio/mpeg', format: 'mp3' },
      { replyToMessageId: 'interaction-1' }
    );
    assert.deepStrictEqual(interactionAudio, { status: 'accepted', mode: 'attachment' });
    assert.strictEqual(interactionEdits[0].files[0].name, 'interaction.mp3');

    const qqCalls = [];
    const qqAdapter = createQqAdapter({
      actionClient: {
        async callAction(action, params) {
          qqCalls.push({ action, params });
        },
        getConnectionState: () => ({ connected: true })
      }
    });
    const qqPrivateTarget = createDeliveryTarget({ platform: 'qq', chatType: 'private', conversationId: 'qq-user', externalUserId: 'qq-user' });
    const qqGroupTarget = createDeliveryTarget({ platform: 'qq', chatType: 'group', conversationId: 'qq-group' });
    assert.deepStrictEqual(await qqAdapter.sendAudio(qqPrivateTarget, Buffer.from('private-audio')), { status: 'accepted', mode: 'record' });
    assert.deepStrictEqual(await qqAdapter.sendAudio(qqGroupTarget, Buffer.from('group-audio')), { status: 'accepted', mode: 'record' });
    assert.deepStrictEqual(qqCalls, [
      {
        action: 'send_private_msg',
        params: {
          user_id: 'qq-user',
          message: [{ type: 'record', data: { file: `base64://${Buffer.from('private-audio').toString('base64')}` } }]
        }
      },
      {
        action: 'send_group_msg',
        params: {
          group_id: 'qq-group',
          message: [{ type: 'record', data: { file: `base64://${Buffer.from('group-audio').toString('base64')}` } }]
        }
      }
    ]);

    const offlineQqAdapter = createQqAdapter({
      actionClient: {
        async callAction() {
          const error = new Error('NapCat websocket is not connected');
          error.code = 'NAPCAT_OFFLINE';
          throw error;
        }
      }
    });
    assert.deepStrictEqual(await offlineQqAdapter.sendAudio(qqPrivateTarget, Buffer.from('offline-audio')), {
      status: 'not_submitted',
      mode: 'record'
    });

    const discordListener = discordClient.listeners('messageCreate')[0];
    await assert.doesNotReject(discordListener({
      id: 'discord-inbound',
      createdTimestamp: Date.now(),
      channelId: 'channel-1',
      content: 'hello',
      author: { id: 'user-1', username: 'Alice', bot: false },
      channel: { isThread: () => false },
      mentions: { users: { has: () => false } },
      attachments: new Map()
    }));

    const telegramCalls = [];
    const telegramHandlers = {};
    const telegramBot = {
      async getMe() { return { id: 10, username: 'mizuki_bot' }; },
      async setMyCommands() {},
      on(event, handler) { telegramHandlers[event] = handler; },
      async sendMessage(chatId, text, options) { telegramCalls.push({ type: 'text', chatId, text, options }); },
      async sendPhoto(chatId, image, options) { telegramCalls.push({ type: 'image', chatId, image, options }); },
      async sendChatAction(chatId, action, options) { telegramCalls.push({ type: 'typing', chatId, action, options }); },
      async setMessageReaction(chatId, messageId, options) {
        telegramCalls.push({ type: 'reaction', chatId, messageId, options });
      },
      async stopPolling() {}
    };
    const telegramAdapter = createTelegramAdapter({ enabled: true, token: 'tg-token', bot: telegramBot });
    await telegramAdapter.start({
      onMessage: async () => { throw new Error('telegram route failed'); }
    });
    const telegramTarget = createDeliveryTarget({
      platform: 'telegram',
      chatType: 'group',
      conversationId: '-100',
      threadId: '7'
    });
    await telegramAdapter.sendText(telegramTarget, 'hello', { replyToMessageId: '5' });
    await telegramAdapter.sendImage(telegramTarget, 'image.png');
    await telegramAdapter.setTyping(telegramTarget);
    await telegramAdapter.react(telegramTarget, '6', '👍');
    assert.strictEqual(telegramCalls[0].options.message_thread_id, 7);
    assert.strictEqual(telegramCalls[0].options.reply_to_message_id, 5);
    assert.ok(telegramCalls.some((item) => item.type === 'image'));
    assert.ok(telegramCalls.some((item) => item.type === 'typing'));
    assert.ok(telegramCalls.some((item) => item.type === 'reaction'));

    await assert.doesNotReject(telegramHandlers.message({
      message_id: 8,
      date: 1,
      chat: { id: 9, type: 'private' },
      from: { id: 11, first_name: 'Bob' },
      text: 'hello'
    }));

    const started = [];
    const registry = createPlatformRegistry({ identityStore: {} });
    registry.register({
      platform: 'broken',
      enabled: true,
      async start() { throw new Error('adapter start failed'); },
      markDegraded(error) { started.push(`degraded:${error.message}`); }
    });
    registry.register({
      platform: 'healthy',
      enabled: true,
      async start() { started.push('healthy'); }
    });
    await registry.startEnabled(async () => {});
    assert.deepStrictEqual(new Set(started), new Set(['degraded:adapter start failed', 'healthy']));
    assert.ok(errors.some((entry) => String(entry[0]).includes('telegram')));

    await Promise.all([discordAdapter.stop(), telegramAdapter.stop()]);
    console.log('platformOutboundCapabilities.test.js passed');
  } finally {
    console.error = originalConsoleError;
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
