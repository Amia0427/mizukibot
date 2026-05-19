const assert = require('assert');

const {
  createRepairOrContinueNode,
  createRouteAfterRepair
} = require('../api/runtimeV2/nodes/repairOrContinue');

module.exports = (async () => {
  const repairNode = createRepairOrContinueNode({
    rebuildFinalPlanFromSteps(state) {
      return {
        steps: (state.plan?.steps || []).map((step) => ({ id: step.id, action: step.tool || step.action }))
      };
    },
    normalizeObject(value, fallback = {}) {
      return value && typeof value === 'object' ? value : fallback;
    },
    normalizeArray(value) {
      return Array.isArray(value) ? value : [];
    },
    buildRepairPlanImpl() {
      return null;
    },
    isCompletedSideEffectStep() {
      return false;
    },
    createEvent(type, payload = {}) {
      return { type, ...payload };
    },
    saveAndEmit(state) {
      return state;
    }
  });

  const noRetryResult = await repairNode({
    plan: {
      verification: {
        done: false,
        failures: [
          {
            step_id: 'planner_step_1',
            action: 'unknown_tool',
            error: 'unknown tool'
          }
        ],
        retryable_steps: [],
        repair_strategy: {
          allowModelRepair: true
        }
      },
      steps: [
        {
          id: 'planner_step_1',
          kind: 'tool',
          tool: 'unknown_tool',
          status: 'failed',
          blockingReason: 'unknown tool'
        }
      ],
      rounds: [{ round: 1 }]
    },
    execution: {}
  });

  assert.strictEqual(noRetryResult.execution.retryQueue.length, 0);
  assert.strictEqual(noRetryResult.execution.status, 'validated');
  assert.strictEqual(noRetryResult.plan.steps[0].status, 'failed');
  assert.strictEqual(createRouteAfterRepair()(noRetryResult), 'answer');

  const retryableResult = await repairNode({
    plan: {
      verification: {
        done: false,
        failures: [
          {
            step_id: 'planner_step_2',
            action: 'web_fetch',
            error: 'runtime_binding_unresolved:web_fetch_url'
          }
        ],
        retryable_steps: ['planner_step_2']
      },
      steps: [
        {
          id: 'planner_step_2',
          kind: 'tool',
          tool: 'web_fetch',
          status: 'failed',
          blockingReason: 'runtime_binding_unresolved:web_fetch_url'
        }
      ],
      rounds: [{ round: 1 }]
    },
    execution: {}
  });

  assert.strictEqual(retryableResult.execution.retryQueue.length, 1);
  assert.strictEqual(retryableResult.execution.status, 'repairing');
  assert.strictEqual(retryableResult.plan.steps[0].status, 'pending');
  assert.strictEqual(retryableResult.plan.steps[0].blockingReason, '');
  assert.strictEqual(createRouteAfterRepair()(retryableResult), 'dispatch');

  console.log('repairOrContinueRetryable.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
