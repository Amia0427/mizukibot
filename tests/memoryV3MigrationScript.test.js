const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-migrate-'));
const env = {
  ...process.env,
  DATA_DIR: tempRoot,
  MEMORY_FILE: path.join(tempRoot, 'memories.json'),
  DATA_FILE: path.join(tempRoot, 'favorites.json'),
  MEMORY_V3_DIR: path.join(tempRoot, 'memory-v3'),
  MEMORY_V3_EVENTS_DIR: path.join(tempRoot, 'memory-v3', 'events'),
  MEMORY_V3_PROJECTIONS_DIR: path.join(tempRoot, 'memory-v3', 'projections'),
  MEMORY_V3_ENABLED: 'true'
};

fs.mkdirSync(tempRoot, { recursive: true });
fs.writeFileSync(env.MEMORY_FILE, JSON.stringify({
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
fs.writeFileSync(env.DATA_FILE, JSON.stringify({
  u_migrate: {
    points: 10,
    relationship: '普通朋友',
    attitude: '友好'
  }
}, null, 2));

const result = spawnSync(process.execPath, ['scripts/migrate-memory-v3.js'], {
  cwd: path.resolve(__dirname, '..'),
  env,
  encoding: 'utf8'
});

assert.strictEqual(result.status, 0, result.stderr || result.stdout);
const profileProjectionFile = path.join(env.MEMORY_V3_PROJECTIONS_DIR, 'profile_projection.json');
assert.ok(fs.existsSync(profileProjectionFile), 'expected profile projection to exist');
const profileProjection = JSON.parse(fs.readFileSync(profileProjectionFile, 'utf8'));
assert.ok(profileProjection.users.u_migrate, 'expected migrated user');
assert.ok(profileProjection.users.u_migrate.identities.includes('工程师'));
assert.ok(profileProjection.users.u_migrate.likes.includes('猫'));

console.log('memoryV3MigrationScript.test.js passed');
