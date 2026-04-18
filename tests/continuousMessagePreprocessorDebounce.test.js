const assert = require('assert');

const { createContinuousMessagePreprocessor } = require('../core/continuousMessagePreprocessor');

module.exports = (() => {
  const preprocessor = createContinuousMessagePreprocessor({
    enabled: true,
    debounceMs: 10000,
    atBotDebounceMs: 5000,
    privateDebounceMs: 5000,
    maxHoldMs: 12000
  });

  assert.strictEqual(
    preprocessor.getSessionDebounceMs({ messageType: 'private', mentionedBot: false }),
    5000,
    'private chat debounce should be fixed to 5000ms'
  );

  assert.strictEqual(
    preprocessor.getSessionDebounceMs({ messageType: 'private', mentionedBot: true }),
    5000,
    'private chat debounce should stay 5000ms even when the message mentions the bot'
  );

  assert.strictEqual(
    preprocessor.getSessionDebounceMs({ messageType: 'group', mentionedBot: true }),
    5000,
    '@bot group debounce should be 5000ms'
  );

  assert.strictEqual(
    preprocessor.getSessionDebounceMs({ messageType: 'group', mentionedBot: false }),
    10000,
    'regular group debounce should remain unchanged'
  );

  console.log('continuousMessagePreprocessorDebounce.test.js passed');
})();
