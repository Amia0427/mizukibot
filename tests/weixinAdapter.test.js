const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createWeixinAdapter } = require('../src/platforms/weixin/adapter');

module.exports = (async () => {
  const calls = [];
  const voiceSpoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-weixin-voice-'));
  const binding = {
    accountId: 'bot-1',
    ilinkBotId: 'bot-1',
    ilinkUserId: 'wx-user-1',
    qqUserId: '10001',
    status: 'active'
  };
  let inboxItems = [{
    id: 1,
    attempts: 1,
    accountId: 'bot-1',
    peerId: 'wx-user-1',
    qqUserId: '10001',
    payload: {
      messageId: 'wx-message-1',
      canonicalUserId: '10001',
      platformUserId: 'wx-user-1',
      accountId: 'bot-1',
      peerId: 'wx-user-1',
      chatType: 'private',
      text: 'hello',
      attachments: [{ kind: 'file', name: 'note.txt', text: 'content', buffer: Buffer.from('content') }],
      occurredAt: 1_000,
      capabilities: ['text', 'file']
    }
  }];
  const store = {
    getBindingByAccountId(accountId) {
      return accountId === binding.accountId ? binding : null;
    },
    claimInbox() {
      const claimed = inboxItems;
      inboxItems = [];
      return claimed;
    },
    completeInbox(id) {
      calls.push(['completeInbox', id]);
      return true;
    },
    failInbox(id, input) {
      calls.push(['failInbox', id, input]);
      return true;
    },
    enqueueOutbox(input) {
      calls.push(['enqueueOutbox', input]);
      return { inserted: true, item: input };
    },
    appendAudit(input) {
      calls.push(['appendAudit', input]);
    }
  };
  const adapter = createWeixinAdapter({
    enabled: true,
    store,
    createClientId: () => 'client-1',
    voiceSpoolDir,
    now: () => 2_000
  });

  const received = [];
  assert.deepStrictEqual(await adapter.processInboxOnce(async (message) => received.push(message)), {
    claimed: 1,
    completed: 1,
    failed: 0,
    rejected: 0
  });
  assert.strictEqual(received[0].platform, 'weixin');
  assert.strictEqual(received[0].actor.externalId, 'wx-user-1');
  assert.strictEqual(received[0].actor.personId, '10001');
  assert.strictEqual(received[0].conversation.chatType, 'private');
  assert.strictEqual(received[0].deliveryTarget.containerId, 'bot-1');
  assert.strictEqual(received[0].attachments[0].text, 'content');
  assert.deepStrictEqual(calls.shift(), ['completeInbox', 1]);

  const target = {
    platform: 'weixin',
    chatType: 'private',
    containerId: 'bot-1',
    conversationId: 'wx-user-1',
    externalUserId: 'wx-user-1'
  };
  assert.strictEqual(await adapter.validateTarget(target), true);
  assert.strictEqual(await adapter.validateTarget({
    ...target,
    context: { personId: 'other-qq-user' }
  }), false);
  assert.strictEqual(await adapter.sendText(target, 'reply'), true);
  assert.deepStrictEqual(calls.shift(), ['enqueueOutbox', {
    clientId: 'client-1',
    accountId: 'bot-1',
    peerId: 'wx-user-1',
    payload: { text: 'reply', attachments: [] }
  }]);

  assert.deepStrictEqual(await adapter.sendAudio(target, {
    buffer: Buffer.from('voice-bytes'),
    mimeType: 'audio/mpeg',
    format: 'mp3',
    fileName: 'mizuki-voice.mp3'
  }), { status: 'accepted', mode: 'file' });
  const voiceQueueCall = calls.shift();
  assert.strictEqual(voiceQueueCall[0], 'enqueueOutbox');
  assert.strictEqual(voiceQueueCall[1].payload.attachments[0].name, 'mizuki-voice.mp3');
  assert.strictEqual(voiceQueueCall[1].payload.attachments[0].mimeType, 'audio/mpeg');
  assert.strictEqual(voiceQueueCall[1].payload.attachments[0].cleanupAfterSend, true);
  assert.strictEqual(fs.existsSync(voiceQueueCall[1].payload.attachments[0].path), true);

  const nativeVoiceSpoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-weixin-native-voice-'));
  const nativeCalls = [];
  let nativeClientIdCalls = 0;
  const nativeAdapter = createWeixinAdapter({
    enabled: true,
    store: {
      getBindingByAccountId: () => binding,
      enqueueOutbox(input) {
        nativeCalls.push(input);
        return { inserted: true, item: input };
      }
    },
    createClientId: () => {
      nativeClientIdCalls += 1;
      return 'native-client';
    },
    voiceSpoolDir: nativeVoiceSpoolDir,
    nativeVoiceEnabled: true,
    nativeVoiceEncoder: async (input) => {
      assert.strictEqual(fs.existsSync(input.inputPath), true);
      fs.writeFileSync(input.outputPath, 'silk-bytes');
      return {
        filePath: input.outputPath,
        fileName: input.fileName,
        mimeType: 'audio/silk',
        encodeType: 6,
        sampleRate: 16000,
        bitsPerSample: 16,
        playTimeMs: 1200
      };
    }
  });
  assert.deepStrictEqual(await nativeAdapter.sendAudio(target, {
    buffer: Buffer.from('native-voice'),
    mimeType: 'audio/mpeg',
    fileName: 'mizuki-voice.mp3'
  }), { status: 'accepted', mode: 'file' });
  assert.strictEqual(nativeClientIdCalls, 2);
  assert.strictEqual(nativeCalls[0].payload.attachments[0].kind, 'voice');
  assert.strictEqual(nativeCalls[0].payload.attachments[0].mimeType, 'audio/silk');
  assert.deepStrictEqual(nativeCalls[0].payload.attachments[0].voice, {
    encodeType: 6,
    sampleRate: 16000,
    bitsPerSample: 16,
    playTimeMs: 1200
  });

  const fallbackVoiceSpoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-weixin-native-fallback-'));
  const fallbackCalls = [];
  const fallbackAdapter = createWeixinAdapter({
    enabled: true,
    store: {
      getBindingByAccountId: () => binding,
      enqueueOutbox(input) {
        fallbackCalls.push(input);
        return { inserted: true, item: input };
      }
    },
    createClientId: () => 'fallback-client',
    voiceSpoolDir: fallbackVoiceSpoolDir,
    nativeVoiceEnabled: true,
    nativeVoiceEncoder: async () => {
      throw new Error('native encoder unavailable');
    }
  });
  await fallbackAdapter.sendAudio(target, {
    buffer: Buffer.from('fallback-voice'),
    mimeType: 'audio/mpeg',
    fileName: 'fallback.mp3'
  });
  assert.strictEqual(fallbackCalls[0].payload.attachments[0].kind, 'file');
  assert.strictEqual(fallbackCalls[0].payload.attachments[0].mimeType, 'audio/mpeg');
  assert.strictEqual(fs.existsSync(fallbackCalls[0].payload.attachments[0].path), true);

  assert.strictEqual(await adapter.sendText({ ...target, chatType: 'group' }, 'blocked'), false);
  assert.strictEqual(await adapter.sendText({ ...target, conversationId: 'stranger', externalUserId: 'stranger' }, 'blocked'), false);
  assert.strictEqual(calls.length, 0, 'forged targets must not reach outbox');

  inboxItems = [{
    id: 2,
    attempts: 1,
    accountId: 'bot-1',
    peerId: 'stranger',
    qqUserId: '10001',
    payload: {
      messageId: 'forged',
      canonicalUserId: '10001',
      platformUserId: 'stranger',
      accountId: 'bot-1',
      peerId: 'stranger',
      chatType: 'private'
    }
  }];
  assert.deepStrictEqual(await adapter.processInboxOnce(async () => {
    throw new Error('forged inbox must not dispatch');
  }), {
    claimed: 1,
    completed: 1,
    failed: 0,
    rejected: 1
  });
  assert.strictEqual(calls[0][0], 'appendAudit');
  assert.strictEqual(calls[0][1].reason, 'inbox_binding_mismatch');
  assert.deepStrictEqual(calls[1], ['completeInbox', 2]);
  fs.rmSync(voiceSpoolDir, { recursive: true, force: true });
  fs.rmSync(nativeVoiceSpoolDir, { recursive: true, force: true });
  fs.rmSync(fallbackVoiceSpoolDir, { recursive: true, force: true });

  console.log('weixinAdapter.test.js passed');
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
