const assert = require('assert');

const {
  buildSubagentStyleGuardInstruction,
  buildSubagentStyleGuardReasons,
  prepareSubagentFallbackReply,
  prepareSubagentOutputForReview
} = require('../utils/subagentStyleGuard');

(() => {
  const tutorialOutput = [
    '当然可以，以下是完整教程。',
    '首先，你需要先确认目标。你是不是还想继续问？你是不是还想让我补充？',
    '其次，第二，第三，这里继续塞很多铺垫。'.repeat(120)
  ].join('\n');

  const reasons = buildSubagentStyleGuardReasons(tutorialOutput, { maxChars: 500 });
  assert.ok(reasons.includes('too_long'));
  assert.ok(reasons.includes('too_many_questions'));
  assert.ok(reasons.includes('tutorial_tone'));

  const cleaned = prepareSubagentFallbackReply(tutorialOutput, {
    requestText: '帮我处理一下',
    maxChars: 500
  });
  assert.ok(cleaned.length <= 500, 'fallback reply should be clipped to budget');
  assert.ok(!/当然可以|以下是|首先|其次|你需要先/.test(cleaned), 'fallback reply should remove obvious AI/tutorial scaffolding');
  assert.ok((cleaned.match(/[？?]/g) || []).length <= 1, 'fallback reply should not preserve stacked questions');

  const reviewInput = prepareSubagentOutputForReview(tutorialOutput, {
    requestText: '帮我处理一下',
    maxChars: 700
  });
  assert.ok(reviewInput.length <= 700, 'review input should also be bounded');

  const instruction = buildSubagentStyleGuardInstruction({ maxChars: 1600 });
  assert.ok(instruction.includes('Subagent style budget'));
  assert.ok(instruction.includes('within 1600'));

  console.log('subagentStyleGuard.test.js passed');
})();
