const assert = require('assert');

const { createWeixinStore } = require('../src/platforms/weixin/store');
const { parseWeixinCommand } = require('../src/platforms/weixin/commands');
const { createWeixinRuntime } = require('../src/platforms/weixin/runtime');

(async () => {
  assert.deepStrictEqual(parseWeixinCommand('/微信 绑定'), { action: 'bind' });
  assert.deepStrictEqual(parseWeixinCommand('/微信 状态'), { action: 'status' });
  assert.deepStrictEqual(parseWeixinCommand('/微信 换绑'), { action: 'rebind' });
  assert.deepStrictEqual(parseWeixinCommand('/微信 解绑'), { action: 'unbind' });
  assert.deepStrictEqual(parseWeixinCommand('/微信 通知 QQ'), { action: 'notification', platform: 'qq' });
  assert.deepStrictEqual(parseWeixinCommand('/微信 通知 微信'), { action: 'notification', platform: 'weixin' });
  assert.strictEqual(parseWeixinCommand('/微信 开启群聊'), null);

  let timestamp = 1_000;
  let qrRequestCount = 0;
  const qrResponses = [
    { qrcode: 'opaque-qr-1', qrcode_img_content: 'https://qr.example/one' },
    { qrcode: 'opaque-qr-2', qrcode_img_content: 'https://qr.example/two' }
  ];
  const statusResponses = [
    {
      status: 'confirmed',
      bot_token: 'bot-token-1',
      ilink_bot_id: 'bot-1',
      ilink_user_id: 'wx-user-1',
      baseurl: 'https://ilink-one.example'
    },
    {
      status: 'confirmed',
      bot_token: 'bot-token-2',
      ilink_bot_id: 'bot-2',
      ilink_user_id: 'wx-user-2',
      baseurl: 'https://ilink-two.example'
    }
  ];
  const polledQrCodes = [];
  const renderedQrCodes = [];
  const replies = [];
  const approvals = [];
  const notifyStopCalls = [];
  const bindingEvents = [];
  let bindingRemovalError = null;
  let notifyStopHangs = false;
  const attemptIds = ['attempt-1', 'attempt-2'];
  const store = createWeixinStore({
    databaseFile: ':memory:',
    masterKey: Buffer.alloc(32, 6).toString('base64'),
    now: () => timestamp
  });
  const loginClient = {
    async getQrCode() {
      const response = qrResponses[qrRequestCount];
      qrRequestCount += 1;
      return response;
    },
    async getQrCodeStatus(input) {
      polledQrCodes.push(input.qrcode);
      return statusResponses.shift();
    }
  };
  const runtime = createWeixinRuntime({
    store,
    loginClient,
    now: () => timestamp,
    autoPoll: false,
    notifyStopTimeoutMs: 5,
    createAttemptId: () => attemptIds.shift(),
    async renderQrPng(qrCodeUrl) {
      renderedQrCodes.push(qrCodeUrl);
      return Buffer.from(`png:${qrCodeUrl}`);
    },
    async sendReply(context, payload) {
      replies.push({ context, payload });
    },
    approvalService: {
      async request(request) {
        approvals.push(request);
        return { ticketId: `APP-${approvals.length}` };
      }
    },
    async notifyStop(binding) {
      notifyStopCalls.push({
        binding,
        statusDuringCall: store.getBindingByQqUserId(binding.qqUserId)?.status
      });
      if (notifyStopHangs) return new Promise(() => {});
    },
    async onBindingConfirmed(binding, previousBinding) {
      bindingEvents.push(['confirmed', binding.ilinkUserId, previousBinding?.ilinkUserId || '']);
    },
    async onBindingRemoved(binding) {
      if (bindingRemovalError) throw bindingRemovalError;
      bindingEvents.push(['removed', binding.ilinkUserId]);
    }
  });

  const groupContext = {
    text: '/微信 绑定',
    platform: 'qq',
    chatType: 'group',
    userId: '10001',
    groupId: '20001'
  };
  const groupResult = await runtime.handleCommand(groupContext);
  assert.strictEqual(groupResult.handled, true);
  assert.match(groupResult.replyText, /QQ 私聊/);
  assert.strictEqual(qrRequestCount, 0, 'group command must not create QR code');

  const weixinResult = await runtime.handleCommand({
    text: '/微信 绑定',
    platform: 'weixin',
    chatType: 'private',
    userId: '10001'
  });
  assert.strictEqual(weixinResult.handled, true);
  assert.match(weixinResult.replyText, /QQ 私聊/);
  assert.strictEqual(qrRequestCount, 0);

  const qqContext = {
    text: '/微信 绑定',
    platform: 'qq',
    chatType: 'private',
    userId: '10001'
  };
  const bindResult = await runtime.handleCommand(qqContext);
  assert.strictEqual(bindResult.action, 'bind');
  assert.strictEqual(bindResult.attemptId, 'attempt-1');
  assert.strictEqual(qrRequestCount, 1);
  assert.deepStrictEqual(renderedQrCodes, ['https://qr.example/one']);
  assert.ok(Buffer.isBuffer(replies.at(-1).payload.image));
  assert.strictEqual(store.getLoginAttempt('attempt-1').expiresAt, 301_000);
  assert.strictEqual(store.getLoginAttemptForWorker('attempt-1').loginCredential, 'opaque-qr-1');

  const pendingStatus = await runtime.handleCommand({ ...qqContext, text: '/微信 状态' });
  assert.match(pendingStatus.replyText, /尚未绑定/);
  assert.doesNotMatch(pendingStatus.replyText, /opaque|token|ilink-one/);

  const confirmed = await runtime.pollLoginAttempt('attempt-1', qqContext);
  assert.strictEqual(confirmed.status, 'confirmed');
  assert.deepStrictEqual(polledQrCodes, ['opaque-qr-1']);
  assert.strictEqual(store.getLoginAttempt('attempt-1').status, 'confirmed');
  assert.strictEqual(store.getBindingByQqUserId('10001').ilinkBotId, 'bot-1');
  assert.deepStrictEqual(bindingEvents, [['confirmed', 'wx-user-1', '']]);

  const status = await runtime.handleCommand({ ...qqContext, text: '/微信 状态' });
  assert.match(status.replyText, /已绑定/);
  assert.match(status.replyText, /QQ/);
  assert.doesNotMatch(status.replyText, /bot-token-1|ilink-one\.example|opaque-qr-1/);

  const notifyWeixin = await runtime.handleCommand({ ...qqContext, text: '/微信 通知 微信' });
  assert.match(notifyWeixin.replyText, /微信/);
  assert.strictEqual(store.getBindingByQqUserId('10001').notificationPlatform, 'weixin');
  await runtime.handleCommand({ ...qqContext, text: '/微信 通知 QQ' });
  assert.strictEqual(store.getBindingByQqUserId('10001').notificationPlatform, 'qq');

  store.setSyncCursor('bot-1', 'old-cursor');
  store.setContextToken('bot-1', 'wx-user-1', 'old-context');
  store.enqueueInbox({
    accountId: 'bot-1',
    messageId: 'old-inbox',
    qqUserId: '10001',
    peerId: 'wx-user-1',
    payload: { text: 'old inbox' }
  });
  store.enqueueOutbox({
    clientId: 'old-outbox',
    accountId: 'bot-1',
    peerId: 'wx-user-1',
    payload: { text: 'old outbox' }
  });

  const rebind = await runtime.handleCommand({ ...qqContext, text: '/微信 换绑' });
  assert.strictEqual(rebind.ticketId, 'APP-1');
  assert.strictEqual(approvals[0].type, 'weixin_rebind');
  assert.strictEqual(qrRequestCount, 1, 'rebind must wait for approval');
  await approvals[0].execute();
  assert.strictEqual(qrRequestCount, 2);
  assert.strictEqual(store.getBindingByQqUserId('10001').ilinkBotId, 'bot-1');
  assert.strictEqual(store.getLoginAttempt('attempt-2').mode, 'rebind');
  const rebound = await runtime.pollLoginAttempt('attempt-2', qqContext);
  assert.strictEqual(rebound.status, 'confirmed');
  assert.strictEqual(store.getBindingByQqUserId('10001').ilinkBotId, 'bot-2');
  assert.strictEqual(store.getSyncCursor('bot-1'), null);
  assert.strictEqual(store.getContextToken('bot-1', 'wx-user-1'), null);
  assert.deepStrictEqual(store.claimInbox(), []);
  assert.deepStrictEqual(store.claimOutbox(), []);
  assert.deepStrictEqual(bindingEvents, [
    ['confirmed', 'wx-user-1', ''],
    ['confirmed', 'wx-user-2', 'wx-user-1']
  ]);

  bindingRemovalError = new Error('identity database unavailable');
  await assert.rejects(runtime.approvedUnbind(qqContext), /identity database unavailable/);
  bindingRemovalError = null;
  assert.strictEqual(store.getBindingByQqUserId('10001').status, 'active');
  assert.strictEqual(store.getWorkerBindingByQqUserId('10001').botToken, 'bot-token-2');
  assert.strictEqual(notifyStopCalls.length, 1);

  notifyStopHangs = true;
  const unbind = await runtime.handleCommand({ ...qqContext, text: '/微信 解绑' });
  assert.strictEqual(unbind.ticketId, 'APP-2');
  assert.strictEqual(approvals[1].type, 'weixin_unbind');
  assert.ok(store.getBindingByQqUserId('10001'));
  await approvals[1].execute();
  assert.strictEqual(notifyStopCalls.length, 2);
  assert.strictEqual(notifyStopCalls[1].statusDuringCall, 'revoking');
  assert.strictEqual(notifyStopCalls[1].binding.botToken, 'bot-token-2');
  assert.strictEqual(store.getBindingByQqUserId('10001'), null);
  assert.deepStrictEqual(bindingEvents.at(-1), ['removed', 'wx-user-2']);
  assert.match(replies.at(-1).payload.text, /远端停止通知未确认/);

  const noBindingNotification = await runtime.handleCommand({ ...qqContext, text: '/微信 通知 微信' });
  assert.match(noBindingNotification.replyText, /尚未绑定/);

  await runtime.close();
  store.close();

  const rollbackStore = createWeixinStore({
    databaseFile: ':memory:',
    masterKey: Buffer.alloc(32, 8).toString('base64'),
    now: () => 10_000
  });
  rollbackStore.saveBinding({
    qqUserId: '10001',
    ilinkUserId: 'wx-old',
    ilinkBotId: 'bot-old',
    botToken: 'token-old',
    baseUrl: 'https://old.example'
  });
  rollbackStore.setSyncCursor('bot-old', 'cursor-old');
  rollbackStore.setContextToken('bot-old', 'wx-old', 'context-old');
  rollbackStore.enqueueInbox({
    accountId: 'bot-old',
    messageId: 'inbox-old',
    qqUserId: '10001',
    peerId: 'wx-old',
    payload: { text: 'inbox old' }
  });
  rollbackStore.enqueueOutbox({
    clientId: 'outbox-old',
    accountId: 'bot-old',
    peerId: 'wx-old',
    payload: { text: 'outbox old' }
  });
  rollbackStore.beginLoginAttempt({
    attemptId: 'attempt-rollback',
    qqUserId: '10001',
    mode: 'rebind',
    qrCode: 'https://qr.example/rollback',
    loginCredential: 'rollback-secret',
    expiresAt: 20_000
  });
  const rollbackReplies = [];
  const rollbackRuntime = createWeixinRuntime({
    store: rollbackStore,
    autoPoll: false,
    now: () => 10_000,
    loginClient: {
      async getQrCode() {
        throw new Error('unexpected QR request');
      },
      async getQrCodeStatus() {
        return {
          status: 'confirmed',
          bot_token: 'token-new',
          ilink_bot_id: 'bot-new',
          ilink_user_id: 'wx-new',
          baseurl: 'https://new.example'
        };
      }
    },
    async renderQrPng() {
      throw new Error('unexpected QR render');
    },
    approvalService: {
      async request() {
        throw new Error('unexpected approval request');
      }
    },
    async sendReply(_context, payload) {
      rollbackReplies.push(payload.text);
    },
    async notifyStop() {},
    async onBindingConfirmed() {
      throw new Error('identity database unavailable');
    }
  });
  const rollbackResult = await rollbackRuntime.pollLoginAttempt('attempt-rollback', qqContext);
  assert.strictEqual(rollbackResult.status, 'failed');
  assert.strictEqual(rollbackStore.getLoginAttempt('attempt-rollback').status, 'failed');
  assert.deepStrictEqual(rollbackStore.getWorkerBindingByQqUserId('10001'), {
    qqUserId: '10001',
    ilinkUserId: 'wx-old',
    ilinkBotId: 'bot-old',
    accountId: 'bot-old',
    notificationPlatform: 'qq',
    status: 'active',
    createdAt: 10_000,
    updatedAt: 10_000,
    botToken: 'token-old',
    baseUrl: 'https://old.example'
  });
  assert.strictEqual(rollbackStore.getSyncCursor('bot-old'), 'cursor-old');
  assert.strictEqual(rollbackStore.getContextToken('bot-old', 'wx-old'), 'context-old');
  assert.strictEqual(rollbackStore.claimInbox()[0].messageId, 'inbox-old');
  assert.strictEqual(rollbackStore.claimOutbox()[0].clientId, 'outbox-old');
  assert.match(rollbackReplies.at(-1), /失败/);
  await rollbackRuntime.close();
  rollbackStore.close();
  console.log('weixinCommands.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
