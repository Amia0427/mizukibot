const assert = require('assert');

const { createForegroundConcurrencyController } = require('../core/foregroundConcurrency');
const { createInboundConcurrencyController } = require('../core/inboundConcurrency');

module.exports = (async () => {
  const foreground = createForegroundConcurrencyController({
    globalLimit: 1,
    adminReservedSlots: 0,
    perUserLimit: 1,
    maxQueueLength: 1,
    queueTimeoutMs: 25
  });
  const lock = await foreground.acquire({ userId: 'u1', sessionKey: 'u1', lane: 'general', messageId: 'm1' });
  const queued = [
    foreground.acquire({ userId: 'u2', sessionKey: 'u2', lane: 'general', messageId: 'm2' }),
    foreground.acquire({ userId: 'u3', sessionKey: 'u3', lane: 'general', messageId: 'm3' })
  ];
  await new Promise((resolve) => setTimeout(resolve, 40));
  lock.release();
  const secondLock = await queued[0];
  secondLock.release();
  const thirdLock = await queued[1];
  thirdLock.release();
  assert.strictEqual(foreground.getSnapshot().queuedTotal, 2);
  assert.strictEqual(foreground.getSnapshot().acquiredTotal, 3);
  assert.strictEqual(foreground.getSnapshot().releasedTotal, 3);
  assert.strictEqual(foreground.getSnapshot().peakQueued, 2);
  assert.ok(foreground.getSnapshot().maxWaitMs >= 25);

  const inbound = createInboundConcurrencyController({
    globalLimit: 1,
    generalLimit: 1,
    adminLimit: 0,
    perUserLimit: 1,
    maxQueueLength: 2,
    queueTimeoutMs: 25
  });
  const first = await inbound.acquire({ userId: 'same', sessionKey: 'same', lane: 'general', messageId: 'a' });
  const queuedInbound = [
    inbound.acquire({ userId: 'same', sessionKey: 'same', lane: 'general', messageId: 'b' }),
    inbound.acquire({ userId: 'other', sessionKey: 'other', lane: 'general', messageId: 'c' }),
    inbound.acquire({ userId: 'third', sessionKey: 'third', lane: 'general', messageId: 'd' })
  ];
  await new Promise((resolve) => setTimeout(resolve, 40));
  first.release();
  const other = await queuedInbound[1];
  assert.strictEqual(other.requestId.includes('other'), true, 'fair queue should let another eligible session run first');
  other.release();
  const same = await queuedInbound[0];
  same.release();
  const third = await queuedInbound[2];
  third.release();
  assert.strictEqual(inbound.getSnapshot().queuedTotal, 3);
  assert.strictEqual(inbound.getSnapshot().acquiredTotal, 4);
  assert.strictEqual(inbound.getSnapshot().releasedTotal, 4);
  assert.strictEqual(inbound.getSnapshot().peakQueued, 3);
  assert.ok(inbound.getSnapshot().maxWaitMs >= 25);

  const adminInbound = createInboundConcurrencyController({
    globalLimit: 2,
    generalLimit: 0,
    adminLimit: 2,
    perUserLimit: 1,
    maxQueueLength: 0,
    queueTimeoutMs: 0
  });
  const slowAdmin = await adminInbound.acquire({
    userId: 'admin',
    sessionKey: 'qq-group:g:user:admin',
    lane: 'admin',
    messageId: 'slow'
  });
  const fastAdmin = await adminInbound.acquire({
    userId: 'admin',
    sessionKey: 'qq-group:g:user:admin',
    lane: 'admin',
    messageId: 'check',
    ignoreSessionLimit: true
  });
  assert.ok(fastAdmin, 'admin fast command should bypass same-session inbound limit');
  assert.strictEqual(adminInbound.getSnapshot().activeAdmin, 2);
  fastAdmin.release();
  slowAdmin.release();

  console.log('concurrencyBackpressure.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
