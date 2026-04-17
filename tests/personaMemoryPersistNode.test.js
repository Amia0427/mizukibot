const assert = require('assert');

const { createPersistNode } = require('../api/runtimeV2/nodes/persist');

module.exports = (async () => {
  const calls = [];
  const persistNode = createPersistNode({
    normalizeObject: (value, fallback = {}) => (value && typeof value === 'object' ? value : fallback),
    normalizeArray: (value) => (Array.isArray(value) ? value : []),
    createEvent: (type, payload = {}) => ({ type, ...payload }),
    isReviewMode: () => false,
    isChatLikeRoute: () => true,
    shouldAppendDailyJournalForV2: () => false,
    shouldQueueMemoryLearningForV2: () => false,
    shouldLearnSelfImprovement: () => false,
    appendShortTermHistory: () => {},
    persistShortTermBridgeSnapshot: () => {},
    appendMemoryEvent: async () => {},
    materializeMemoryViews: () => {},
    addProfileItem: () => {},
    pickRouteMetaForPostReplyJob: (meta) => meta,
    stableHash: () => 'dedupe',
    postReplyJobQueue: { enqueue() { return { enqueued: false, job: null }; } },
    saveAndEmit: (state) => state,
    config: { MEMORY_V3_ENABLED: true },
    chatHistory: {
      'direct:u_persist': [
        { role: 'user', content: '继续上次部署' },
        { role: 'assistant', content: '先给你命令' }
      ]
    },
    shortTermMemory: {
      'direct:u_persist': {
        summary: '在讨论部署',
        activeTopic: '部署',
        openLoops: ['补充 systemd'],
        assistantCommitments: ['给出命令'],
        userConstraints: ['先给结论'],
        carryOverUserTurn: '继续上次部署'
      }
    },
    recordPersonaMemoryOutcome: async (surface, payload) => {
      calls.push({ surface, payload });
      return { persisted: true, updatedSlots: { activeTopic: '部署' } };
    }
  });

  const state = {
    request: {
      userId: 'u_persist',
      sessionKey: 'direct:u_persist',
      question: '继续上次部署',
      routePolicyKey: 'direct_chat/default',
      topRouteType: 'direct_chat',
      routeMeta: {}
    },
    memory: {
      personaMemoryState: {
        surface: 'direct_chat',
        userId: 'u_persist',
        sessionKey: 'direct:u_persist',
        continuityState: {
          activeTopic: '部署',
          openLoops: ['补充 systemd'],
          assistantCommitments: ['给出命令'],
          userConstraints: ['先给结论'],
          carryOverUserTurn: '继续上次部署'
        },
        expressionState: {
          warmth: 'mid',
          playfulness: 'low',
          tease: 'off',
          initiative: 'reply',
          jargon: 'off',
          verbosity: 'normal',
          guardedness: 'guarded'
        }
      },
      continuityState: {
        payload: {
          active_topic: '部署',
          open_loops: ['补充 systemd'],
          assistant_commitments: ['给出命令'],
          user_constraints: ['先给结论'],
          carry_over_user_turn: '继续上次部署'
        }
      }
    },
    output: {
      finalReply: '先给你命令。',
      failure: false
    },
    thread: {
      sessionScope: {
        sessionKey: 'direct:u_persist',
        userId: 'u_persist'
      }
    },
    execution: {},
    plan: {}
  };

  await persistNode(state);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].surface, 'direct_chat');
  assert.strictEqual(calls[0].payload.state.continuityState.activeTopic, '部署');
  console.log('personaMemoryPersistNode.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
