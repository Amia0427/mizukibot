const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const legacyAiHost = require('../api/legacy/aiHost');
const { getStaticToolExecutors } = require('../api/toolRegistry');

module.exports = (async () => {
  assert.strictEqual(typeof legacyAiHost.executeToolCall, 'function');
  const executors = getStaticToolExecutors();
  const original = executors.create_scheduled_command;
  let executorCalls = 0;
  const boundaryCalls = [];
  executors.create_scheduled_command = async () => {
    executorCalls += 1;
    return 'legacy executor ok';
  };

  const executeAuthorizedToolCall = async (input) => {
    boundaryCalls.push(input);
    return {
      status: 'confirmation_required',
      executed: false,
      retryable: false,
      result: 'Tool authorization required: TA-LEGACY',
      authorization: {
        ticketId: 'TA-LEGACY',
        status: 'pending',
        toolName: input.toolName,
        confirmation: input.policy.confirmation
      }
    };
  };

  try {
    const planResult = await legacyAiHost.executeToolCall(
      'create_scheduled_command',
      { action: 'group_message', when: 'tomorrow 10:00', content: 'AAA' },
      {
        userId: 'user-1',
        routeMeta: { chatType: 'group', groupId: 'group-1' },
        allowedTools: ['create_scheduled_command'],
        taskId: 'task-1',
        planStepId: 'step-1',
        planRound: 2,
        executeAuthorizedToolCall
      }
    );
    assert.strictEqual(planResult, 'Tool authorization required: TA-LEGACY');
    assert.strictEqual(executorCalls, 0);
    assert.strictEqual(boundaryCalls[0].policy.confirmation, 'explicit');
    assert.strictEqual(boundaryCalls[0].actor.userId, 'user-1');
    assert.strictEqual(boundaryCalls[0].actor.chatType, 'group');
    assert.strictEqual(boundaryCalls[0].actor.groupId, 'group-1');
    assert.match(boundaryCalls[0].invocationKey, /task-1.*step-1.*2/);

    await legacyAiHost.executeToolCall(
      'create_scheduled_command',
      { action: 'group_message', when: 'tomorrow 11:00', content: 'BBB' },
      {
        userId: 'user-1',
        routeMeta: { chatType: 'private' },
        allowedTools: ['create_scheduled_command'],
        toolCallId: 'call-1',
        executeAuthorizedToolCall
      }
    );
    assert.strictEqual(executorCalls, 0);
    assert.strictEqual(boundaryCalls[1].actor.chatType, 'private');
    assert.strictEqual(boundaryCalls[1].actor.groupId, '');
    assert.match(boundaryCalls[1].invocationKey, /call-1/);
  } finally {
    executors.create_scheduled_command = original;
  }

  console.log('toolAuthorizationLegacy.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
