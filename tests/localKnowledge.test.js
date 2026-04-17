const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-local-knowledge-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';

fs.mkdirSync(tempRoot, { recursive: true });

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const {
  queryLocalKnowledge,
  readNotebookDoc,
  updateNotebookIndexIncremental
} = require('../utils/localKnowledge');

module.exports = (async () => {
  const notebookDir = path.join(tempRoot, 'notebook', 'u_local');
  fs.mkdirSync(notebookDir, { recursive: true });
  const notePath = path.join(notebookDir, 'deploy.md');
  fs.writeFileSync(notePath, 'systemd 配置模板和部署排查步骤', 'utf8');
  const indexUpdate = updateNotebookIndexIncremental({ userId: 'u_local' }, notePath);
  assert.strictEqual(indexUpdate.updated, 1);

  await appendMemoryEvent({
    type: 'session_checkpoint',
    userId: 'u_local',
    sessionKey: 'direct:u_local',
    scopeType: 'session',
    source: 'test',
    payload: {
      snapshotType: 'post_reply',
      activeTopic: '部署',
      carryOverUserTurn: '继续上次部署问题',
      summary: '刚才在讨论 systemd 部署',
      openLoops: ['补充 systemd 配置']
    }
  });
  materializeMemoryViews();

  const result = await queryLocalKnowledge({
    userId: 'u_local',
    query: '继续上次部署问题',
    sessionKey: 'direct:u_local',
    topK: 5
  });

  assert.strictEqual(result.results[0].source, 'session_projection');
  assert.ok(result.results.some((item) => item.source === 'notebook_doc'));

  const opened = readNotebookDoc({ userId: 'u_local' }, {
    userId: 'u_local',
    docId: String(result.bySource.notebook_doc[0].ref.docId),
    chunkIndex: result.bySource.notebook_doc[0].ref.chunkIndex
  });
  assert.strictEqual(opened.ok, true);
  assert.ok(String(opened.text || '').includes('systemd'));

  fs.writeFileSync(notePath, 'systemd 配置模板、部署排查步骤、journalctl 命令', 'utf8');
  const secondUpdate = updateNotebookIndexIncremental({ userId: 'u_local' }, notePath);
  assert.strictEqual(secondUpdate.updated, 1);

  const refreshed = await queryLocalKnowledge({
    userId: 'u_local',
    query: 'journalctl 命令',
    sessionKey: 'direct:u_local',
    topK: 5
  });
  assert.ok(refreshed.results.some((item) => item.source === 'notebook_doc' && String(item.text || '').includes('journalctl')));
  console.log('localKnowledge.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
