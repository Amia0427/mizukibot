const assert = require('assert');

const { sendGroupPoke, sendPrivatePoke } = require('../api/qqActionService');

module.exports = (async () => {
  const calls = [];
  const result = await sendPrivatePoke('1960901788', {
    actionClient: {
      async callAction(action, params) {
        calls.push({ action, params });
        return {};
      }
    }
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].action, 'friend_poke');
  assert.deepStrictEqual(calls[0].params, { user_id: '1960901788' });

  const groupPokeResult = await sendGroupPoke('123456', '1960901788', {
    actionClient: {
      async callAction(action, params) {
        calls.push({ action, params });
        return {};
      }
    }
  });

  assert.strictEqual(groupPokeResult.success, true);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].action, 'group_poke');
  assert.deepStrictEqual(calls[1].params, {
    group_id: '123456',
    user_id: '1960901788'
  });

  console.log('qqActionServicePrivatePoke.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
