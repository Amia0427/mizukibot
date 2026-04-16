const assert = require('assert');
const fs = require('fs');
const path = require('path');

module.exports = (() => {
  const filePath = path.join(__dirname, '..', 'core', 'messageHandler.js');
  const source = fs.readFileSync(filePath, 'utf8');

  assert.ok(
    source.includes("const isPrivateInbound = isPrivateChatType(chatType);"),
    'messageHandler should derive private concurrency from chatType'
  );
  assert.ok(
    source.includes("const selectedInboundConcurrency = isPrivateInbound ? privateInboundConcurrency : inboundConcurrency;"),
    'messageHandler should route all private chats through private inbound concurrency'
  );
  assert.ok(
    !source.includes("const selectedInboundConcurrency = privilegedPrivateChat ? privateInboundConcurrency : inboundConcurrency;"),
    'messageHandler should not gate private concurrency pool behind privilegedPrivateChat'
  );

  console.log('messageHandlerPrivateConcurrencySource.test.js passed');
})();
