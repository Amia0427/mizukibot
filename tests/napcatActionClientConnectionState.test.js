const assert = require('assert');
const axios = require('axios');

const {
  getActionClientConnectionState,
  getNapCatActionClient,
  isActionClientConnected,
  isNapCatOfflineError
} = require('../api/napcatActionClient');
const { createNapCatHttpActionClient, NapCatActionError } = require('../api/napcatHttpActionClient');

module.exports = (async () => {
  const client = createNapCatHttpActionClient();

  assert.strictEqual(client.isConnected(), true);
  const state = client.getConnectionState();
  assert.strictEqual(state.connected, true);
  assert.strictEqual(state.readyStateName, 'http');

  assert.strictEqual(getNapCatActionClient(), getNapCatActionClient(), 'singleton should be stable');
  assert.strictEqual(isActionClientConnected(client), true);
  assert.strictEqual(getActionClientConnectionState(client).connected, true);

  const originalAxiosPost = axios.post;
  try {
    axios.post = async () => {
      const error = new Error('connect ECONNREFUSED 127.0.0.1:3000');
      error.code = 'ECONNREFUSED';
      throw error;
    };
    await assert.rejects(
      () => client.callAction('get_msg', { message_id: 1 }),
      (error) => {
        assert.ok(error instanceof NapCatActionError);
        assert.strictEqual(error.offline, true);
        assert.strictEqual(error.retryable, true);
        assert.strictEqual(isNapCatOfflineError(error), true);
        return true;
      }
    );

    const offlineState = client.getConnectionState();
    assert.strictEqual(offlineState.connected, false);
    assert.strictEqual(offlineState.readyStateName, 'http_offline');
    assert.strictEqual(isActionClientConnected(client), false);
    assert.strictEqual(getActionClientConnectionState(client).connected, false);

    axios.post = async () => ({
      data: {
        status: 'ok',
        retcode: 0,
        data: { ok: true }
      }
    });
    assert.deepStrictEqual(await client.callAction('get_msg', { message_id: 1 }), { ok: true });
    assert.strictEqual(client.getConnectionState().connected, true);
    assert.strictEqual(client.getConnectionState().readyStateName, 'http');
  } finally {
    axios.post = originalAxiosPost;
  }

  await assert.rejects(
    () => client.callAction(''),
    (error) => {
      assert.ok(error instanceof NapCatActionError);
      assert.strictEqual(error.action, '');
      return true;
    }
  );

  assert.strictEqual(isNapCatOfflineError({ offline: true }), true);
  assert.strictEqual(isNapCatOfflineError(new Error('NapCat action client is not connected')), true);
  assert.strictEqual(isNapCatOfflineError(new Error('unrelated')), false);

  console.log('napcatActionClientConnectionState.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
