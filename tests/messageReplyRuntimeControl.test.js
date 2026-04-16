const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const { parseBackgroundControlCommand } = require('../core/messageReplyRuntime');

assert.deepStrictEqual(parseBackgroundControlCommand('任务状态'), { type: 'status', payload: '' });
assert.deepStrictEqual(parseBackgroundControlCommand('批准 abc123'), { type: 'approve', payload: 'abc123' });
assert.deepStrictEqual(parseBackgroundControlCommand('拒绝 req_1'), { type: 'deny', payload: 'req_1' });
assert.deepStrictEqual(parseBackgroundControlCommand('切 agent codex-local'), { type: 'switch_agent', payload: 'codex-local' });
assert.deepStrictEqual(parseBackgroundControlCommand('重连会话 now'), { type: 'resume_session', payload: 'now' });

console.log('messageReplyRuntimeControl.test.js passed');
