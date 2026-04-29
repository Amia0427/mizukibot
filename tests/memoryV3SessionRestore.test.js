const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-session-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';

fs.mkdirSync(tempRoot, { recursive: true });

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const { restoreSessionState } = require('../utils/memory-v3/session');

module.exports = (async () => {
  await appendMemoryEvent({
    type: 'session_checkpoint',
    userId: 'u_restore',
    sessionKey: 'direct:u_restore',
    scopeType: 'session',
    source: 'test',
    payload: {
      snapshotType: 'pre_reply',
      carryOverUserTurn: '上次你还没回答我的部署问题',
      summary: '在讨论 Linux 服务器部署',
      activeTopic: '部署'
    }
  });
  await appendMemoryEvent({
    type: 'session_checkpoint',
    ts: 2000,
    userId: 'u_clear',
    sessionKey: 'direct:u_clear',
    scopeType: 'session',
    source: 'test',
    payload: {
      snapshotType: 'post_reply',
      activeTopic: '旧梗 active topic',
      interactionState: {
        activeTopic: '旧梗 active topic'
      }
    }
  });
  await appendMemoryEvent({
    type: 'session_checkpoint',
    ts: 2001,
    userId: 'u_clear',
    sessionKey: 'direct:u_clear',
    scopeType: 'session',
    source: 'test',
    sourceKind: 'restart_recall_clear',
    payload: {
      snapshotType: 'post_reply',
      activeTopic: '',
      interactionState: {
        activeTopic: ''
      }
    }
  });
  materializeMemoryViews();

  const restored = await restoreSessionState('direct:u_restore', { userId: 'u_restore' });
  assert.strictEqual(restored.restored, true);
  assert.strictEqual(restored.mode, 'pending');
  assert.ok(String(restored.session.carryOverUserTurn || '').includes('部署问题'));
  const projection = JSON.parse(fs.readFileSync(path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'session_projection.json'), 'utf8'));
  assert.strictEqual(projection.sessions['direct:u_clear'].activeTopic, '');
  assert.strictEqual(projection.sessions['direct:u_clear'].interactionState.activeTopic, '');
  console.log('memoryV3SessionRestore.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
