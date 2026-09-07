const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'messageHandler.runtime.js'), 'utf8');
assert.strictEqual(source.includes('schedulePrivateStatusBar'), false);
assert.strictEqual((source.match(/scheduleReplyVisual\(/g) || []).length, 3);
assert.ok(source.includes('replyVisualRuntimeOverride'));
assert.ok(source.includes('shouldSendReplyVisual'));
assert.ok(source.includes("require('./replyVisual')"));

console.log('messageHandlerLive2dFollowup.test.js passed');
