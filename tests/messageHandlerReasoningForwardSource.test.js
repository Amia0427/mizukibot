const assert = require('assert');
const fs = require('fs');
const path = require('path');

module.exports = (() => {
  const imports = fs.readFileSync(path.join(__dirname, '..', 'core', 'messageHandler.imports.chunk.js'), 'utf8');
  const runtime02 = fs.readFileSync(path.join(__dirname, '..', 'core', 'messageHandler.runtime-02.chunk.js'), 'utf8');
  const runtime06 = fs.readFileSync(path.join(__dirname, '..', 'core', 'messageHandler.runtime-06.chunk.js'), 'utf8');

  assert.ok(imports.includes('sendReasoningForwardMessage'), 'message handler should import reasoning forward sender');
  assert.ok(runtime02.includes('async function maybeSendReasoningForward'), 'message handler should wrap reasoning forward sending');
  assert.ok(runtime02.includes('replyEnvelope?.reasoningText'), 'reasoning forward wrapper should read only envelope reasoning');
  assert.ok(runtime06.includes('await maybeSendReasoningForward(replyEnvelope'), 'final send path should trigger reasoning forward after normal reply');
  assert.ok(
    runtime06.indexOf('const sent = await sendGroupReply') < runtime06.indexOf('await maybeSendReasoningForward(replyEnvelope'),
    'non-streaming reasoning forward should happen after normal reply send'
  );
  assert.ok(
    runtime06.includes('replyText: reply,'),
    'normal send should use sanitized reply text, not raw envelope replyText'
  );

  console.log('messageHandlerReasoningForwardSource.test.js passed');
})();
