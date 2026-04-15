const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-projection-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');

fs.mkdirSync(tempRoot, { recursive: true });
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({
  u1: {
    facts: ['喜欢咖啡'],
    profile: {
      identities: ['医学生'],
      personality_traits: ['直接'],
      hobbies: ['摄影'],
      likes: ['猫'],
      dislikes: ['蘑菇'],
      goals: ['保研'],
      recent_topics: ['显卡'],
      relation_stage: '普通朋友'
    },
    summary: '用户是医学生',
    impression: '讲话直接'
  }
}, null, 2));
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({
  u1: {
    points: 120,
    relationship: '普通朋友',
    attitude: '友好'
  }
}, null, 2));

const { runMemoryMigration, loadProjection } = require('../utils/memoryProjection');
const { getMemoryItems } = require('../utils/vectorMemory');

const result = runMemoryMigration();
assert.strictEqual(result.ok, true);
assert.ok(result.importResult.attempted > 0, 'expected legacy items to be imported');

const projection = loadProjection();
assert.ok(projection.users.u1, 'expected projected user');
assert.ok(projection.users.u1.profile.identities.includes('医学生'));
assert.ok(projection.users.u1.profile.likes.includes('猫'));
assert.ok(projection.users.u1.summary.includes('医学生'));
assert.ok(projection.users.u1.impression.includes('讲话直接'));

const items = getMemoryItems('u1');
assert.ok(items.some((item) => item.type === 'summary' && item.text.includes('医学生')));
assert.ok(items.some((item) => item.type === 'impression' && item.text.includes('讲话直接')));
assert.ok(items.some((item) => item.type === 'like' && item.text.includes('猫')));

const {
  scheduleProjectionSave,
  flushScheduledProjectionSave,
  PROJECTION_FILE
} = require('../utils/memoryProjection');

const beforeMtime = fs.statSync(PROJECTION_FILE).mtimeMs;
scheduleProjectionSave(10);
const flushed = flushScheduledProjectionSave();
assert.strictEqual(flushed, true, 'expected scheduled projection save to flush');
const afterMtime = fs.statSync(PROJECTION_FILE).mtimeMs;
assert.ok(afterMtime >= beforeMtime, 'expected projection file mtime to advance after flush');

console.log('memoryProjection.test.js passed');
