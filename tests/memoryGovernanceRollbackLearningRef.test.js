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
process.env.SELF_IMPROVEMENT_ENABLED = 'true';
process.env.SELF_IMPROVEMENT_STORE_DIR = path.join(tempRoot, 'self_improvement');
process.env.SELF_IMPROVEMENT_RULES_FILE = path.join(tempRoot, 'self_improvement', 'promoted_rules.json');
process.env.SELF_IMPROVEMENT_GUIDES_FILE = path.join(tempRoot, 'self_improvement', 'skill_guides.json');

fs.mkdirSync(tempRoot, { recursive: true });
fs.mkdirSync(process.env.SELF_IMPROVEMENT_STORE_DIR, { recursive: true });
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
fs.writeFileSync(path.join(process.env.SELF_IMPROVEMENT_STORE_DIR, 'events.jsonl'), [
  JSON.stringify({
    id: 'si_match_job_turn',
    kind: 'strategy',
    source: 'llm_extraction',
    status: 'open',
    summary: 'rollback self improvement event',
    suggestedAction: 'rollback me',
    confidence: 0.9,
    userId: 'u_rollback',
    jobId: 'job-a',
    postReplyJobId: 'job-a',
    turnId: 'turn-a',
    turnIds: ['turn-a']
  }),
  JSON.stringify({
    id: 'si_other_turn',
    kind: 'strategy',
    source: 'llm_extraction',
    status: 'open',
    summary: 'keep self improvement event',
    suggestedAction: 'keep me',
    confidence: 0.9,
    userId: 'u_rollback',
    jobId: 'job-a',
    postReplyJobId: 'job-a',
    turnId: 'turn-b',
    turnIds: ['turn-b']
  })
].join('\n') + '\n', 'utf8');
fs.writeFileSync(path.join(process.env.SELF_IMPROVEMENT_STORE_DIR, 'patterns.json'), JSON.stringify({ items: [] }, null, 2), 'utf8');
fs.writeFileSync(process.env.SELF_IMPROVEMENT_RULES_FILE, JSON.stringify({ items: [] }, null, 2), 'utf8');
fs.writeFileSync(process.env.SELF_IMPROVEMENT_GUIDES_FILE, JSON.stringify({ items: [] }, null, 2), 'utf8');

clearProjectCache();
const { rollbackPostReplyLearning } = require('../utils/memoryGovernance');
const {
  buildRollbackReport,
  parseArgs
} = require('../scripts/rollback-post-reply-job');

const dry = rollbackPostReplyLearning({ jobId: 'job-a', turnId: 'turn-a', dryRun: true });
assert.strictEqual(dry.memory.matched, 1);
assert.strictEqual(dry.selfImprovement.matched, 1);
assert.strictEqual(dry.matched, 2);
assert.deepStrictEqual(dry.ids, ['match_job_turn']);

const rolled = rollbackPostReplyLearning({ jobId: 'job-a', turnId: 'turn-a', reason: 'test_rollback' });
assert.strictEqual(rolled.memory.changed, 1);
assert.strictEqual(rolled.selfImprovement.changed, 1);
assert.strictEqual(rolled.changed, 2);
assert.ok(rolled.snapshot, 'changed rollback should create snapshot');

const after = JSON.parse(fs.readFileSync(path.join(tempRoot, 'memory_items.json'), 'utf8')).items;
assert.strictEqual(after.find((item) => item.id === 'match_job_turn').status, 'archived');
assert.strictEqual(after.find((item) => item.id === 'match_job_turn').meta.rollback.reason, 'test_rollback');
assert.strictEqual(after.find((item) => item.id === 'same_job_other_turn').status, 'active');
assert.strictEqual(after.find((item) => item.id === 'non_post_reply').status, 'active');
const selfEventsAfter = fs.readFileSync(path.join(process.env.SELF_IMPROVEMENT_STORE_DIR, 'events.jsonl'), 'utf8')
  .trim()
  .split(/\r?\n/)
  .map((line) => JSON.parse(line));
assert.strictEqual(selfEventsAfter.find((item) => item.id === 'si_match_job_turn').status, 'archived');
assert.strictEqual(selfEventsAfter.find((item) => item.id === 'si_match_job_turn').rollback.reason, 'test_rollback');
assert.strictEqual(selfEventsAfter.find((item) => item.id === 'si_other_turn').status, 'open');

const byPostReplyJob = rollbackPostReplyLearning({ postReplyJobId: 'job-b' });
assert.strictEqual(byPostReplyJob.changed, 1);
const finalItems = JSON.parse(fs.readFileSync(path.join(tempRoot, 'memory_items.json'), 'utf8')).items;
assert.strictEqual(finalItems.find((item) => item.id === 'post_reply_job_id_match').status, 'archived');

assert.throws(() => rollbackPostReplyLearning({}), /jobId, postReplyJobId, turnId, or turnIds is required/);

const parsed = parseArgs(['--job-id', 'job-a', '--turn-ids', 'turn-a,turn-b', '--apply', '--reason', 'cli']);
assert.strictEqual(parsed.jobId, 'job-a');
assert.deepStrictEqual(parsed.turnIds, ['turn-a', 'turn-b']);
assert.strictEqual(parsed.dryRun, false);
assert.strictEqual(parsed.reason, 'cli');

const cliDry = buildRollbackReport({
  dryRun: true,
  jobId: 'job-a',
  turnId: 'turn-b',
  turnIds: [],
  postReplyJobId: '',
  userId: '',
  reason: 'cli_dry'
});
assert.strictEqual(cliDry.result.memory.matched, 1);
assert.strictEqual(cliDry.result.selfImprovement.matched, 1);

console.log('memoryGovernanceRollbackLearningRef.test.js passed');
