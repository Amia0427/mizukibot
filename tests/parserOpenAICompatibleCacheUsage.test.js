const assert = require('assert');

const { extractSSEEvents, mergeUsageObjects } = require('../api/parser');

module.exports = (() => {
  const parsed = extractSSEEvents(
    { buffer: '' },
    'data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":8,"cache_write_tokens":3}}}\n\n'
  );
  assert.strictEqual(parsed.events.length, 1);
  const usage = parsed.events[0].usage;
  assert.ok(usage);
  assert.strictEqual(usage.prompt_tokens, 10);
  assert.strictEqual(usage.completion_tokens, 2);
  assert.strictEqual(usage.cache_read_input_tokens, 8);
  assert.strictEqual(usage.cache_creation_input_tokens, 3);

  const merged = mergeUsageObjects(
    { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    { cache_read_input_tokens: 8, cache_creation_input_tokens: 3 }
  );
  assert.strictEqual(merged.cache_read_input_tokens, 8);
  assert.strictEqual(merged.cache_creation_input_tokens, 3);

  const deepSeekStyle = extractSSEEvents(
    { buffer: '' },
    'data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":20,"completion_tokens":4,"prompt_cache_hit_tokens":12,"prompt_cache_miss_tokens":8}}\n\n'
  );
  assert.strictEqual(deepSeekStyle.events.length, 1);
  assert.strictEqual(deepSeekStyle.events[0].usage.cache_read_input_tokens, 12);
  assert.strictEqual(deepSeekStyle.events[0].usage.cache_creation_input_tokens, 8);

  console.log('parserOpenAICompatibleCacheUsage.test.js passed');
})();
