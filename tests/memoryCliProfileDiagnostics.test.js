const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-cli-profile-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_CLI_SEARCH_ENGINE = 'fast';
process.env.MEMORY_PROFILE_RECENT_TOPIC_TTL_DAYS = '1';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
process.env.MEMORY_EMBEDDING_MODEL = '';

fs.mkdirSync(tempRoot, { recursive: true });
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const { runMemoryCli, prepareMemoryCliCommand } = require('../utils/memoryCli');

const now = Date.now();

module.exports = (async () => {
  await appendMemoryEvent({
    id: 'cli-identity',
    type: 'memory_confirmed',
    ts: now,
    userId: 'u_cli_profile',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'identity',
    semanticSlot: 'identity',
    text: '用户是后端开发者',
    confidence: 0.98,
    payload: { type: 'identity', fieldKey: 'identity' }
  });
  await appendMemoryEvent({
    id: 'cli-old-topic',
    type: 'memory_candidate_extracted',
    ts: now - (3 * 24 * 3600 * 1000),
    userId: 'u_cli_profile',
    scopeType: 'personal',
    source: 'extractor',
    sourceKind: 'extractor',
    status: 'candidate',
    memoryKind: 'topic',
    semanticSlot: 'topic',
    text: '过期话题',
    confidence: 0.95,
    payload: { type: 'topic', fieldKey: 'topic' }
  });
  materializeMemoryViews({ force: true });

  const parsed = prepareMemoryCliCommand('mem profile why-injected --query "我是谁"');
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.parsed.commandName, 'profile');
  assert.strictEqual(parsed.parsed.action, 'why-injected');

  const review = await runMemoryCli('mem profile review --limit 5', {
    userId: 'u_cli_profile'
  });
  assert.strictEqual(review.ok, true);
  assert.strictEqual(review.command, 'profile_review');
  assert.ok(review.items.some((item) => item.id === 'cli-identity'));

  const stale = await runMemoryCli('mem profile stale --limit 5', {
    userId: 'u_cli_profile'
  });
  assert.strictEqual(stale.ok, true);
  assert.strictEqual(stale.command, 'profile_stale');
  assert.ok(stale.items.some((item) => item.id === 'cli-old-topic'));

  const why = await runMemoryCli('mem profile why-injected --query "我是谁"', {
    userId: 'u_cli_profile'
  });
  assert.strictEqual(why.ok, true);
  assert.strictEqual(why.command, 'why_injected');
  assert.ok(String(why.text || '').includes('用户是后端开发者'));
  assert.ok(Array.isArray(why.traceItems));

  console.log('memoryCliProfileDiagnostics.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
