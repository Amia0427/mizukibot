const assert = require('assert');
const http = require('http');

const { closeServer, waitForServerListening } = require('../utils/serverLifecycle');

module.exports = (async () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  server.listen(0, '127.0.0.1');
  await waitForServerListening(server);
  assert.strictEqual(server.listening, true);
  const closed = await closeServer(server, { timeoutMs: 1000 });
  assert.deepStrictEqual(closed, { closed: true, timedOut: false });
  assert.strictEqual(server.listening, false);

  let forced = 0;
  const stalled = {
    close() {},
    closeAllConnections() {
      forced += 1;
    }
  };
  const timedOut = await closeServer(stalled, { timeoutMs: 10 });
  assert.deepStrictEqual(timedOut, { closed: false, timedOut: true });
  assert.strictEqual(forced, 1);

  console.log('serverLifecycle.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
