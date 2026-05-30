const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const { parseBackgroundControlCommand } = require('../core/messageReplyRuntime');

assert.deepStrictEqual(parseBackgroundControlCommand('任务状态'), { type: 'status', payload: '' });
assert.strictEqual(parseBackgroundControlCommand('批准 abc123'), null);
assert.strictEqual(parseBackgroundControlCommand('拒绝 req_1'), null);
assert.strictEqual(parseBackgroundControlCommand('切 agent codex-local'), null);
assert.strictEqual(parseBackgroundControlCommand('重连会话 now'), null);

console.log('messageReplyRuntimeControl.test.js passed');
