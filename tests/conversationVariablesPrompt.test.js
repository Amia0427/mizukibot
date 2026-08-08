const assert = require('assert');
const {
  buildVariablePromptContext,
  formatCharacterState,
  formatPublicRelationship
} = require('../utils/conversationVariables');
const { deriveCharacterExpressionState } = require('../utils/personaMemoryState/stateBuilders');

module.exports = (() => {
  const snapshot = {
    relationship: {
      stage: 'close',
      stageLabel: '亲近朋友',
      boundaryMode: 'comfortable',
      boundaryLabel: '相处自然',
      attitude: '愿意认真倾听',
      affection: 72,
      trust: 68,
      familiarity: 75,
      lastInteractionAt: 1_000
    },
    character: {
      mood: 35,
      energy: 30,
      stress: 70,
      socialWillingness: 45
    },
    asOf: 1_000 + 31 * 24 * 60 * 60 * 1000
  };

  const relationshipText = formatPublicRelationship(snapshot);
  assert.ok(relationshipText.includes('亲近朋友'));
  assert.ok(!/72|68|75|affection|trust|familiarity/i.test(relationshipText));

  const characterText = formatCharacterState(snapshot);
  assert.ok(characterText.includes('有点累'));
  assert.ok(!/35|30|70|45|mood|energy|stress/i.test(characterText));

  const prompt = buildVariablePromptContext(snapshot);
  assert.ok(prompt.includes('[关系与角色状态]'));
  assert.ok(prompt.includes('我们目前是亲近朋友'));
  assert.ok(prompt.includes('我现在'));
  assert.ok(prompt.includes('有一段时间没有联系'));
  assert.ok(!/72|68|75|35|30|70|45/.test(prompt));
  assert.ok(!/relationship_|character_state|ConversationVariables|scoring/.test(prompt));

  assert.deepStrictEqual(deriveCharacterExpressionState(snapshot.character), {
    warmth: 'low',
    initiative: 'reply',
    guardedness: 'guarded'
  });

  console.log('conversationVariablesPrompt.test.js passed');
})();
