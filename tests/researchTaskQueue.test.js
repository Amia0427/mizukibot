const assert = require('assert');
const { ResearchTaskQueue } = require('../core/researchTaskQueue');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = (async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const queue = new ResearchTaskQueue({
    config: {
      RESEARCH_SUBAGENT_ENABLED: true,
      RESEARCH_SUBAGENT_MAX_CONCURRENCY: 1,
      RESEARCH_SUBAGENT_TIMEOUT_MS: 1000,
      RESEARCH_SUBAGENT_MAX_TOOL_ROUNDS: 2,
      RESEARCH_SUBAGENT_CACHE_TTL_MS: 10000
    },
    runner: async (task) => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(30);
      active -= 1;
      return { id: task.id, status: 'completed' };
    }
  });
  const first = queue.enqueue({ sessionKey: 's1', userId: 'u1', query: 'same query' });
  const dup = queue.enqueue({ sessionKey: 's1', userId: 'u1', query: 'same   query' });
  const second = queue.enqueue({ sessionKey: 's1', userId: 'u1', query: 'other query' });
  assert.strictEqual(first.enqueued, true);
  assert.strictEqual(dup.deduped, true);
  assert.strictEqual(second.enqueued, true);
  await delay(90);
  assert.strictEqual(calls, 2);
  assert.strictEqual(maxActive, 1);
  console.log('researchTaskQueue.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
