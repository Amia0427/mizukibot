const assert = require('assert');

const {
  composePersonaMemoryState
} = require('../utils/personaMemoryState');

module.exports = (async () => {
  const shortTermMemory = {
    'direct:u_sticky': {
      schemaVersion: 2,
      activeTopic: '部署',
      carryOverUserTurn: '继续上次部署',
      interaction: {
        activeTopic: '部署',
        carryOverUserTurn: '继续上次部署',
        openLoops: ['补充 systemd'],
        assistantCommitments: ['给出命令'],
        userConstraints: ['先给结论'],
        phaseHint: 'phase2',
        confidence: 0.86
      },
      expression: {
        replyPosture: 'focused',
        warmth: 'mid',
        guardedness: 'guarded',
        initiative: 'reply',
        styleAnchors: ['先给结论', '直接一点'],
        confidence: 0.82
      },
      moduleState: {
        activePersonaModules: ['scene_private_chat'],
        stickyTurnsRemaining: 3,
        switchReason: 'new_activation',
        lastSurface: 'direct_chat',
        lastTopicFingerprint: 'seed'
      }
    }
  };

  const state = await composePersonaMemoryState({
    userId: 'u_sticky',
    question: '继续刚才那个部署问题，还是先给结论',
    sessionKey: 'direct:u_sticky',
    routeMeta: {}
  }, {
    surface: 'direct_chat',
    shortTermMemory,
    chatHistory: {}
  });

  assert.strictEqual(state.continuityState.replyPosture, 'focused');
  assert.ok(state.continuityState.styleAnchors.includes('先给结论'));
  assert.ok(state.moduleState.activePersonaModules.includes('scene_private_chat'));
  assert.ok(['sticky_continue', 'new_activation', 'requested_switch', 'topic_shift', 'surface_changed', 'explicit_positive_feedback', 'explicit_negative_feedback', ''].includes(state.moduleState.switchReason));

  console.log('personaContinuitySticky.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
