const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-cli-v3-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
process.env.MEMORY_EMBEDDING_MODEL = '';
process.env.PROFILE_JOURNAL_DB_ENABLED = 'true';
process.env.PROFILE_JOURNAL_DB_PRIMARY_READ = 'true';
process.env.PROFILE_JOURNAL_AUTO_CLEAN_ENABLED = 'true';
process.env.PROFILE_JOURNAL_DB_FILE = path.join(tempRoot, 'profile_journal.sqlite');

fs.mkdirSync(tempRoot, { recursive: true });

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const { runMemoryCli } = require('../utils/memoryCli');
const { upsertJournalEntry } = require('../utils/profileJournalDb');

module.exports = (async () => {
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_cli',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'like',
    semanticSlot: 'like',
    canonicalKey: '猫',
    text: '喜欢猫',
    payload: { type: 'like' }
  });
  materializeMemoryViews();

  const payload = await runMemoryCli('mem search --query "喜欢什么"', {
    userId: 'u_cli',
    routePolicyKey: 'direct_chat/default',
    topRouteType: 'direct_chat'
  });

  assert.strictEqual(payload.ok, true);
  assert.ok(Array.isArray(payload.results));
  assert.ok(payload.results.some((item) => String(item.preview || '').includes('喜欢猫')));

  const profileList = await runMemoryCli('mem profile list --user u_cli --status active', {
    userId: 'u_cli',
    routePolicyKey: 'direct_chat/default',
    topRouteType: 'direct_chat'
  });
  assert.strictEqual(profileList.ok, true);
  assert.ok(profileList.results.some((item) => item.sourceKind === 'profile_journal_db' && item.status === 'active' && item.text.includes('喜欢猫')));

  upsertJournalEntry({
    userId: 'u_cli',
    day: '2026-06-02',
    ts: '2026-06-02T10:00:00.000Z',
    userText: 'CLI journal 查询',
    assistantText: '结构化日记命中',
    safety: 'safe',
    status: 'active'
  });
  const journalList = await runMemoryCli('mem journal list --user u_cli --day 2026-06-02', {
    userId: 'u_cli',
    routePolicyKey: 'direct_chat/default',
    topRouteType: 'direct_chat'
  });
  assert.strictEqual(journalList.ok, true);
  assert.ok(journalList.results.some((item) => item.sourceKind === 'profile_journal_db' && item.text.includes('结构化日记命中')));
  console.log('memoryCliV3.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
