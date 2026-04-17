const assert = require('assert');

const { sanitizeForJson } = require('../utils/langgraphV2Store');

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
  console.log('langgraphStoreSanitize.test.js passed');
})();
