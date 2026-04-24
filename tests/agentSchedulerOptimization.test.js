const assert = require('assert');

process.env.AGENT_DEPENDENCY_AWARE_BATCHING = 'true';
process.env.AGENT_PARALLEL_SAFE_TOOLS = 'true';
process.env.AGENT_BATCH_MAX_CONCURRENCY = '2';
process.env.AGENT_BATCH_TOOL_TIMEOUT_MS = '40';
process.env.AGENT_TOOL_RESULT_CACHE_TTL_MS = '1000';
process.env.AGENT_RUNTIME_METRICS_ENABLED = 'false';

const scheduler = require('../api/runtimeV2/capabilities/scheduler');

module.exports = (async () => {
  const registry = {
    byName: new Map([
      ['fast_a', { name: 'fast_a', kind: 'tool', parallelSafe: true }],
      ['fast_b', { name: 'fast_b', kind: 'tool', parallelSafe: true }],
      ['writer', { name: 'writer', kind: 'tool', parallelSafe: false, sideEffect: true }]
    ])
  };

  const batches = scheduler.buildExecutionBatches([
    { id: 'a', kind: 'tool', tool: 'fast_a', inputs: { q: 1 } },
    { id: 'b', kind: 'tool', tool: 'fast_b', inputs: { q: 2 } },
    { id: 'c', kind: 'tool', tool: 'writer', inputs: { q: 3 } },
    { id: 'd', kind: 'tool', tool: 'fast_a', dependsOn: ['c'], inputs: { q: 4 } }
  ], registry);

  assert.deepStrictEqual(batches.map((batch) => batch.mode), ['parallel', 'serial', 'serial']);
  assert.deepStrictEqual(batches[0].items.map((step) => step.id).sort(), ['a', 'b']);
  assert.strictEqual(batches[1].items[0].id, 'c');
  assert.strictEqual(batches[2].items[0].id, 'd');

  let active = 0;
  let maxActive = 0;
  let callCount = 0;
  const cache = new Map();
  const executeBatchRegistry = {
    byName: new Map([
      ['fast_a', {
        name: 'fast_a',
        kind: 'tool',
        parallelSafe: true,
        executor: async () => {
          callCount += 1;
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 15));
          active -= 1;
          return 'ok';
        }
      }],
      ['slow', {
        name: 'slow',
        kind: 'tool',
        parallelSafe: true,
        executor: async () => {
          await new Promise((resolve) => setTimeout(resolve, 80));
          return 'late';
        }
      }]
    ])
  };

  const results = await scheduler.executeBatch([
    { id: 'x1', kind: 'tool', tool: 'fast_a', inputs: { same: true } },
    { id: 'x2', kind: 'tool', tool: 'fast_a', inputs: { same: false } },
    { id: 'x3', kind: 'tool', tool: 'fast_a', inputs: { same: 'third' } }
  ], { request: { allowedTools: ['fast_a'] } }, {
    registry: executeBatchRegistry,
    toolResultCache: cache,
    batches: [{ mode: 'parallel', items: [
      { id: 'x1', kind: 'tool', tool: 'fast_a', inputs: { same: true } },
      { id: 'x2', kind: 'tool', tool: 'fast_a', inputs: { same: false } },
      { id: 'x3', kind: 'tool', tool: 'fast_a', inputs: { same: 'third' } }
    ] }]
  });

  assert.strictEqual(results.length, 3);
  assert.ok(maxActive <= 2, 'batch executor should respect max concurrency');

  await scheduler.executeBatch([
    { id: 'x4', kind: 'tool', tool: 'fast_a', inputs: { same: true } }
  ], { request: { allowedTools: ['fast_a'] } }, {
    registry: executeBatchRegistry,
    toolResultCache: cache
  });
  assert.strictEqual(callCount, 3, 'cache should skip duplicate read-only tool execution');

  const [timeoutResult] = await scheduler.executeBatch([
    { id: 'slow_1', kind: 'tool', tool: 'slow', inputs: {} }
  ], { request: { allowedTools: ['slow'] } }, {
    registry: executeBatchRegistry
  });
  assert.strictEqual(timeoutResult.status, 'failed');
  assert.match(timeoutResult.result, /timeout/i);

  console.log('agentSchedulerOptimization.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
