const assert = require('assert');

const { extractSSEEvents, mergeUsageObjects } = require('../api/parser');

module.exports = (() => {
  let usage = null;
  let state = { buffer: '' };

  const chunks = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":14,"cache_read_input_tokens":9}}}\n\n',
    'data: {"type":"message_delta","usage":{"output_tokens":5,"cache_creation_input_tokens":2}}\n\n'
  ];

  for (const chunk of chunks) {
    const parsed = extractSSEEvents(state, chunk);
    state = parsed.state;
    for (const event of parsed.events) {
      if (!event?.usage) continue;
      usage = mergeUsageObjects(usage, event.usage);
    }
  }

  assert.ok(usage);
  assert.strictEqual(usage.prompt_tokens, 14);
  assert.strictEqual(usage.completion_tokens, 5);
  assert.strictEqual(usage.cache_read_input_tokens, 9);
  assert.strictEqual(usage.cache_creation_input_tokens, 2);
  assert.strictEqual(usage.total_tokens, 19);

  console.log('parserAnthropicCacheUsage.test.js passed');
})();
