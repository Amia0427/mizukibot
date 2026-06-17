const assert = require('assert');

const { createContinuousMessagePreprocessor } = require('../core/continuousMessagePreprocessor');

module.exports = (() => {
  const preprocessor = createContinuousMessagePreprocessor({
    enabled: true,
    debounceMs: 15000,
    groupPlainTextDebounceMs: 2000,
    atBotDebounceMs: 12000,
    privateDebounceMs: 12000,
    maxHoldMs: 25000
  });

  assert.strictEqual(
    preprocessor.getSessionDebounceMs({ messageType: 'private', mentionedBot: false }),
    12000,
    'private chat debounce should be fixed to 12000ms'
  );

  assert.strictEqual(
    preprocessor.getSessionDebounceMs({ messageType: 'private', mentionedBot: true }),
    12000,
    'private chat debounce should stay 12000ms even when the message mentions the bot'
  );

  assert.strictEqual(
    preprocessor.getSessionDebounceMs({ messageType: 'group', mentionedBot: true }),
    12000,
    '@bot group debounce should be 12000ms'
  );

  assert.strictEqual(
    preprocessor.getSessionDebounceMs({ messageType: 'group', mentionedBot: false }),
    2000,
    'regular group plain text debounce should be capped separately from aggregation anchors'
  );

  assert.strictEqual(
    preprocessor.getSessionDebounceMs({ messageType: 'group', mentionedBot: false, hasLongAggregationAnchor: true }),
    15000,
    'regular group image/forward/card debounce should keep the aggregation window'
  );

  console.log('continuousMessagePreprocessorDebounce.test.js passed');
})();
