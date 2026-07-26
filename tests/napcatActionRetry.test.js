const assert = require('assert');

const { sendNapCatActionWithRetry } = require('../utils/napcatActionRetry');

module.exports = (async () => {
  let uncertainCalls = 0;
  const uncertainResult = await sendNapCatActionWithRetry({
    actionClient: {
      async callAction() {
        uncertainCalls += 1;
        const error = new Error('response timeout after delivery');
        error.retryable = false;
        throw error;
      }
    },
    payload: { action: 'send_group_msg', params: { group_id: 1, message: 'hello' } },
    retries: 2,
    waitMs: 0,
    logger: { error() {} }
  });
  assert.strictEqual(uncertainResult, false);
  assert.strictEqual(uncertainCalls, 1, 'delivery-uncertain send must not be retried');

  let refusedCalls = 0;
  const refusedResult = await sendNapCatActionWithRetry({
    actionClient: {
      async callAction() {
        refusedCalls += 1;
        if (refusedCalls === 1) {
          const error = new Error('connect refused before delivery');
          error.retryable = true;
          throw error;
        }
      }
    },
    payload: { action: 'send_group_msg', params: { group_id: 1, message: 'hello' } },
    retries: 2,
    waitMs: 0,
    logger: { error() {} }
  });
  assert.strictEqual(refusedResult, true);
  assert.strictEqual(refusedCalls, 2, 'known pre-delivery failure may be retried');
})();
