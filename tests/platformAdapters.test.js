const assert = require('assert');

const {
  interactionToCommandText,
  normalizeDiscordMessage
} = require('../src/platforms/discordAdapter');
const {
  normalizeTelegramMessage,
  telegramCommandAlias
} = require('../src/platforms/telegramAdapter');

module.exports = (async () => {
  const discord = await normalizeDiscordMessage({
    id: 'm1',
    createdTimestamp: 1000,
    guildId: 'g1',
    channelId: 'thread-1',
    content: '<@bot-1> hello',
    author: { id: 'u1', username: 'alice', bot: false },
    member: { displayName: 'Alice' },
    channel: { isThread: () => true, parentId: 'channel-1', name: 'topic' },
    mentions: { users: { has: (id) => id === 'bot-1' } },
    attachments: new Map([['a', {
      url: 'https://example.com/a.png',
      name: 'a.png',
      contentType: 'image/png',
      size: 10
    }]]),
    reference: { messageId: 'm0' },
    async fetchReference() {
      return {
        id: 'm0',
        content: 'previous',
        author: { id: 'bot-1', username: 'bot' },
        attachments: new Map()
      };
    }
  }, {
    botUserId: 'bot-1',
    passiveChannelIds: new Set(['thread-1'])
  });
  assert.strictEqual(discord.text, 'hello');
  assert.strictEqual(discord.mentionsBot, true);
  assert.strictEqual(discord.conversation.conversationId, 'channel-1');
  assert.strictEqual(discord.conversation.threadId, 'thread-1');
  assert.strictEqual(discord.attachments[0].kind, 'image');
  assert.strictEqual(discord.replyTo.text, 'previous');
  assert.strictEqual(discord.allowPassiveContext, true);

  assert.strictEqual(interactionToCommandText({
    commandName: 'small_theater',
    options: { get: () => ({ value: '雨夜' }) }
  }), '/小剧场 雨夜');

  const telegram = await normalizeTelegramMessage({
    async getFileLink() {
      return 'https://api.telegram.org/file/a.jpg';
    }
  }, {
    message_id: 5,
    date: 2,
    message_thread_id: 7,
    chat: { id: -100, type: 'supergroup', title: 'Group' },
    from: { id: 9, first_name: 'Alice' },
    text: '@mizuki_bot hello',
    photo: [{ file_id: 'small' }, { file_id: 'large', file_size: 20 }],
    reply_to_message: {
      message_id: 4,
      from: { id: 8, first_name: 'Bob' },
      text: 'previous'
    }
  }, {
    botInfo: { id: 10, username: 'mizuki_bot' },
    passiveChatIds: new Set(['-100:7'])
  });
  assert.strictEqual(telegram.text, 'hello');
  assert.strictEqual(telegram.mentionsBot, true);
  assert.strictEqual(telegram.conversation.threadId, '7');
  assert.strictEqual(telegram.attachments[0].url, 'https://api.telegram.org/file/a.jpg');
  assert.strictEqual(telegram.allowPassiveContext, true);
  assert.strictEqual(telegram.allowLongTermGroupMemory, false);
  assert.strictEqual(telegramCommandAlias('/small_theater story'), '/小剧场 story');
  assert.strictEqual(telegramCommandAlias('/group_summary 50'), '/群总结 50');

  console.log('platformAdapters.test.js passed');
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
