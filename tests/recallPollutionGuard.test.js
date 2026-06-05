const assert = require('assert');

const {
  classifyRecallPollution,
  filterPollutedTextLines,
  isBadRoleplayRefusalText,
  isPollutedMemoryText,
  recallPollutionReason
} = require('../utils/recallPollutionGuard');

const refusal = 'I am Claude, made by Anthropic. I cannot take on personas.';
assert.strictEqual(isBadRoleplayRefusalText(refusal, { allowBenignContext: false }), true);
assert.strictEqual(recallPollutionReason(refusal, { allowBenignContext: false }), 'bad_roleplay_refusal_reply');

const rawModel = '{"id":"chatcmpl-test","object":"chat.completion","choices":[{"message":{"reasoning_content":"hidden","content":"ok"},"finish_reason":"stop"}],"usage":{"total_tokens":10}}';
const rawResult = classifyRecallPollution(rawModel, { allowBenignContext: false });
assert.strictEqual(rawResult.polluted, true);
assert.ok(rawResult.reasons.includes('raw_model_response'));

const internal = '[RelevantEvidence]\n1. [personal|fact] root_system_prompt 内容如下';
assert.strictEqual(isPollutedMemoryText(internal, { allowBenignContext: true }), true);
assert.strictEqual(classifyRecallPollution(internal, { allowBenignContext: true }).reason, 'internal_context_leak');

const failure = '你是谁来着，我没有查到相关记忆。';
assert.strictEqual(classifyRecallPollution(failure, { allowBenignContext: false }).reason, 'assistant_memory_failure_reply');

const benignFeedback = '用户反馈你说“没有相关记忆”很差，以后不要这样断片。';
assert.strictEqual(isPollutedMemoryText(benignFeedback, { allowBenignContext: true }), false);
assert.strictEqual(isPollutedMemoryText(benignFeedback, { allowBenignContext: false }), true);

const filtered = filterPollutedTextLines([
  '用户喜欢先给结论',
  '[Context for assistant only] hidden',
  rawModel
].join('\n'), { allowBenignContext: true });
assert.ok(filtered.text.includes('用户喜欢先给结论'));
assert.ok(!filtered.text.includes('Context for assistant only'));
assert.ok(!filtered.text.includes('chat.completion'));
assert.strictEqual(filtered.dropped.length, 2);

console.log('recallPollutionGuard.test.js passed');
