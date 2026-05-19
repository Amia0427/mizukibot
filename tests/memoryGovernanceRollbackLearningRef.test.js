const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-governance-rollback-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');

fs.mkdirSync(tempRoot, { recursive: true });
fs.writeFileSync(path.join(tempRoot, 'memory_items.json'), JSON.stringify({
  version: 2,
  items: [
    {
      id: 'match_job_turn',
      userId: 'u_rollback',
      text: 'from job and turn',
      type: 'fact',
      status: 'active',
      meta: {
        learningDecision: {
          jobId: 'job-a',
          turnId: 'turn-a',
          turnIds: ['turn-a'],
          phase: 'post_reply_learning'
        }
      }
    },
    {
      id: 'same_job_other_turn',
      userId: 'u_rollback',
      text: 'same job other turn',
      type: 'fact',
      status: 'active',
      meta: {
        learningDecision: {
          jobId: 'job-a',
          turnId: 'turn-b',
          turnIds: ['turn-b'],
          phase: 'post_reply_learning'
        }
      }
    },
    {
      id: 'post_reply_job_id_match',
      userId: 'u_rollback',
      text: 'post reply id match',
      type: 'fact',
      status: 'active',
      meta: {
        learningDecision: {
          postReplyJobId: 'job-b',
          turnIds: ['turn-c'],
          phase: 'post_reply_learning'
        }
      }
    },
    {
      id: 'non_post_reply',
      userId: 'u_rollback',
      text: 'manual memory',
      type: 'fact',
      status: 'active',
      meta: {}
    }
  ]
}, null, 2), 'utf8');

clearProjectCache();
const { rollbackPostReplyLearning } = require('../utils/memoryGovernance');

const dry = rollbackPostReplyLearning({ jobId: 'job-a', turnId: 'turn-a', dryRun: true });
assert.strictEqual(dry.matched, 1);
assert.deepStrictEqual(dry.ids, ['match_job_turn']);

const rolled = rollbackPostReplyLearning({ jobId: 'job-a', turnId: 'turn-a', reason: 'test_rollback' });
assert.strictEqual(rolled.changed, 1);
assert.ok(rolled.snapshot, 'changed rollback should create snapshot');

const after = JSON.parse(fs.readFileSync(path.join(tempRoot, 'memory_items.json'), 'utf8')).items;
assert.strictEqual(after.find((item) => item.id === 'match_job_turn').status, 'archived');
assert.strictEqual(after.find((item) => item.id === 'match_job_turn').meta.rollback.reason, 'test_rollback');
assert.strictEqual(after.find((item) => item.id === 'same_job_other_turn').status, 'active');
assert.strictEqual(after.find((item) => item.id === 'non_post_reply').status, 'active');

const byPostReplyJob = rollbackPostReplyLearning({ postReplyJobId: 'job-b' });
assert.strictEqual(byPostReplyJob.changed, 1);
const finalItems = JSON.parse(fs.readFileSync(path.join(tempRoot, 'memory_items.json'), 'utf8')).items;
assert.strictEqual(finalItems.find((item) => item.id === 'post_reply_job_id_match').status, 'archived');

assert.throws(() => rollbackPostReplyLearning({}), /jobId, postReplyJobId, turnId, or turnIds is required/);

console.log('memoryGovernanceRollbackLearningRef.test.js passed');
