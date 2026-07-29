const assert = require('assert');
const fs = require('fs');
const path = require('path');

module.exports = (() => {
  const root = path.resolve(__dirname, '..');
  const runtime = fs.readFileSync(path.join(root, 'core', 'messageHandler.runtime.chunk.js'), 'utf8');
  const ingress = fs.readFileSync(path.join(root, 'core', 'messageHandler.runtime-03.chunk.js'), 'utf8');
  const fastReply = fs.readFileSync(path.join(root, 'core', 'messageHandler.runtime-05.chunk.js'), 'utf8');
  const finalReply = fs.readFileSync(path.join(root, 'core', 'messageHandler.runtime-06.chunk.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'index.js'), 'utf8');

  assert.ok(runtime.includes('privateProactiveEngine = null'));
  assert.ok(ingress.includes('recordPrivateProactiveActivity(senderId, chatType);'));
  assert.ok(ingress.includes('privateProactiveEngine.handleControlCommand(rawMessageText'));
  assert.ok(ingress.indexOf('privateProactiveEngine.handleControlCommand(rawMessageText') < ingress.indexOf('continuousMessagePreprocessor.handleMessage'));
  assert.ok(fastReply.includes('registerPrivateProactiveUserAfterReply(senderId);'));
  assert.ok((finalReply.match(/registerPrivateProactiveUserAfterReply\(senderId\);/g) || []).length >= 2);
  assert.ok(main.includes('privateProactiveEngine.start();'));
  assert.ok(main.includes("{ name: 'private_proactive', run: () => privateProactiveEngine.stop() }"));

  console.log('privateProactiveIntegrationSource.test.js passed');
})();
