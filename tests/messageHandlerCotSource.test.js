const assert = require('assert');
const fs = require('fs');
const path = require('path');

module.exports = (() => {
  const filePath = path.join(__dirname, '..', 'core', 'messageHandler.js');
  const source = fs.readFileSync(filePath, 'utf8');

  assert.ok(
    source.includes("/^\\s*\\/cot(?:\\s|$)/i"),
    'messageHandler should recognize the /cot command'
  );
  assert.ok(
    source.includes('const cotArmedState = consumeCotOnce({'),
    'messageHandler should consume the one-shot cot flag on the next accepted conversation turn'
  );
  assert.ok(
    source.includes('cotDisplayOnce: Boolean(cotArmedState)'),
    'messageHandler should propagate cotDisplayOnce into route meta'
  );
  assert.ok(
    source.includes('const persistedReplyText = String(replyEnvelope?.persistedReplyText || replyEnvelope?.replyText || \'\').trim();'),
    'messageHandler should separate persisted reply text from the user-visible reply'
  );

  console.log('messageHandlerCotSource.test.js passed');
})();
