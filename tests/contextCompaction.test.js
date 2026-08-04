const assert = require('assert');

const { buildContextCompactionPlan } = require('../utils/contextCompaction');

(() => {
  const evidence = 'tool evidence '.repeat(400);
  const plan = buildContextCompactionPlan({
    modelName: 'gpt-5.4',
    modelWindowTokens: 900,
    maxOutputTokens: 200,
    lowValueMaxChars: 240,
    segments: {
      system_prompt: [{ role: 'system', content: 'trusted system policy' }],
      current_user_turn: [{ role: 'user', content: 'question' }],
      tool_evidence: [{ role: 'assistant', content: evidence }]
    }
  });
  const toolSegment = plan.compactedSegments.find((segment) => segment.name === 'tool_evidence');
  if (toolSegment) {
    assert.ok(toolSegment.messages.length > 0);
    assert.ok(toolSegment.messages.every((message) => message.role === 'assistant'));
  }
  console.log('contextCompaction.test.js passed');
})();
