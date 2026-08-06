const assert = require('assert');

const {
  PLATFORM_NAMES,
  createConversationKey,
  createInboundMessage,
  parseConversationKey,
  toLegacyMessage
} = require('../src/platforms/contracts');
const { normalizeQqMessage } = require('../src/platforms/qqAdapter');

(() => {
  const discordKey = createConversationKey({
    platform: 'discord',
    chatType: 'group',
    containerId: 'guild-1',
    conversationId: 'channel-1',
    threadId: 'thread-1'
  });
  assert.deepStrictEqual(parseConversationKey(discordKey), {
    platform: 'discord',
    chatType: 'group',
    conversationId: 'channel-1',
    containerId: 'guild-1',
    threadId: 'thread-1',
    externalUserId: '',
    key: discordKey
  });

  const inbound = createInboundMessage({
    platform: 'telegram',
    eventId: '42',
    occurredAt: 1000,
    actor: { externalId: '9', personId: 'person-1', displayName: 'Alice' },
    conversation: { chatType: 'group', conversationId: '-100', threadId: '7' },
    text: 'hello',
    attachments: [{ kind: 'image', url: 'https://example.com/a.png' }],
    replyTo: { messageId: '41', text: 'previous' },
    mentionsBot: true,
    botExternalId: 'bot-1',
    allowPassiveContext: true,
    allowLongTermGroupMemory: false
  });
  const legacy = toLegacyMessage(inbound);
  assert.strictEqual(legacy.user_id, 'person-1');
  assert.strictEqual(legacy.platform, 'telegram');
  assert.strictEqual(legacy.message_type, 'group');
  assert.ok(legacy.group_id.startsWith('telegram:group:'));
  assert.strictEqual(legacy.message.filter((item) => item.type === 'image').length, 1);
  assert.strictEqual(legacy.allow_long_term_group_memory, false);

  const fileBuffer = Buffer.from('shared file content', 'utf8');
  const weixin = createInboundMessage({
    platform: 'weixin',
    eventId: 'wx-1',
    actor: { externalId: 'wx-user-1', personId: '12345' },
    conversation: { chatType: 'private', conversationId: 'wx-user-1' },
    attachments: [{
      kind: 'file',
      name: 'note.txt',
      mimeType: 'text/plain',
      size: fileBuffer.length,
      sha256: 'digest-1',
      buffer: fileBuffer,
      text: 'shared file content',
      binary: false,
      truncated: false
    }]
  });
  const weixinLegacy = toLegacyMessage(weixin);
  assert.strictEqual(PLATFORM_NAMES.has('weixin'), true);
  assert.strictEqual(weixinLegacy.attachments.length, 1);
  assert.strictEqual(weixinLegacy.attachments[0].name, 'note.txt');
  assert.strictEqual(weixinLegacy.attachments[0].text, 'shared file content');
  assert.strictEqual(weixinLegacy.attachments[0].buffer, fileBuffer);

  const qq = normalizeQqMessage({
    post_type: 'message',
    message_type: 'group',
    message_id: 10,
    self_id: 100,
    user_id: 200,
    group_id: 300,
    time: 10,
    raw_message: '[CQ:at,qq=100] hi [CQ:image,url=https://example.com/q.png]',
    message: [
      { type: 'at', data: { qq: '100' } },
      { type: 'text', data: { text: ' hi ' } },
      { type: 'image', data: { url: 'https://example.com/q.png' } }
    ],
    sender: { nickname: 'Bob' }
  });
  assert.strictEqual(qq.conversation.key, '300');
  assert.strictEqual(qq.text, 'hi');
  assert.strictEqual(qq.mentionsBot, true);
  assert.strictEqual(qq.attachments.length, 1);

  console.log('platformContracts.test.js passed');
})();
