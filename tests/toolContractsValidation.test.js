const assert = require('assert');

const {
  buildToolEvidenceBundle,
  normalizeExecutionEnvelope,
  validatePlannerExecutionPlan
} = require('../api/runtimeV2/contracts');
const {
  buildInitialPlanSlice
} = require('../api/runtimeV2/state');

module.exports = (() => {
  const valid = validatePlannerExecutionPlan({
    steps: [
      {
        id: 'planner_step_1',
        tool: 'web_search',
        args: { query: 'OpenAI docs' },
        purpose: 'Find official docs'
      },
      {
        id: 'planner_step_2',
        tool: 'web_fetch',
        args: { url: '' },
        dependsOn: ['planner_step_1'],
        purpose: 'Fetch the selected result'
      }
    ]
  }, { allowedTools: ['web_search', 'web_fetch'] });

  assert.strictEqual(valid.ok, true);
  assert.strictEqual(valid.steps.length, 2);
  assert.strictEqual(valid.steps[0].tool, 'web_search');
  assert.strictEqual(valid.steps[1].dependsOn[0], 'planner_step_1');

  const invalidTool = validatePlannerExecutionPlan({
    steps: [{
      id: 'bad_step',
      tool: 'not_allowed',
      args: {}
    }]
  }, { allowedTools: ['web_search'] });
  assert.strictEqual(invalidTool.ok, false);
  assert.ok(invalidTool.reasons.some((item) => item.code === 'tool_not_allowed'));

  const emptyAllowlistTool = validatePlannerExecutionPlan({
    steps: [{
      id: 'blocked_empty_allowlist',
      tool: 'web_search',
      args: {}
    }]
  }, { allowedTools: [] });
  assert.strictEqual(emptyAllowlistTool.ok, false);
  assert.ok(emptyAllowlistTool.reasons.some((item) => item.code === 'tool_not_allowed'));

  const invalidArgs = validatePlannerExecutionPlan({
    steps: [{
      id: 'bad_args',
      tool: 'web_search',
      args: 'query=OpenAI'
    }]
  }, { allowedTools: ['web_search'] });
  assert.strictEqual(invalidArgs.ok, false);
  assert.ok(invalidArgs.reasons.some((item) => item.code === 'invalid_args'));

  const invalidAllowedToolNames = validatePlannerExecutionPlan({
    allowedToolNames: ['web_search', 'not_allowed'],
    steps: [{
      id: 'ok_step',
      tool: 'web_search',
      args: {}
    }]
  }, { allowedTools: ['web_search'] });
  assert.strictEqual(invalidAllowedToolNames.ok, false);
  assert.ok(invalidAllowedToolNames.reasons.some((item) => item.code === 'allowed_tool_not_allowed'));

  const invalidDependsOn = validatePlannerExecutionPlan({
    steps: [{
      id: 'bad_depends',
      tool: 'web_search',
      args: {},
      dependsOn: 'planner_step_1'
    }]
  }, { allowedTools: ['web_search'] });
  assert.strictEqual(invalidDependsOn.ok, false);
  assert.ok(invalidDependsOn.reasons.some((item) => item.code === 'invalid_depends_on'));

  const cycle = validatePlannerExecutionPlan({
    steps: [
      {
        id: 'a',
        tool: 'web_search',
        args: {},
        dependsOn: ['b']
      },
      {
        id: 'b',
        tool: 'web_fetch',
        args: {},
        dependsOn: ['a']
      }
    ]
  }, { allowedTools: ['web_search', 'web_fetch'] });
  assert.strictEqual(cycle.ok, false);
  assert.ok(cycle.reasons.some((item) => item.code === 'depends_on_cycle'));

  const initial = buildInitialPlanSlice({
    question: 'search',
    routeMeta: {
      toolPlanner: {
        executionPlan: {
          steps: [{
            id: 'bad_step',
            tool: 'forbidden_tool',
            args: {}
          }]
        }
      }
    },
    allowedTools: ['web_search']
  }, {
    getToolPlannerExecutionPlan(routeMeta) {
      return routeMeta.toolPlanner.executionPlan;
    }
  });

  assert.strictEqual(initial.status, 'idle');
  assert.strictEqual(initial.steps.length, 0);
  assert.strictEqual(initial.finalPlan.need_tools, false);
  assert.strictEqual(initial.planner.validation.ok, false);
  assert.strictEqual(initial.planner.validation.status, 'planner_invalid');

  const envelope = normalizeExecutionEnvelope({
    step_id: 'planner_step_1',
    tool_name: 'web_search',
    status: 'completed',
    result: 'x'.repeat(1400),
    args: { query: 'OpenAI docs' }
  }, { id: 'planner_step_1', tool: 'web_search', inputs: { query: 'OpenAI docs' } }, {
    stableHash: (value) => JSON.stringify(value || {}),
    resultMaxChars: 900,
    nowTs: () => 1000
  });

  assert.ok(envelope.tool_call_id);
  assert.strictEqual(envelope.args_hash, '{"query":"OpenAI docs"}');
  assert.strictEqual(envelope.duration_ms, 0);
  assert.strictEqual(envelope.source, 'dispatch');
  assert.ok(envelope.result.length < 1400);
  assert.match(envelope.result, /tool result truncated/);

  const bundle = buildToolEvidenceBundle({
    plan: {
      finalPlan: { goal: 'answer', need_tools: true, steps: [] },
      finalExecLogs: [],
      steps: [{
        id: 'planner_step_1',
        tool: 'web_search',
        inputs: { query: 'OpenAI docs' },
        status: 'completed',
        evidence: [envelope]
      }]
    },
    execution: {
      toolResults: [envelope]
    },
    memory: {
      globalToolEvidence: 'global evidence',
      globalToolResults: [{
        tool_name: 'global_search',
        result: 'preflight result'
      }]
    }
  }, {
    resultMaxChars: 900
  });

  assert.strictEqual(bundle.execLogs.length, 1);
  assert.strictEqual(bundle.toolMessages.length, 1);
  assert.strictEqual(bundle.toolMessages[0].role, 'tool');
  assert.strictEqual(bundle.assistantToolCallMessage.role, 'assistant');
  assert.strictEqual(bundle.assistantToolCallMessage.tool_calls.length, 1);
  assert.strictEqual(bundle.envelopes.length, 3);
  assert.ok(bundle.globalEvidence.length >= 1);

  console.log('toolContractsValidation.test.js passed');
})()
