const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';
process.env.HAPI_BASE_URL = 'http://127.0.0.1:9876';
process.env.HAPI_CLAUDE_MACHINE = 'claude-local';
process.env.HAPI_CODEX_MACHINE = 'codex-local';
process.env.HAPI_DEFAULT_MACHINE = 'claude-local';

const {
  parseSseEvents,
  resolveMachineId,
  normalizeEventType,
  chooseFinalText
} = require('../api/subagentBackends/hapiBackend');

const events = parseSseEvents([
  'event: message',
  'data: {"text":"hello"}',
  '',
  'event: done',
  'data: {"text":"world"}',
  ''
].join('\n'));

assert.strictEqual(events.length, 2);
assert.strictEqual(normalizeEventType(events[0]), 'message');
assert.strictEqual(normalizeEventType({
  type: 'permission_request',
  payload: { summary: 'approve me' }
}), 'approval_request');
assert.strictEqual(
  resolveMachineId({ routePolicyKey: 'admin/full', topRouteType: 'admin' }),
  'codex-local'
);
assert.strictEqual(
  resolveMachineId({ routePolicyKey: 'tool/review', topRouteType: 'direct_chat' }),
  'claude-local'
);
assert.strictEqual(chooseFinalText(events), 'hello\nworld');

console.log('hapiBackend.test.js passed');
