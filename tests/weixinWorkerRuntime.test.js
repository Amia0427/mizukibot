const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { evaluateInboundMessage } = require('../src/platforms/weixin/inbound');
const { createWeixinWorkerRuntime } = require('../src/platforms/weixin/worker-runtime');

(async () => {
  const binding = {
    accountId: 'bot-1',
    ilinkBotId: 'bot-1',
    ilinkUserId: 'wx-user-1',
    qqUserId: '10001',
    status: 'active',
    baseUrl: 'https://api.example',
    botToken: 'token'
  };
  const cursorWrites = [];
  const auditEvents = [];
  let mediaLoads = 0;
  const rejectionStore = {
    getSyncCursor: () => 'cursor-1',
    setSyncCursor(accountId, cursor) {
      cursorWrites.push({ accountId, cursor });
    },
    appendAudit(event) {
      auditEvents.push(event);
    },
    enqueueInbox() {
      throw new Error('rejected group must not enqueue');
    }
  };
  const rejectionRuntime = createWeixinWorkerRuntime({
    autoRun: false,
    store: rejectionStore,
    evaluateInboundMessage,
    mediaLoader: async () => {
      mediaLoads += 1;
      throw new Error('rejected group must not load media');
    },
    createClient: () => ({
      async getUpdates(input) {
        assert.strictEqual(input.cursor, 'cursor-1');
        return {
          ret: 0,
          get_updates_buf: 'cursor-2',
          msgs: [{
            group_id: 'forbidden-group',
            message_id: 11,
            message_type: 1,
            to_user_id: 'bot-1',
            from_user_id: 'wx-user-1',
            context_token: 'must-not-save',
            item_list: [{ type: 2, image_item: { media: {} } }]
          }]
        };
      },
      async notifyStart() {}
    })
  });
  const rejectedBatch = await rejectionRuntime.pollBindingOnce(binding);
  assert.strictEqual(rejectedBatch.accepted, 0);
  assert.strictEqual(rejectedBatch.rejected, 1);
  assert.strictEqual(mediaLoads, 0);
  assert.strictEqual(auditEvents.length, 1);
  assert.deepStrictEqual(cursorWrites, [{ accountId: 'bot-1', cursor: 'cursor-2' }]);

  const atomicCommits = [];
  const atomicRuntime = createWeixinWorkerRuntime({
    autoRun: false,
    store: {
      getSyncCursor: () => '',
      commitInboundBatch(input) {
        atomicCommits.push(input);
      }
    },
    evaluateInboundMessage,
    mediaLoader: async () => {
      throw new Error('rejected group must not load media');
    },
    createClient: () => ({
      getUpdates: async () => ({
        ret: 0,
        get_updates_buf: 'atomic-cursor',
        msgs: [{ group_id: 'group', message_type: 1 }]
      }),
      notifyStart: async () => {}
    })
  });
  await atomicRuntime.pollBindingOnce(binding);
  assert.strictEqual(atomicCommits.length, 1);
  assert.strictEqual(atomicCommits[0].cursor, 'atomic-cursor');
  assert.deepStrictEqual(atomicCommits[0].operations.map((operation) => operation.type), ['audit']);

  let cursorAdvancedAfterAuditFailure = false;
  const failingAuditRuntime = createWeixinWorkerRuntime({
    autoRun: false,
    store: {
      getSyncCursor: () => '',
      commitInboundBatch() {
        throw new Error('audit transaction failed');
      },
      setSyncCursor() {
        cursorAdvancedAfterAuditFailure = true;
      }
    },
    evaluateInboundMessage,
    mediaLoader: async () => {
      throw new Error('must not load media');
    },
    createClient: () => ({
      getUpdates: async () => ({
        ret: 0,
        get_updates_buf: 'unsafe-cursor',
        msgs: [{ group_id: 'group', message_type: 1 }]
      }),
      notifyStart: async () => {}
    })
  });
  await assert.rejects(failingAuditRuntime.pollBindingOnce(binding), /audit transaction failed/);
  assert.strictEqual(cursorAdvancedAfterAuditFailure, false);

  let staleMediaLoads = 0;
  let staleCommitCalled = false;
  const staleRuntime = createWeixinWorkerRuntime({
    autoRun: false,
    store: {
      getSyncCursor: () => 'old-cursor',
      getWorkerBindingByAccountId: () => null,
      commitInboundBatch() {
        staleCommitCalled = true;
      }
    },
    mediaLoader: async () => {
      staleMediaLoads += 1;
    },
    createClient: () => ({
      getUpdates: async () => ({
        ret: 0,
        get_updates_buf: 'stale-cursor',
        msgs: [{
          message_id: 'stale-message',
          message_type: 1,
          to_user_id: 'bot-1',
          from_user_id: 'wx-user-1',
          item_list: [{ type: 2, image_item: { media: {} } }]
        }]
      }),
      notifyStart: async () => {}
    })
  });
  assert.deepStrictEqual(await staleRuntime.pollBindingOnce(binding), {
    accountId: 'bot-1',
    accepted: 0,
    rejected: 0,
    received: 1,
    cursorAdvanced: false,
    inactive: true
  });
  assert.strictEqual(staleMediaLoads, 0);
  assert.strictEqual(staleCommitCalled, false);

  let bindingChecks = 0;
  let racedMediaLoads = 0;
  const mediaRaceRuntime = createWeixinWorkerRuntime({
    autoRun: false,
    store: {
      getSyncCursor: () => '',
      getWorkerBindingByAccountId: () => (++bindingChecks === 1 ? binding : null),
      commitInboundBatch() {
        throw new Error('inactive binding must not commit');
      }
    },
    mediaLoader: async () => {
      racedMediaLoads += 1;
    },
    createClient: () => ({
      getUpdates: async () => ({
        ret: 0,
        msgs: [{
          message_id: 'media-race',
          message_type: 1,
          to_user_id: 'bot-1',
          from_user_id: 'wx-user-1',
          item_list: [{ type: 2, image_item: { media: {} } }]
        }]
      }),
      notifyStart: async () => {}
    })
  });
  await assert.rejects(
    mediaRaceRuntime.pollBindingOnce(binding),
    (error) => error.code === 'WEIXIN_BINDING_INACTIVE'
  );
  assert.strictEqual(racedMediaLoads, 0);

  const queueCalls = [];
  const sentBodies = [];
  const queueStore = {
    claimInbox: () => [
      { id: 1, attempts: 1, payload: { messageId: 'in-1' } },
      { id: 2, attempts: 1, payload: { messageId: 'in-2' } }
    ],
    completeInbox: (id) => queueCalls.push(['completeInbox', id]),
    failInbox: (id, input) => queueCalls.push(['failInbox', id, input]),
    claimOutbox: () => [
      {
        id: 3,
        attempts: 1,
        accountId: 'bot-1',
        peerId: 'wx-user-1',
        clientId: 'stable-client-id',
        payload: {
          text: 'hello',
          attachments: [{ kind: 'image', path: 'D:\\safe\\reply.png' }]
        }
      }
    ],
    completeOutbox: (id) => queueCalls.push(['completeOutbox', id]),
    failOutbox: (id, input) => queueCalls.push(['failOutbox', id, input]),
    getWorkerBindingByAccountId: () => binding,
    getContextToken: () => 'context-1'
  };
  const queueRuntime = createWeixinWorkerRuntime({
    autoRun: false,
    now: () => 1_000,
    retryBaseMs: 500,
    store: queueStore,
    dispatchInbox: async (payload) => {
      if (payload.messageId === 'in-2') throw new Error('main process unavailable');
    },
    createClient: () => ({
      notifyStart: async () => {},
      async sendMessage(body) {
        sentBodies.push(body);
      }
    }),
    createMediaUploader: () => async (attachment) => {
      assert.strictEqual(attachment.filePath, 'D:\\safe\\reply.png');
      assert.strictEqual(attachment.kind, 'image');
      assert.strictEqual(attachment.toUserId, 'wx-user-1');
      return { messageItem: { type: 2, image_item: { media: {} } } };
    }
  });
  const inboxResult = await queueRuntime.processInboxOnce();
  const outboxResult = await queueRuntime.processOutboxOnce();
  assert.deepStrictEqual(inboxResult, { claimed: 2, completed: 1, failed: 1 });
  assert.deepStrictEqual(outboxResult, { claimed: 1, completed: 1, failed: 0 });
  assert.ok(queueCalls.some((call) => call[0] === 'completeInbox' && call[1] === 1));
  const inboxFailure = queueCalls.find((call) => call[0] === 'failInbox');
  assert.strictEqual(inboxFailure[1], 2);
  assert.strictEqual(inboxFailure[2].retryAt, 1_500);
  assert.strictEqual(sentBodies[0].msg.client_id, 'stable-client-id');
  assert.strictEqual(sentBodies[0].msg.context_token, 'context-1');
  assert.strictEqual(sentBodies[0].msg.to_user_id, 'wx-user-1');
  assert.deepStrictEqual(sentBodies[0].msg.item_list, [
    { type: 1, text_item: { text: 'hello' } },
    { type: 2, image_item: { media: {} } }
  ]);

  const voiceSpoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-weixin-worker-voice-'));
  const voicePath = path.join(voiceSpoolDir, 'request-id-mizuki-voice.mp3');
  fs.writeFileSync(voicePath, 'voice');
  const voiceUploads = [];
  const voiceRuntime = createWeixinWorkerRuntime({
    autoRun: false,
    voiceSpoolDir,
    store: {
      claimOutbox: () => [{
        id: 10,
        attempts: 1,
        accountId: 'bot-1',
        peerId: 'wx-user-1',
        clientId: 'voice-client',
        payload: {
          text: '',
          attachments: [{
            kind: 'voice',
            path: voicePath,
            name: 'mizuki-voice.silk',
            mimeType: 'audio/silk',
            voice: {
              encodeType: 6,
              sampleRate: 16000,
              bitsPerSample: 16,
              playTimeMs: 1200
            },
            cleanupAfterSend: true
          }]
        }
      }],
      getWorkerBindingByAccountId: () => binding,
      getContextToken: () => 'voice-context',
      completeOutbox: (id) => assert.strictEqual(id, 10)
    },
    createClient: () => ({
      notifyStart: async () => {},
      sendMessage: async () => {}
    }),
    createMediaUploader: () => async (input) => {
      voiceUploads.push(input);
      return { messageItem: { type: 3, voice_item: { media: {}, playtime: input.voice.playTimeMs } } };
    }
  });
  assert.deepStrictEqual(await voiceRuntime.processOutboxOnce(), { claimed: 1, completed: 1, failed: 0 });
  assert.strictEqual(voiceUploads[0].kind, 'voice');
  assert.strictEqual(voiceUploads[0].fileName, 'mizuki-voice.silk');
  assert.strictEqual(voiceUploads[0].mimeType, 'audio/silk');
  assert.strictEqual(voiceUploads[0].voice.playTimeMs, 1200);
  assert.strictEqual(fs.existsSync(voicePath), false);
  fs.rmSync(voiceSpoolDir, { recursive: true, force: true });
  assert.strictEqual(sentBodies[0].msg.from_user_id, 'bot-1');

  let forgedSendCalled = false;
  const forgedFailures = [];
  const forgedRuntime = createWeixinWorkerRuntime({
    autoRun: false,
    store: {
      claimOutbox: () => [{
        id: 8,
        attempts: 1,
        accountId: 'bot-1',
        peerId: 'private-stranger',
        clientId: 'forged-client',
        payload: { text: 'must not send' }
      }],
      getWorkerBindingByAccountId: () => binding,
      failOutbox: (id, input) => forgedFailures.push({ id, input })
    },
    createClient: () => ({
      notifyStart: async () => {},
      sendMessage: async () => {
        forgedSendCalled = true;
      }
    })
  });
  assert.deepStrictEqual(await forgedRuntime.processOutboxOnce(), {
    claimed: 1,
    completed: 0,
    failed: 1
  });
  assert.strictEqual(forgedSendCalled, false);
  assert.deepStrictEqual(forgedFailures, [{
    id: 8,
    input: { errorCode: 'weixin_outbox_binding_mismatch' }
  }]);

  const terminalFailures = [];
  const terminalRuntime = createWeixinWorkerRuntime({
    autoRun: false,
    maxAttempts: 3,
    store: {
      claimOutbox: () => [{
        id: 9,
        attempts: 3,
        accountId: 'bot-1',
        peerId: 'wx-user-1',
        clientId: 'stable-terminal',
        payload: { msg: {} }
      }],
      getWorkerBindingByAccountId: () => binding,
      getContextToken: () => null,
      failOutbox: (id, input) => terminalFailures.push({ id, input })
    },
    createClient: () => ({
      notifyStart: async () => {},
      sendMessage: async () => {
        throw new Error('send denied');
      }
    })
  });
  await terminalRuntime.processOutboxOnce();
  assert.deepStrictEqual(terminalFailures, [{
    id: 9,
    input: { errorCode: 'send_denied' }
  }]);

  const lifecycle = [];
  let stoppedClients = 0;
  const lifecycleRuntime = createWeixinWorkerRuntime({
    autoRun: false,
    store: {
      getSyncCursor: () => '',
      setSyncCursor: () => {}
    },
    onState: (state) => lifecycle.push(state.stage),
    createClient: () => ({
      getUpdates: async () => ({ ret: 0, msgs: [], get_updates_buf: '' }),
      notifyStart: async () => {},
      notifyStop: async () => {
        stoppedClients += 1;
      }
    })
  });
  lifecycleRuntime.start();
  await lifecycleRuntime.pollBindingOnce(binding);
  lifecycleRuntime.heartbeat();
  lifecycleRuntime.start();
  assert.deepStrictEqual(lifecycle, ['starting', 'ready', 'heartbeat']);
  await lifecycleRuntime.drainAndStop();
  assert.deepStrictEqual(lifecycle, ['starting', 'ready', 'heartbeat', 'draining', 'stopped']);
  assert.strictEqual(stoppedClients, 1);
  assert.strictEqual(lifecycleRuntime.getState().stage, 'stopped');

  console.log('weixinWorkerRuntime.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
