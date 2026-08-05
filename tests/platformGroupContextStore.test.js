const assert = require('assert');

const { createInboundMessage } = require('../src/platforms/contracts');
const { createPlatformGroupContextStore } = require('../src/platforms/groupContextStore');

(() => {
  let timestamp = 10_000;
  const store = createPlatformGroupContextStore({
    databaseFile: ':memory:',
    now: () => timestamp,
    retentionMs: 60_000,
    maxMessages: 20
  });

  try {
    for (let index = 0; index < 25; index += 1) {
      store.append(createInboundMessage({
        platform: 'telegram',
        eventId: String(index),
        occurredAt: timestamp + index,
        actor: { externalId: 'u1', personId: 'person-1', displayName: 'Alice' },
        conversation: { chatType: 'group', conversationId: '-100' },
        text: `message-${index}`,
        allowPassiveContext: true,
        allowLongTermGroupMemory: false
      }));
    }
    const key = 'telegram:group::-100:';
    const recent = store.list(key);
    assert.strictEqual(recent.length, 20);
    assert.strictEqual(recent[0].text, 'message-5');
    assert.strictEqual(recent[19].text, 'message-24');

    timestamp += 61_000;
    assert.deepStrictEqual(store.list(key), []);
  } finally {
    store.close();
  }

  console.log('platformGroupContextStore.test.js passed');
})();
