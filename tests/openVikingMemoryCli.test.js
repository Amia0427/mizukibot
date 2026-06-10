const assert = require('assert');

process.env.OPENVIKING_ENABLED = 'true';
process.env.OPENVIKING_RECALL_ENABLED = 'true';
process.env.OPENVIKING_BASE_URL = 'https://ov.example.test';
process.env.OPENVIKING_API_KEY = 'cli-key';
process.env.OPENVIKING_RECALL_MIN_SCORE = '0.1';
process.env.MEMORY_CLI_SEARCH_ENGINE = 'legacy';

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload)
  };
}

module.exports = (async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/api/v1/system/status')) return jsonResponse({ result: { user: 'cli-space' } });
    if (url.endsWith('/api/v1/search/find')) {
      return jsonResponse({
        result: {
          memories: [
            {
              id: 'ov1',
              uri: 'viking://user/cli-space/memories/events/1',
              text: 'CLI openviking memory hit',
              score: 0.82,
              category: 'event'
            }
          ]
        }
      });
    }
    if (url.includes('/api/v1/content/read?')) return jsonResponse({ result: 'CLI opened content' });
    return jsonResponse({ ok: true });
  };

  try {
    const {
      prepareMemoryCliCommand,
      runMemoryCli
    } = require('../utils/memoryCli');

    const parsed = prepareMemoryCliCommand('mem search --source openviking --query "memory probe" --limit 2');
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.parsed.source, 'openviking');

    const implicitOpen = prepareMemoryCliCommand('mem open ov_ref:viking://user/cli-space/memories/events/1');
    assert.strictEqual(implicitOpen.ok, true);
    assert.strictEqual(implicitOpen.parsed.ref, 'ov_ref:viking://user/cli-space/memories/events/1');
    assert.ok(implicitOpen.repairStrategy.includes('implicit_open_ref'));

    const search = await runMemoryCli('mem search --source openviking --query "memory probe" --limit 2', {
      userId: 'u-cli',
      senderId: 's-cli',
      groupId: 'g-cli',
      sessionKey: 's1'
    });
    assert.strictEqual(search.ok, true);
    assert.strictEqual(search.sourceCoverage.openviking, 1);
    assert.strictEqual(search.results[0].source, 'openviking');
    assert.strictEqual(search.results[0].ref, 'ov_ref:viking://user/cli-space/memories/events/1');

    const opened = await runMemoryCli('mem open ov_ref:viking://user/cli-space/memories/events/1', {
      userId: 'u-cli',
      senderId: 's-cli',
      groupId: 'g-cli'
    });
    assert.strictEqual(opened.ok, true);
    assert.strictEqual(opened.source, 'openviking');
    assert.strictEqual(opened.data.text, 'CLI opened content');
    assert.ok(calls.some((call) => String(call.url).includes('/api/v1/search/find')));
    assert.ok(calls.some((call) => String(call.url).includes('/api/v1/content/read?')));
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('openVikingMemoryCli.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
