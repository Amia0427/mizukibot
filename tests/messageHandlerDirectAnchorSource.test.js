const assert = require('assert');
const fs = require('fs');
const path = require('path');

const runtime04 = fs.readFileSync(path.join(__dirname, '..', 'core', 'messageHandler.runtime-04.chunk.js'), 'utf8');

assert.ok(
  runtime04.includes('const directBotAnchor = Boolean(isPrivateChatType(chatType) || mentioned);'),
  'group formal replies should require private chat or an explicit @ anchor'
);
assert.ok(
  runtime04.includes("acceptedBy: isPrivateChatType(chatType)\n        ? 'private_direct'\n        : 'at_bot'"),
  'accepted inbound log should not report reply_to_bot_recent as a formal reply entry'
);
assert.ok(
  !/const directBotAnchor = Boolean\([^;]*replyToBotIsRecent[^;]*\);/.test(runtime04),
  'reply_to_bot_recent must not bypass passive awareness into formal replies'
);

console.log('messageHandlerDirectAnchorSource.test.js passed');
