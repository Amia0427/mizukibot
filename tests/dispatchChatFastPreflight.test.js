const assert = require('assert');

const { createDispatchNode } = require('../api/runtimeV2/nodes/dispatch');

module.exports = (async () => {
  let preflightCalls = 0;
  let lastPreflightContext = null;
  const runtimeEvents = [];
  const dispatchNode = createDispatchNode({
    normalizeObject(value, fallback = {}) {
      return value && typeof value === 'object' ? value : fallback;
    },
    normalizeArray(value) {
      return Array.isArray(value) ? value : [];
    },
    createEvent(type, payload = {}) {
      return { type, ...payload };
    },
    stableHash(value) {
      return JSON.stringify(value || {});
    },
    isCompletedSideEffectStep() {
      return false;
    },
    findEvidenceEnvelope() {
      return null;
    },
    isDirectChatRequest() {
      return false;
    },
    buildDirectChatExecutionBatches() {
      return [];
    },
    canRunStepsInParallel() {
      return false;
    },
    buildLiveMainConversationSnapshot() {
      return null;
    },
    computeEffectiveAllowedTools() {
      return ['web_search'];
    },
    createMemoryCliTurnState(value = {}) {
      return value;
    },
    persistCheckpoint() {},
    appendRuntimeEvents(_state, events = []) {
      runtimeEvents.push(...events);
    },
    updatePlanStepsWithEnvelope(steps, envelope) {
      return steps.map((step) => (step.id === envelope.step_id ? { ...step, status: envelope.status } : step));
    },
    getPolicy() {
      return {};
    },
    isSideEffectPolicy() {
      return false;
    },
    async executeBatch(steps) {
      return steps.map((step) => ({
        tool_call_id: `${step.id}_1`,
        step_id: step.id,
        tool_name: step.tool,
        args_hash: JSON.stringify(step.inputs || {}),
        args: step.inputs || {},
        status: 'completed',
        result: 'ok',
        side_effect: false,
        retryable: false,
        attempt: 1
      }));
    },
    async runCapabilityPreflight(_question, context = {}) {
      preflightCalls += 1;
      lastPreflightContext = context;
      return {
        skipped: false,
        results: [],
        evidenceMessage: '',
        memoryCliTurn: {}
      };
    },
    rebuildFinalPlanFromSteps(nextState) {
      return { steps: nextState.plan.steps };
    },
    buildExecLogsFromSteps() {
      return [];
    },
    mergeAllowedToolsWithMemoryCli(allowed) {
      return allowed || [];
    },
    requiresToolEvidence() {
      return false;
    },
    saveAndEmit(state) {
      return state;
    },
    config: {
      PLAN_MAX_STEPS: 5,
      GLOBAL_TOOL_PREFLIGHT_CHAT_FAST: false
    }
  });

  await dispatchNode({
    request: {
      question: '闲聊一下',
      allowedTools: ['web_search'],
      allowTools: true,
      routeMeta: {}
    },
    plan: {
      steps: [
        {
          id: 'planner_step_1',
          kind: 'tool',
          tool: 'web_search',
          inputs: { query: 'hello' },
          status: 'pending',
          evidence: []
        }
      ]
    },
    execution: {
      retryQueue: [],
      memoryCliTurn: {},
      toolResults: [],
      latencyDecision: {
        profile: 'chat_fast'
      }
    },
    memory: {
      dirty: false
    },
    output: {}
  });

  assert.strictEqual(preflightCalls, 0, 'chat_fast should skip synchronous preflight by default');

  await dispatchNode({
    request: {
      question: '需要查资料',
      allowedTools: ['web_search'],
      allowTools: true,
      routeMeta: {
        toolPlanner: {
          executionPlan: {
            mode: 'tool_plan',
            steps: [
              {
                id: 'route_step_1',
                action: 'web_search',
                args: { query: 'hello' },
                purpose: 'search'
              }
            ]
          }
        }
      }
    },
    plan: {
      planner: {
        toolPlannerSingleAuthority: true,
        validation: {
          ok: true,
          status: 'validated'
        }
      },
      steps: [
        {
          id: 'planner_step_2',
          kind: 'tool',
          tool: 'web_search',
          inputs: { query: 'hello' },
          status: 'pending',
          evidence: []
        }
      ]
    },
    execution: {
      retryQueue: [],
      memoryCliTurn: {},
      toolResults: [],
      latencyDecision: {
        profile: 'balanced'
      }
    },
    memory: {
      dirty: false
    },
    output: {}
  });

  assert.strictEqual(preflightCalls, 1, 'non chat_fast dispatch should still run preflight');
  assert.deepStrictEqual(
    lastPreflightContext.routePlannerExecutionPlan,
    {
      mode: 'tool_plan',
      steps: [
        {
          id: 'route_step_1',
          action: 'web_search',
          args: { query: 'hello' },
          purpose: 'search'
        }
      ]
    },
    'dispatch preflight should reuse route planner executionPlan context'
  );
  assert.strictEqual(lastPreflightContext.routePlannerValidation.ok, true);
  assert.strictEqual(runtimeEvents[0].type, 'node_start', 'dispatch node_start should be emitted before preflight waits');
  assert.strictEqual(runtimeEvents[1].type, 'dispatch_preflight_start');
  assert.strictEqual(runtimeEvents[2].type, 'dispatch_preflight_complete');

  console.log('dispatchChatFastPreflight.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
