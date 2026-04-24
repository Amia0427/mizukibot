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
  const queued = foreground.acquire({ userId: 'u2', sessionKey: 'u2', lane: 'general', messageId: 'm2' });
  await assert.rejects(
    foreground.acquire({ userId: 'u3', sessionKey: 'u3', lane: 'general', messageId: 'm3' }),
    /queue is full/
  );
  await assert.rejects(queued, /timed out/);
  lock.release();

  const inbound = createInboundConcurrencyController({
    globalLimit: 1,
    generalLimit: 1,
    adminLimit: 0,
    perUserLimit: 1,
    maxQueueLength: 2,
    queueTimeoutMs: 0
  });
  const first = await inbound.acquire({ userId: 'same', sessionKey: 'same', lane: 'general', messageId: 'a' });
  const sameSessionQueued = inbound.acquire({ userId: 'same', sessionKey: 'same', lane: 'general', messageId: 'b' });
  const otherSessionQueued = inbound.acquire({ userId: 'other', sessionKey: 'other', lane: 'general', messageId: 'c' });
  first.release();
  const other = await otherSessionQueued;
  assert.strictEqual(other.requestId.includes('other'), true, 'fair queue should let another eligible session run first');
  other.release();
  const same = await sameSessionQueued;
  same.release();

  console.log('concurrencyBackpressure.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
