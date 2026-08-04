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

assert.ok(commandCall >= 0, 'message ingress must call the trusted tool authorization command handler');
assert.ok(continuousPreprocess > commandCall, 'tool authorization commands must bypass continuous message batching');
assert.ok(luckinCommand > commandCall, 'tool authorization commands must run before unrelated command/model routing');

console.log('messageToolAuthorizationIngress.test.js passed');
