const assert = require('assert');

const {
  resolveShortTermSceneKey,
  applyPersonaContinuityDelta,
  defaultShortTermState
} = require('../utils/shortTermMemory');
const { composePersonaMemoryState } = require('../utils/personaMemoryState');

module.exports = (async () => {
  const routeMeta = {
    groupId: 'g_scene',
    directedContext: {
      scene: 'reply_to_user',
      addressee: { senderName: 'A', userId: 'user_a', kind: 'user' }
    }
  };
  const sceneKey = resolveShortTermSceneKey(routeMeta);
  const sessionKey = 'qq-group:g_scene:user:u_scene';
  const shortTermMemory = {};

  shortTermMemory[sceneKey] = applyPersonaContinuityDelta(defaultShortTermState(), {
    scene: {
      sceneKey,
      activeTopic: '群里部署',
      atmosphere: '直接',
      jargonHints: ['systemd', '直接说']
    },
    expression: {
      replyPosture: 'light',
      styleAnchors: ['轻一点接话']
    }
  });

  shortTermMemory[sessionKey] = applyPersonaContinuityDelta(defaultShortTermState(), {
    activeTopic: '部署',
    interaction: {
      activeTopic: '部署',
      carryOverUserTurn: '继续刚才那台机器',
      openLoops: ['补充 systemd'],
      assistantCommitments: ['给出命令']
    },
    expression: {
      replyPosture: 'focused',
      styleAnchors: ['先给结论']
    }
  });

  const state = await composePersonaMemoryState({
    userId: 'u_scene',
    question: '那个部署坑你还记得吧',
    sessionKey,
    routeMeta
  }, {
    surface: 'passive_group_reply',
    shortTermMemory,
    chatHistory: {}
  });

  assert.strictEqual(state.sceneKey, sceneKey);
  assert.ok(['群里部署', '部署'].includes(state.continuityState.sceneTopic || state.continuityState.activeTopic));
  assert.ok(state.continuityState.replyPosture);
  assert.ok(Array.isArray(state.continuityState.styleAnchors));

  console.log('passiveSceneContinuity.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
