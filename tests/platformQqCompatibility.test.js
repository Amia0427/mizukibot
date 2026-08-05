const assert = require('assert');

const { mergeQqLegacyMessage } = require('../src/platforms/qqAdapter');

(() => {
  const merged = mergeQqLegacyMessage({
    message_id: 10,
    raw_message: 'original',
    message: [{ type: 'text', data: { text: 'original' } }],
    user_id: 200
  }, {
    message_id: '10',
    raw_message: 'normalized',
    message: [],
    user_id: 'principal-1',
    platform: 'qq'
  });
  assert.strictEqual(merged.message_id, 10);
  assert.strictEqual(merged.raw_message, 'original');
  assert.strictEqual(merged.user_id, 'principal-1');

  console.log('platformQqCompatibility.test.js passed');
})();
