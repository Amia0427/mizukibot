const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'core', 'messageHandler.runtime.js'),
  'utf8'
);
const commandCall = source.indexOf('handleToolAuthorizationCommand(rawMessageText');
const continuousPreprocess = source.indexOf('continuousMessagePreprocessor.handleMessage(msg');
const luckinCommand = source.indexOf('getLuckinCommandService().handleIncomingMessage(msg');
const deterministicToolRouting = source.indexOf('route = applyDeterministicToolRouting(route)');
const attachmentPromptMerge = source.indexOf('runtimeQuestionText = buildUntrustedAttachmentInput(');

assert.ok(commandCall >= 0, 'message ingress must call the trusted tool authorization command handler');
assert.ok(continuousPreprocess > commandCall, 'tool authorization commands must bypass continuous message batching');
assert.ok(luckinCommand > commandCall, 'tool authorization commands must run before unrelated command/model routing');
assert.ok(
  attachmentPromptMerge > deterministicToolRouting,
  'untrusted attachment text must not influence deterministic tool authorization routing'
);
assert.match(source, /runWithDeliveryContext\(\{\s*target: authorizationOriginRoute,\s*personId: senderId/);
assert.match(source, /deliveryTarget: effectiveMsg\?\.delivery_target \|\| msg\?\.delivery_target \|\| null/);
assert.match(source, /route\.meta\.persistUserText = persistUserText/);

console.log('messageToolAuthorizationIngress.test.js passed');
