const assert = require('assert');

const {
  buildPlannerStageSystemPrompt,
  buildReviewStageSystemPrompt,
  buildRouterStageSystemPrompt
} = require('../utils/stagePromptContracts');

(() => {
  const planner = buildPlannerStageSystemPrompt([{ name: 'web_search', description: 'search web' }]);
  const review = buildReviewStageSystemPrompt();
  const router = buildRouterStageSystemPrompt();

  assert.ok(planner.includes('Do not imitate the full main persona.'));
  assert.ok(planner.includes('one pass'));
  assert.ok(review.includes('Preserve evidence'));
  assert.ok(router.includes('route classification'));
  assert.ok(planner.includes('[SecurityContract]'));
  assert.ok(review.includes('[SecurityContract]'));
  assert.ok(router.includes('[SecurityContract]'));
  console.log('promptStageContracts.test.js passed');
})();
