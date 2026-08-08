const assert = require('assert');
const {
  classifyVariableQuery,
  resolveVariableQueryReply
} = require('../utils/conversationVariables/query');

module.exports = (() => {
  assert.strictEqual(classifyVariableQuery('/关系'), 'relationship');
  assert.strictEqual(classifyVariableQuery('我们现在是什么关系？'), 'relationship');
  assert.strictEqual(classifyVariableQuery('你现在心情怎么样'), 'character');
  assert.strictEqual(classifyVariableQuery('帮我写一个关系数据库'), '');

  const snapshot = {
    relationship: {
      stage: 'friend',
      stageLabel: '普通朋友',
      boundaryMode: 'comfortable',
      attitude: '自然、友好'
    },
    character: { mood: 0, energy: 60, stress: 20, socialWillingness: 60 }
  };
  const privateReply = resolveVariableQueryReply({
    text: '/关系',
    privateChat: true,
    snapshot
  });
  assert.strictEqual(privateReply.handled, true);
  assert.ok(privateReply.replyText.includes('普通朋友'));
  assert.ok(!/\d/.test(privateReply.replyText));

  const groupReply = resolveVariableQueryReply({
    text: '/关系',
    privateChat: false,
    snapshot
  });
  assert.strictEqual(groupReply.handled, true);
  assert.ok(groupReply.replyText.includes('私聊'));

  console.log('conversationVariablesQuery.test.js passed');
})();
