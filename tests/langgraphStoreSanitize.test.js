const assert = require('assert');

const {
  compactStableProfileForCheckpoint,
  sanitizeForJson
} = require('../utils/langgraphV2Store');

(() => {
  const shared = ['prompt_injection_attempt'];
  const value = {
    securityLabels: shared,
    promptSegments: {
      securityLabels: shared
    }
  };

  const sanitized = sanitizeForJson(value);
  assert.deepStrictEqual(sanitized.securityLabels, ['prompt_injection_attempt']);
  assert.deepStrictEqual(sanitized.promptSegments.securityLabels, ['prompt_injection_attempt']);

  const compacted = compactStableProfileForCheckpoint({
    text: 'stable text',
    source: 'v3',
    persona: { summary: 'short' },
    profile: { huge: 'x'.repeat(1000) },
    conflicts: Array.from({ length: 25 }, (_, index) => ({ id: `c${index}` })),
    suppressed: Array.from({ length: 31 }, (_, index) => ({ id: `s${index}` })),
    traceItems: Array.from({ length: 22 }, (_, index) => ({ id: `t${index}` }))
  });
  assert.strictEqual(compacted.text, 'stable text');
  assert.strictEqual(compacted.persona.summary, 'short');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(compacted, 'profile'), false);
  assert.strictEqual(compacted.conflicts.length, 20);
  assert.strictEqual(compacted.suppressed.length, 20);
  assert.strictEqual(compacted.traceItems.length, 20);
  assert.deepStrictEqual(compacted.checkpointOriginalCounts, {
    strictItems: 0,
    weakItems: 0,
    traceItems: 22,
    conflicts: 25,
    suppressed: 31,
    expiresSoon: 0
  });
  console.log('langgraphStoreSanitize.test.js passed');
})();
