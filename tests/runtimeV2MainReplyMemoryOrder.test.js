const assert = require('assert');

const { buildContextCompactionPlan, CANONICAL_SEGMENT_ORDER } = require('../utils/contextCompaction');

module.exports = async () => {
  const retrievedMemoryMessage = { role: 'system', content: '[RetrievedMemory]\n之前聊到 systemd 部署失败，下一步要先看日志。' };
  const taskMemoryMessage = { role: 'system', content: '[TaskMemory]\n当前任务：排查启动失败。' };
  const userTurnMessage = { role: 'user', content: '你还记得我们刚才聊到哪了吗？' };

  assert.ok(
    CANONICAL_SEGMENT_ORDER.indexOf('retrieved_memory') < CANONICAL_SEGMENT_ORDER.indexOf('current_user_turn'),
    'retrieved_memory should be ordered before current_user_turn'
  );
  assert.ok(
    CANONICAL_SEGMENT_ORDER.indexOf('task_memory') < CANONICAL_SEGMENT_ORDER.indexOf('current_user_turn'),
    'task_memory should be ordered before current_user_turn'
  );
  assert.ok(
    CANONICAL_SEGMENT_ORDER.indexOf('group_memory') < CANONICAL_SEGMENT_ORDER.indexOf('current_user_turn'),
    'group_memory should be ordered before current_user_turn'
  );

  const plan = buildContextCompactionPlan({
    modelName: 'gpt-5.4',
    modelWindowTokens: 8192,
    maxOutputTokens: 512,
    segments: {
      system_prompt: [{ role: 'system', content: '[System]\nreply naturally' }],
      continuity_state: [{ role: 'system', content: '[ContinuityState]\nactive_topic=部署排查' }],
      retrieved_memory: [retrievedMemoryMessage],
      task_memory: [taskMemoryMessage],
      current_user_turn: [userTurnMessage]
    },
    source: 'test'
  });

  const flattened = plan.compactedSegments.flatMap((segment) => segment.messages);
  const retrievedIndex = flattened.findIndex((message) => String(message.content || '').includes('[RetrievedMemory]'));
  const taskIndex = flattened.findIndex((message) => String(message.content || '').includes('[TaskMemory]'));
  const userIndex = flattened.findIndex((message) => String(message.content || '').includes('你还记得我们刚才聊到哪了吗'));

  assert.ok(retrievedIndex >= 0, 'retrieved memory message should remain in compacted plan');
  assert.ok(taskIndex >= 0, 'task memory message should remain in compacted plan');
  assert.ok(userIndex >= 0, 'user turn should remain in compacted plan');
  assert.ok(retrievedIndex < userIndex, 'retrieved memory should appear before user turn in flattened messages');
  assert.ok(taskIndex < userIndex, 'task memory should appear before user turn in flattened messages');

  console.log('runtimeV2MainReplyMemoryOrder.test.js passed');
};
