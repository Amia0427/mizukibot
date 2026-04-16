const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const { createHapiControlRuntime } = require('../utils/hapiControlRuntime');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-hapi-control-'));
const storeFile = path.join(tmpDir, 'hapi_control.json');

const runtime = createHapiControlRuntime({
  filePath: storeFile,
  approvalTtlMs: 60 * 1000
});

const session = runtime.upsertSession({
  session_id: 'sess_1',
  machine_id: 'claude-local',
  user_id: 'u1',
  group_id: 'g1',
  status: 'running'
});

assert.strictEqual(session.session_id, 'sess_1');

const approval = runtime.createApproval({
  request_id: 'req_1',
  session_id: 'sess_1',
  user_id: 'u1',
  group_id: 'g1',
  summary: 'need permission'
});

assert.strictEqual(approval.session_id, 'sess_1');
assert.strictEqual(runtime.findPendingApprovalBySession('sess_1').request_id, 'req_1');

const resolved = runtime.resolveApproval(approval.id, 'approve', 'ok');
assert.strictEqual(resolved.status, 'approved');

const sessions = runtime.listSessions(10, { userId: 'u1' });
assert.strictEqual(sessions.length, 1);

console.log('hapiControlRuntime.test.js passed');
