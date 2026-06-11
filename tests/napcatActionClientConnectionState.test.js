const assert = require('assert');

const {
  createNapCatActionClient,
  isNapCatOfflineError
} = require('../api/napcatActionClient');

function createWs(readyState = 1) {
  return {
    readyState,
    send() {}
  };
}

module.exports = (async () => {
  const client = createNapCatActionClient({ timeoutMs: 1000 });

  assert.strictEqual(client.isConnected(), false);
  assert.strictEqual(client.getConnectionState().connected, false);
  await assert.rejects(
    () => client.callAction('get_msg', { message_id: 1 }),
    (error) => {
      assert.strictEqual(error.offline, true);
      assert.strictEqual(error.retryable, true);
      assert.strictEqual(isNapCatOfflineError(error), true);
      return true;
    }
  );

  client.setWebSocket(createWs(1));
  client.handleConnect();
  assert.strictEqual(client.isConnected(), true);
  assert.strictEqual(client.getConnectionState().connected, true);

  client.setWebSocket(createWs(3));
  client.handleDisconnect('NapCat websocket closed');
  assert.strictEqual(client.isConnected(), false);
  const state = client.getConnectionState();
  assert.strictEqual(state.connected, false);
  assert.strictEqual(state.readyStateName, 'closed');

  console.log('napcatActionClientConnectionState.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
