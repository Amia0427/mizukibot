const assert = require('assert');

const { verifyExecutionResult, buildRepairPlan } = require('../utils/agentLoop');

module.exports = (async () => {
  const plan = {
    goal: '找官方文档并总结',
    steps: [
      {
        id: 'planner_step_1',
        action: 'web_search',
        args: { query: 'OpenAI docs' },
        purpose: 'search docs',
        evidenceRequirement: { type: 'search_results', minCount: 1, requireCompleted: true },
        repairPolicy: { strategy: 'retry_step', allowModelRepair: true }
      },
      {
        id: 'planner_step_2',
        action: 'web_fetch',
        args: { url: '' },
        purpose: 'fetch docs page',
        evidenceRequirement: { type: 'page_content', minCount: 1, requireCompleted: true },
        repairPolicy: { strategy: 'retry_step', allowModelRepair: true },
        runtimeBinding: { type: 'best_url_from_previous_search' }
      }
    ]
  };

  const verification = verifyExecutionResult({
    question: '找 OpenAI 官方 docs',
    plan,
    execLogs: [
      {
        id: 'planner_step_1',
        action: 'web_search',
        args: { query: 'OpenAI docs' },
        purpose: 'search docs',
        ok: true,
        result: '1. OpenAI Docs\nhttps://platform.openai.com/docs'
      },
      {
        id: 'planner_step_2',
        action: 'web_fetch',
        args: { url: '' },
        purpose: 'fetch docs page',
        ok: false,
        result: '',
        error: 'runtime_binding_unresolved:web_fetch_url',
        unsatisfiedRequirement: 'runtime_binding_unresolved:web_fetch_url'
      }
    ],
    round: 1,
    maxRounds: 3
  });

  assert.strictEqual(verification.done, false);
  assert.ok(Array.isArray(verification.step_statuses));
  assert.ok(Array.isArray(verification.unsatisfied_requirements));
  assert.ok(verification.unsatisfied_requirements.some((item) => item.error === 'runtime_binding_unresolved:web_fetch_url'));
  assert.ok(verification.retryable_steps.includes('planner_step_2'));
  assert.strictEqual(verification.goal_coverage.covered, false);
  assert.strictEqual(verification.repair_strategy.deterministicFirst, true);

  const repairPlan = buildRepairPlan({
    previousPlan: plan,
    verification,
    round: 1
  });

  assert.ok(repairPlan);
  assert.strictEqual(repairPlan.steps.length, 1);
  assert.strictEqual(repairPlan.steps[0].action, 'web_fetch');

  console.log('agentLoopV2.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
