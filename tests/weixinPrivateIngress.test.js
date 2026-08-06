const assert = require('assert');

const {
  NO_VOICE_TRANSCRIPT_REPLY,
  evaluateInboundMessage
} = require('../src/platforms/weixin/inbound');

function createHarness() {
  const calls = [];
  const store = {
    appendAudit(event) {
      const storedEvent = { ...event };
      if (storedEvent.senderId) {
        storedEvent.senderHash = `hmac:${storedEvent.senderId.length}`;
        delete storedEvent.senderId;
      }
      calls.push(['appendAudit', storedEvent]);
    },
    enqueueInbox(envelope) {
      calls.push(['enqueueInbox', envelope]);
      return { inserted: true };
    },
    enqueueOutbox(envelope) {
      calls.push(['enqueueOutbox', envelope]);
      return { inserted: true };
    },
    setContextToken(accountId, peerId, token) {
      calls.push(['setContextToken', { accountId, peerId, token }]);
    }
  };
  const mediaLoader = async (item) => {
    calls.push(['mediaLoader', item]);
    return { kind: item.type === 2 ? 'image' : 'file', name: 'media.bin' };
  };
  const binding = {
    accountId: 'account-1',
    qqUserId: '12345',
    ilinkBotId: 'bot-1',
    ilinkUserId: 'wx-user-1'
  };
  return { calls, store, mediaLoader, binding };
}

(async () => {
  const group = createHarness();
  const groupResult = await evaluateInboundMessage({
    group_id: 'wx-group',
    message_id: 1,
    message_type: 1,
    to_user_id: 'bot-1',
    from_user_id: 'wx-user-1',
    context_token: 'must-not-save',
    item_list: [{ type: 2, image_item: {} }]
  }, group.binding, group);
  assert.deepStrictEqual(groupResult, { accepted: false, reason: 'group_message' });
  assert.deepStrictEqual(group.calls.map(([name]) => name), ['appendAudit']);
  assert.strictEqual(JSON.stringify(group.calls).includes('must-not-save'), false);

  const wrongType = createHarness();
  const wrongTypeResult = await evaluateInboundMessage({
    message_id: 2,
    message_type: 2,
    to_user_id: 'bot-1',
    from_user_id: 'wx-user-1',
    item_list: [{ type: 2, image_item: {} }]
  }, wrongType.binding, wrongType);
  assert.deepStrictEqual(wrongTypeResult, { accepted: false, reason: 'not_user_message' });
  assert.deepStrictEqual(wrongType.calls.map(([name]) => name), ['appendAudit']);

  const wrongBot = createHarness();
  const wrongBotResult = await evaluateInboundMessage({
    message_id: 3,
    message_type: 1,
    to_user_id: 'other-bot',
    from_user_id: 'wx-user-1',
    item_list: [{ type: 2, image_item: {} }]
  }, wrongBot.binding, wrongBot);
  assert.deepStrictEqual(wrongBotResult, { accepted: false, reason: 'wrong_bot' });
  assert.deepStrictEqual(wrongBot.calls.map(([name]) => name), ['appendAudit']);

  const stranger = createHarness();
  const strangerResult = await evaluateInboundMessage({
    message_id: 4,
    message_type: 1,
    to_user_id: 'bot-1',
    from_user_id: 'private-stranger-id',
    item_list: [{ type: 2, image_item: {} }]
  }, stranger.binding, stranger);
  assert.deepStrictEqual(strangerResult, { accepted: false, reason: 'unbound_sender' });
  assert.deepStrictEqual(stranger.calls.map(([name]) => name), ['appendAudit']);
  assert.strictEqual(JSON.stringify(stranger.calls).includes('private-stranger-id'), false);
  assert.strictEqual(stranger.calls[0][1].senderHash, 'hmac:19');

  const accepted = createHarness();
  const acceptedResult = await evaluateInboundMessage({
    message_id: 5,
    message_type: 1,
    to_user_id: 'bot-1',
    from_user_id: 'wx-user-1',
    create_time_ms: 1_000,
    session_id: 'session-1',
    context_token: 'ctx-1',
    item_list: [
      { type: 1, text_item: { text: ' hello ' } },
      { type: 2, image_item: { media: {} } },
      { type: 3, voice_item: { text: 'voice transcript', media: { full_url: 'unused' } } },
      { type: 4, file_item: { file_name: 'a.txt', media: {} } },
      { type: 5, video_item: { media: {} } }
    ]
  }, accepted.binding, accepted);

  assert.strictEqual(acceptedResult.accepted, true);
  assert.deepStrictEqual(accepted.calls.map(([name]) => name), [
    'mediaLoader',
    'mediaLoader',
    'enqueueInbox'
  ]);
  const inbox = accepted.calls[2][1];
  const envelope = inbox.payload;
  assert.strictEqual(inbox.contextToken, 'ctx-1');
  assert.strictEqual(JSON.stringify(envelope).includes('ctx-1'), false);
  assert.strictEqual(envelope.platform, 'weixin');
  assert.strictEqual(envelope.canonicalUserId, '12345');
  assert.strictEqual(envelope.platformUserId, 'wx-user-1');
  assert.strictEqual(envelope.accountId, 'account-1');
  assert.strictEqual(envelope.peerId, 'wx-user-1');
  assert.strictEqual(envelope.chatType, 'private');
  assert.strictEqual(envelope.text, 'hello\nvoice transcript');
  assert.strictEqual(envelope.attachments.length, 2);
  assert.deepStrictEqual(envelope.capabilities, ['text', 'image', 'file']);

  const voice = createHarness();
  const voiceResult = await evaluateInboundMessage({
    message_id: 6,
    message_type: 1,
    to_user_id: 'bot-1',
    from_user_id: 'wx-user-1',
    context_token: 'voice-context',
    item_list: [{
      type: 3,
      voice_item: { media: { full_url: 'https://cdn.example/voice' } }
    }]
  }, voice.binding, voice);
  assert.strictEqual(voiceResult.accepted, true);
  assert.deepStrictEqual(voice.calls.map(([name]) => name), ['setContextToken', 'enqueueOutbox']);
  assert.strictEqual(voice.calls[1][1].payload.text, NO_VOICE_TRANSCRIPT_REPLY);
  assert.strictEqual(voiceResult.directReplyText, NO_VOICE_TRANSCRIPT_REPLY);

  const fallback = createHarness();
  const fallbackResult = await evaluateInboundMessage({
    message_type: 1,
    to_user_id: 'bot-1',
    from_user_id: 'wx-user-1',
    create_time_ms: 7_000,
    item_list: [{ type: 1, text_item: { text: 'fallback id' } }]
  }, fallback.binding, fallback);
  assert.match(fallbackResult.envelope.messageId, /^fallback-[a-f0-9]{64}$/);

  console.log('weixinPrivateIngress.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
