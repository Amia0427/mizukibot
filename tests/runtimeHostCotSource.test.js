const assert = require('assert');
const { applyRuntimeReplyOutput } = require('../api/runtimeV2/host');

module.exports = (() => {
  const options = {};
  const reply = applyRuntimeReplyOutput({
    output: {
      stream: {
        hadOutput: true,
        completed: true,
        fallbackToNonStream: false
      },
      persistedReplyText: ' persisted reply ',
      displayReply: '<think>hidden</think> visible reply ',
      finalReply: 'final reply',
      draftReply: 'draft reply',
      reasoningText: ' explicit reasoning ',
      reasoningForwardText: ' outward reasoning ',
      hasSafetyRestriction: true
    }
  }, options);

  assert.strictEqual(reply, 'visible reply');
  assert.strictEqual(options.persistedReplyText, 'persisted reply');
  assert.strictEqual(options.displayReplyText, '<think>hidden</think> visible reply');
  assert.strictEqual(options.reasoningText, 'explicit reasoning');
  assert.strictEqual(options.reasoningForwardText, 'outward reasoning');
  assert.strictEqual(options.streamHadOutput, true);
  assert.strictEqual(options.streamCompleted, true);
  assert.strictEqual(options.streamFallbackToNonStream, false);
  assert.strictEqual(options.hasSafetyRestriction, true);

  const sanitizedSafetyOptions = {};
  const sanitizedSafetyReply = applyRuntimeReplyOutput({
    output: {
      finalReply: 'restricted /%'
    }
  }, sanitizedSafetyOptions);
  assert.strictEqual(sanitizedSafetyReply, 'restricted');
  assert.strictEqual(sanitizedSafetyOptions.hasSafetyRestriction, true);

  console.log('runtimeHostCotSource.test.js passed');
})();
