const assert = require('assert');

const { OpenVikingClient } = require('../utils/openVikingMemory/client');

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload)
  };
}

module.exports = (async () => {
  const calls = [];
  const client = new OpenVikingClient({
    baseUrl: 'https://ov.example.test/',
    apiKey: 'runtime-key',
    accountId: 'acct1',
    agentId: 'agent1',
    timeoutMs: 500,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.endsWith('/health')) return jsonResponse({ ok: true });
      if (url.endsWith('/api/v1/sessions/session%2F1/messages')) return jsonResponse({ ok: true });
      if (url.endsWith('/api/v1/sessions/session%2F1/commit')) return jsonResponse({ result: { committed: true } });
      if (url.endsWith('/api/v1/search/find')) {
        return jsonResponse({ result: { memories: [{ id: 'm1', text: 'remembered', score: 0.9 }] } });
      }
      if (url.includes('/api/v1/content/read?')) return jsonResponse({ result: 'full content' });
      return jsonResponse({ error: 'missing' }, 404);
    }
  });

  assert.strictEqual(await client.health({ userId: 'ov-user' }), true);
  assert.strictEqual(await client.addMessage('session/1', { role: 'user', content: 'hello' }, { userId: 'ov-user' }), true);
  assert.deepStrictEqual(await client.commitSession('session/1', { userId: 'ov-user' }), { committed: true });
  assert.deepStrictEqual(
    await client.find({ query: 'hello', limit: 3, scoreThreshold: 0.4, targetUri: 'viking://user/default/memories', sessionId: 'session/1' }, { userId: 'ov-user' }),
    [{ id: 'm1', text: 'remembered', score: 0.9 }]
  );
  assert.strictEqual(await client.readContent('viking://user/default/memories/events/1', { userId: 'ov-user' }), 'full content');

  assert.strictEqual(calls[0].url, 'https://ov.example.test/health');
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer runtime-key');
  assert.strictEqual(calls[0].init.headers['X-OpenViking-User'], 'ov-user');
  assert.strictEqual(calls[0].init.headers['X-OpenViking-Account'], 'acct1');
  assert.strictEqual(calls[0].init.headers['X-OpenViking-Agent'], 'agent1');
  assert.deepStrictEqual(JSON.parse(calls[1].init.body), { role: 'user', content: 'hello' });
  assert.deepStrictEqual(JSON.parse(calls[3].init.body), {
    query: 'hello',
    limit: 3,
    score_threshold: 0.4,
    target_uri: 'viking://user/default/memories',
    session_id: 'session/1'
  });

  const failingClient = new OpenVikingClient({
    baseUrl: 'https://ov.example.test',
    fetchImpl: async () => jsonResponse({ error: 'down' }, 503)
  });
  assert.strictEqual(await failingClient.health(), false);

  const timeoutClient = new OpenVikingClient({
    baseUrl: 'https://ov.example.test',
    timeoutMs: 100,
    fetchImpl: (_url, init = {}) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    })
  });
  assert.strictEqual(await timeoutClient.health(), false);

  console.log('openVikingClient.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
