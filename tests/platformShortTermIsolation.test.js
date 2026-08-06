const assert = require('assert');

process.env.SHORT_TERM_SESSION_SCOPE_ENABLED = 'true';

const { resolveShortTermSessionKey } = require('../utils/shortTermMemory');

(() => {
  assert.strictEqual(
    resolveShortTermSessionKey('10001', { groupId: '12345', platform: 'qq', chatType: 'group' }),
    'qq-group:12345:user:10001'
  );
  assert.strictEqual(
    resolveShortTermSessionKey('10001', { platform: 'qq', chatType: 'private' }),
    'direct:10001'
  );
  assert.strictEqual(
    resolveShortTermSessionKey('10001', {
      platform: 'weixin',
      chatType: 'private',
      conversationKey: 'weixin:private:bot-1:wx-user-1:'
    }),
    'direct:10001'
  );

  const discordPrivate = resolveShortTermSessionKey('10001', {
    platform: 'discord',
    chatType: 'private',
    conversationKey: 'discord:private::user-84:'
  });
  const telegramPrivate = resolveShortTermSessionKey('10001', {
    platform: 'telegram',
    chatType: 'private',
    conversationKey: 'telegram:private::42:'
  });
  assert.strictEqual(discordPrivate, 'discord-private:discord:private::user-84::user:10001');
  assert.strictEqual(telegramPrivate, 'telegram-private:telegram:private::42::user:10001');
  assert.notStrictEqual(discordPrivate, telegramPrivate);

  const discordThreadA = resolveShortTermSessionKey('10001', {
    platform: 'discord',
    chatType: 'group',
    conversationKey: 'discord:group:guild:channel:thread-a'
  });
  const discordThreadB = resolveShortTermSessionKey('10001', {
    platform: 'discord',
    chatType: 'group',
    conversationKey: 'discord:group:guild:channel:thread-b'
  });
  assert.notStrictEqual(discordThreadA, discordThreadB);
  console.log('platformShortTermIsolation.test.js passed');
})();
