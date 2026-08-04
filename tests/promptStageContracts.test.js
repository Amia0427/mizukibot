const assert = require('assert');

const {
  buildReviewStageSystemPrompt,
  buildRouterStageSystemPrompt
} = require('../utils/stagePromptContracts');

(() => {
  const review = buildReviewStageSystemPrompt();
  const router = buildRouterStageSystemPrompt();

  assert.ok(review.includes('Preserve evidence'));
  assert.ok(router.includes('route classification'));
  assert.ok(review.includes('[InternalIntegrity]'));
  assert.ok(router.includes('[InternalIntegrity]'));
  assert.ok(!review.includes('[SecurityContract]'));
  assert.ok(!router.includes('[SecurityContract]'));
  console.log('promptStageContracts.test.js passed');
})();
