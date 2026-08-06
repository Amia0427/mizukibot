const assert = require('assert');

const { createWeixinApprovalService } = require('../src/platforms/weixin/approval');
const { createWeixinStore } = require('../src/platforms/weixin/store');

module.exports = (async () => {
  let timestamp = 1_000;
  let sequence = 0;
  const store = createWeixinStore({
    databaseFile: ':memory:',
    masterKey: Buffer.alloc(32, 3).toString('base64'),
    now: () => timestamp
  });
  const calls = [];
  const service = createWeixinApprovalService({
    store,
    now: () => timestamp,
    createTicketId: () => `WX-TEST-${++sequence}`
  });
  const pending = service.request({ type: 'weixin_unbind', qqUserId: '10001' });
  assert.strictEqual(pending.ticketId, 'WX-TEST-1');
  assert.strictEqual((await service.handleCommand('/工具确认 WX-TEST-1', {
    platform: 'weixin', userId: '10001', chatType: 'private'
  })).result.reason, 'platform_mismatch');

  const resumed = createWeixinApprovalService({
    store,
    now: () => timestamp,
    handlers: {
      async weixin_unbind(input) {
        calls.push(input);
        return { ok: true };
      }
    }
  });
  const completed = await resumed.handleCommand('/工具确认 WX-TEST-1', {
    platform: 'qq', userId: '10001', chatType: 'private'
  });
  assert.strictEqual(completed.result.status, 'completed');
  assert.strictEqual(completed.result.executed, true);
  assert.strictEqual(calls[0].qqUserId, '10001');

  const cancellable = service.request({ type: 'weixin_rebind', qqUserId: '10001' });
  const cancelled = await resumed.handleCommand(`/工具取消 ${cancellable.ticketId}`, {
    platform: 'qq', userId: '10001', chatType: 'private'
  });
  assert.strictEqual(cancelled.result.status, 'cancelled');

  timestamp += 11 * 60_000;
  const expired = service.request({ type: 'weixin_unbind', qqUserId: '10001' });
  timestamp = expired.expiresAt + 1;
  const expiredResult = await resumed.confirm(expired.ticketId, {
    platform: 'qq', userId: '10001', chatType: 'private'
  });
  assert.strictEqual(expiredResult.reason, 'expired');

  store.close();
  console.log('weixinApproval.test.js passed');
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
