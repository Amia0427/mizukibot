const assert = require('assert');
const { EventEmitter } = require('events');

const { createDeliveryTarget } = require('../src/platforms/contracts');
const { createDiscordAdapter } = require('../src/platforms/discordAdapter');
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
      onMessage: async () => { throw new Error('discord route failed'); }
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
    assert.ok(errors.some((entry) => String(entry[0]).includes('discord')));
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
