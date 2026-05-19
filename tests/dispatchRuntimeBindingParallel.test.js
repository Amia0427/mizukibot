const assert = require('assert');

const { createDispatchNode } = require('../api/runtimeV2/nodes/dispatch');

module.exports = (async () => {
  let executeBatchCalls = 0;
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
    buildExecutionBatches(steps) {
      return [{ mode: 'parallel', items: steps }];
    },
    buildLiveMainConversationSnapshot() {
      return null;
    },
    computeEffectiveAllowedTools() {
      return ['web_search', 'web_fetch'];
    },
    createMemoryCliTurnState(value = {}) {
      return value;
    },
    persistCheckpoint() {},
    appendRuntimeEvents() {},
    updatePlanStepsWithEnvelope(steps, envelope) {
      return steps.map((step) => step.id === envelope.step_id
        ? {
            ...step,
            status: envelope.status === 'completed' ? 'completed' : 'failed',
            evidence: (step.evidence || []).concat([envelope]),
            blockingReason: envelope.status === 'completed' ? '' : String(envelope.unsatisfiedRequirement || envelope.result || '')
          }
        : step);
    },
    getPolicy() {
      return {};
    },
    isSideEffectPolicy() {
      return false;
    },
    async executeBatch(steps) {
      executeBatchCalls += 1;
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
    rebuildFinalPlanFromSteps(nextState) {
      return { steps: nextState.plan.steps };
    },
    buildExecLogsFromSteps(steps) {
      return steps.map((step) => ({
        id: step.id,
        action: step.tool,
        ok: step.status === 'completed',
        result: (step.evidence || [])[0]?.result || '',
        error: step.blockingReason || '',
        unsatisfiedRequirement: step.blockingReason || '',
        args: step.inputs || {}
      }));
    },
    mergeAllowedToolsWithMemoryCli(allowed) {
      return allowed || [];
    },
    saveAndEmit(state) {
      return state;
    },
    config: {
      PLAN_MAX_STEPS: 5
    }
  });

  const result = await dispatchNode({
    request: {
      question: 'fetch from unresolved search result',
      allowedTools: ['web_search', 'web_fetch'],
      allowTools: true
    },
    plan: {
      steps: [
        {
          id: 'planner_step_1',
          kind: 'tool',
          tool: 'web_search',
          inputs: { query: 'bad previous result' },
          status: 'completed',
          evidence: [{
            status: 'completed',
            result: 'No usable URL here'
          }]
        },
        {
          id: 'planner_step_2',
          kind: 'tool',
          tool: 'web_fetch',
          inputs: { url: '' },
          status: 'pending',
          runtimeBinding: {
            type: 'best_url_from_previous_search',
            sourceStepId: 'planner_step_1',
            targetArg: 'url'
          },
          evidence: []
        },
        {
          id: 'planner_step_3',
          kind: 'tool',
          tool: 'web_search',
          inputs: { query: 'OpenAI' },
          status: 'pending',
          evidence: []
        }
      ]
    },
    execution: {
      retryQueue: [],
      memoryCliTurn: {},
      toolResults: []
    },
    memory: {
      dirty: false
    },
    output: {}
  });

  const failedFetch = result.plan.steps.find((step) => step.id === 'planner_step_2');
  const completedSearch = result.plan.steps.find((step) => step.id === 'planner_step_3');

  assert.strictEqual(executeBatchCalls, 1, 'parallel batch should still run runnable steps');
  assert.strictEqual(failedFetch.status, 'failed');
  assert.strictEqual(failedFetch.evidence.length, 1);
  assert.strictEqual(failedFetch.evidence[0].unsatisfiedRequirement, 'runtime_binding_unresolved:web_fetch_url');
  assert.match(failedFetch.evidence[0].result, /runtime_binding_unresolved:web_fetch_url/);
  assert.strictEqual(completedSearch.status, 'completed');
  assert.strictEqual(result.plan.status, 'dispatch_partial');

  console.log('dispatchRuntimeBindingParallel.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
