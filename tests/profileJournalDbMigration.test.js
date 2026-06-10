const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-profile-journal-migration-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROFILE_PROJECTION_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'profile_projection.json');
process.env.MEMORY_V3_EPISODE_PROJECTION_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'episode_projection.json');
process.env.MEMORY_V3_NODES_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'memory_nodes.jsonl');
process.env.DAILY_JOURNAL_DIR = path.join(tempRoot, 'daily_journal');
process.env.PROFILE_JOURNAL_DB_ENABLED = 'true';
process.env.PROFILE_JOURNAL_DB_PRIMARY_READ = 'true';
process.env.PROFILE_JOURNAL_AUTO_CLEAN_ENABLED = 'true';
process.env.PROFILE_JOURNAL_DB_FILE = path.join(tempRoot, 'profile_journal.sqlite');

fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });
fs.mkdirSync(path.join(process.env.DAILY_JOURNAL_DIR, 'u_migrate'), { recursive: true });

const staleTs = Date.parse('2025-01-01T00:00:00.000Z');
fs.writeFileSync(
  process.env.MEMORY_V3_NODES_FILE,
  `${JSON.stringify({
    id: 'node-stale-topic',
    userId: 'u_migrate',
    type: 'topic',
    fieldKey: 'topic',
    text: '很久以前的过期迁移话题',
    status: 'active',
    confidence: 0.95,
    sourceKind: 'extractor',
    createdAt: staleTs,
    updatedAt: staleTs,
    expiresAt: staleTs + 1000
  })}\n`,
  'utf8'
);
fs.writeFileSync(process.env.MEMORY_V3_PROFILE_PROJECTION_FILE, JSON.stringify({
  version: 2,
  users: {
    u_migrate: {
      strictProfile: {
        likes: ['喜欢结构化迁移测试'],
        goals: ['迁移后只读 SQLite']
      },
      weakProfile: {
        recent_topics: ['弱画像候选迁移']
      },
      personaCore: {
        summary: '迁移 persona 摘要'
      }
    }
  }
}, null, 2));
fs.writeFileSync(process.env.MEMORY_V3_EPISODE_PROJECTION_FILE, JSON.stringify({
  version: 1,
  users: {
    u_migrate: {
      items: [{
        id: 'episode-2026-06-01',
        rollupLevel: 'daily',
        episodeDay: '2026-06-01',
        startDay: '2026-06-01',
        endDay: '2026-06-01',
        text: '迁移来的 daily rollup',
        notRecallable: false
      }]
    }
  }
}, null, 2));
fs.writeFileSync(
  path.join(process.env.DAILY_JOURNAL_DIR, 'u_migrate', '2026-06-01.journal.md'),
  [
    '## 09:00',
    '',
    'User: 今天迁移 journal',
    '',
    'Assistant: 记录安全条目',
    '',
    '## 09:01',
    '',
    'User: 你知道我是谁吗',
    '',
    'Assistant: 你是谁来着'
  ].join('\n'),
  'utf8'
);
fs.writeFileSync(
  path.join(process.env.DAILY_JOURNAL_DIR, 'u_migrate', '2026-06-01.entries.jsonl'),
  [
    JSON.stringify({ ts: '2026-06-01T01:00:00.000Z' }),
    JSON.stringify({ ts: '2026-06-01T01:01:00.000Z', unsafe: true, unsafeReason: 'unsafe_identity_recall_reply', journalWriteSkipped: true })
  ].join('\n'),
  'utf8'
);

const { runMigration } = require('../scripts/migrate-profile-journal-db');
const {
  getDiagnostics,
  getJournalRetrievalBundleFromDb,
  listJournalEntries,
  listProfileFacts,
  profileProjectionFromDb,
  resetDbForTests
} = require('../utils/profileJournalDb');

module.exports = (async () => {
  resetDbForTests();
  const dryRun = runMigration({ apply: false });
  assert.strictEqual(dryRun.applied, false);
  assert.ok(dryRun.profileFacts >= 4);
  assert.ok(dryRun.journalEntries >= 2);

  const applied = runMigration({ apply: true });
  assert.strictEqual(applied.applied, true);
  assert.ok(applied.profileFactsWritten >= 3);
  assert.ok(applied.journalEntriesWritten >= 2);
  assert.ok(applied.journalRollupsWritten >= 1);

  const activeFacts = listProfileFacts({ userId: 'u_migrate', status: 'active', limit: 20 }).facts;
  const staleFacts = listProfileFacts({ userId: 'u_migrate', status: 'stale', limit: 20 }).facts;
  assert.ok(activeFacts.some((item) => item.value.includes('喜欢结构化迁移测试')));
  assert.ok(staleFacts.some((item) => item.value.includes('过期迁移话题')));

  const projection = profileProjectionFromDb('u_migrate').profile;
  assert.ok(projection.strictProfile.likes.includes('喜欢结构化迁移测试'));
  assert.ok(!projection.weakProfile.recent_topics.includes('很久以前的过期迁移话题'));

  const entries = listJournalEntries({ userId: 'u_migrate', day: '2026-06-01' }).entries;
  assert.ok(entries.some((item) => item.status === 'active' && item.assistantText.includes('记录安全条目')));
  assert.ok(entries.some((item) => item.status === 'unsafe' && item.safety === 'unsafe_identity_recall_reply'));

  const bundle = getJournalRetrievalBundleFromDb('u_migrate', {
    timestamp: '2026-06-01',
    includeActiveRaw: true
  });
  assert.strictEqual(bundle.ok, true);
  assert.ok(bundle.text.includes('记录安全条目'));
  assert.ok(bundle.text.includes('迁移来的 daily rollup'));
  assert.ok(!bundle.text.includes('你是谁来着'));

  const diagnostics = getDiagnostics({ limit: 5 });
  assert.strictEqual(diagnostics.ok, true);
  assert.ok(diagnostics.profileStatus.active >= 3);
  assert.ok(diagnostics.profileStatus.stale >= 1);
  assert.ok(diagnostics.journalStatus.unsafe >= 1);

  console.log('profileJournalDbMigration.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
