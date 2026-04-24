const assert = require('assert');

const {
  buildStructuredCompressionPrompt,
  parseStructuredCompressionOutput,
  defaultShortTermState,
  mergeStructuredState
} = require('../utils/shortTermMemory');

const prompt = buildStructuredCompressionPrompt(defaultShortTermState(), 120);
assert.ok(prompt.includes('你是对话短期上下文压缩器'), 'compression prompt should be readable Chinese');
assert.ok(!prompt.includes('浣犳槸'), 'compression prompt should not contain mojibake');

assert.strictEqual(parseStructuredCompressionOutput('{"unexpected":"value"}'), null, 'unknown schema should be rejected');
assert.strictEqual(parseStructuredCompressionOutput('{"summary":123}'), null, 'invalid summary type should be rejected');
assert.strictEqual(parseStructuredCompressionOutput('{"summary":"ok","openLoops":"bad"}'), null, 'invalid array field should be rejected');


console.log('shortTermCompressionSchema.test.js passed');