const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-migrate-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';

fs.mkdirSync(tempRoot, { recursive: true });
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({
  u_migrate: {
    facts: ['喜欢咖啡'],
    profile: {
      identities: ['工程师'],
      personality_traits: [],
      hobbies: [],
      likes: ['猫'],
      dislikes: [],
      goals: ['升职'],
      recent_topics: ['迁移'],
      relation_stage: '普通朋友'
    },
    summary: '用户是工程师',
    impression: '表达直接'
  }
}, null, 2));
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({
  u_migrate: {
    points: 10,
    relationship: '普通朋友',
    attitude: '友好'
  }
}, null, 2));
const dailyJournalDir = path.join(tempRoot, 'daily_journal', 'u_migrate');
fs.mkdirSync(dailyJournalDir, { recursive: true });
fs.writeFileSync(path.join(dailyJournalDir, '2026-05-20.json'), JSON.stringify({
  summary: '当天聊了迁移脚本和咖啡偏好'
}, null, 2));
const { migrateLegacyMemoryToV3 } = require('../utils/memory-v3');
const { loadMemoryEvents } = require('../utils/memory-v3/events');
const { materializeMemoryV3Views } = require('../utils/memory-v3/migration');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const { loadMemoryNodes, loadEpisodeProjection } = require('../utils/memory-v3/storage');

module.exports = (async () => {
  const materializedOnly = materializeMemoryV3Views();
  assert.strictEqual(materializedOnly.ok, true);
  assert.strictEqual(loadMemoryEvents().length, 0);

  const result = await migrateLegacyMemoryToV3({ forceImport: true });
  assert.strictEqual(result.ok, true);
  const eventCountAfterImport = loadMemoryEvents().length;
  assert.ok(eventCountAfterImport > 0, 'expected explicit import to append migration events');
  const nodeCountAfterImport = loadMemoryNodes().length;
  const episodeCountAfterImport = Object.values(loadEpisodeProjection().users || {})
    .reduce((total, entry) => total + (Array.isArray(entry?.items) ? entry.items.length : 0), 0);

  const skipped = await migrateLegacyMemoryToV3();
  assert.strictEqual(skipped.skipped, true);
  assert.strictEqual(skipped.reason, 'legacy_migration_events_exist');
  assert.strictEqual(loadMemoryEvents().length, eventCountAfterImport);

  const repeated = await migrateLegacyMemoryToV3({ forceImport: true });
  assert.strictEqual(repeated.ok, true);
  assert.ok(loadMemoryEvents().length > eventCountAfterImport, 'expected forced repeat import to append raw events');
  const rematerialized = materializeMemoryViews({ force: true });
  assert.ok(rematerialized.stats.dedupe.suppressedEvents > 0, 'expected materializer to suppress replayed import events');
  assert.strictEqual(loadMemoryNodes().length, nodeCountAfterImport);
  const episodeCountAfterRepeat = Object.values(loadEpisodeProjection().users || {})
    .reduce((total, entry) => total + (Array.isArray(entry?.items) ? entry.items.length : 0), 0);
  assert.strictEqual(episodeCountAfterRepeat, episodeCountAfterImport);

  const profileProjectionFile = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'profile_projection.json');
  assert.ok(fs.existsSync(profileProjectionFile), 'expected profile projection to exist');
  const profileProjection = JSON.parse(fs.readFileSync(profileProjectionFile, 'utf8'));
  assert.ok(profileProjection.users.u_migrate, 'expected migrated user');
  assert.strictEqual(profileProjection.version, 2);
  assert.ok(profileProjection.users.u_migrate.weakProfile.recent_topics.includes('喜欢咖啡'));
  assert.ok(profileProjection.users.u_migrate.relation_stage.includes('普通朋友'));
  console.log('memoryV3MigrationScript.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
