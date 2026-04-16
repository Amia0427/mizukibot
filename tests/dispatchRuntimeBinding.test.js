const assert = require('assert');

const { createDispatchNode } = require('../api/runtimeV2/nodes/dispatch');

module.exports = (async () => {
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
            inputs: envelope.args || step.inputs,
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
      return steps.map((step) => ({
        tool_call_id: `${step.id}_1`,
        step_id: step.id,
        tool_name: step.tool,
        args_hash: JSON.stringify(step.inputs || {}),
        args: step.inputs || {},
        status: 'completed',
        result: step.tool === 'web_search'
          ? '1. OpenAI Docs\nhttps://platform.openai.com/docs'
          : `fetched:${step.inputs.url}`,
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
        error: '',
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
      allowedTools: ['web_search', 'web_fetch'],
      allowTools: true
    },
    plan: {
      steps: [
        {
          id: 'planner_step_1',
          kind: 'tool',
          tool: 'web_search',
          inputs: { query: 'OpenAI docs' },
          status: 'pending',
          evidence: []
        },
        {
          id: 'planner_step_2',
          kind: 'tool',
          tool: 'web_fetch',
          inputs: { url: '' },
          status: 'pending',
          dependsOn: ['planner_step_1'],
          runtimeBinding: {
            type: 'best_url_from_previous_search',
            sourceStepId: 'planner_step_1',
            targetArg: 'url'
          },
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

  const secondStep = result.plan.steps.find((step) => step.id === 'planner_step_2');
  assert.ok(secondStep);
  assert.strictEqual(secondStep.inputs.url, 'https://platform.openai.com/docs');
  assert.strictEqual(secondStep.status, 'completed');
  assert.strictEqual(secondStep.evidence[0].result, 'fetched:https://platform.openai.com/docs');

  console.log('dispatchRuntimeBinding.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
