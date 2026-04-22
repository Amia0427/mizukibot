const assert = require('assert');

const {
  defaultShortTermState,
  normalizeShortTermState,
  resolveShortTermSceneKey,
  applyPersonaContinuityDelta
} = require('../utils/shortTermMemory');

module.exports = (() => {
  const base = defaultShortTermState();
  const updated = applyPersonaContinuityDelta(base, {
    activeTopic: '部署',
    carryOverUserTurn: '继续上次部署',
    openLoops: ['补充 systemd'],
    assistantCommitments: ['给出命令'],
    userConstraints: ['先给结论'],
    phaseHint: 'phase2',
    sceneRef: 'qq-group:g1:scene',
    expression: {
      replyPosture: 'focused',
      warmth: 'mid',
      styleAnchors: ['先给结论', '直接一点'],
      confidence: 0.82
    },
    moduleState: {
      activePersonaModules: ['scene_private_chat'],
      stickyTurnsRemaining: 3,
      switchReason: 'new_activation'
    },
    scene: {
      sceneKey: 'qq-group:g1:scene',
      activeTopic: '群里部署',
      atmosphere: '直接'
    }
  });

  assert.strictEqual(updated.schemaVersion, 2);
  assert.strictEqual(updated.activeTopic, '部署');
  assert.strictEqual(updated.interaction.phaseHint, 'phase2');
  assert.strictEqual(updated.expression.replyPosture, 'focused');
  assert.ok(updated.expression.styleAnchors.includes('先给结论'));
  assert.ok(updated.moduleState.activePersonaModules.includes('scene_private_chat'));
  assert.strictEqual(updated.scene.sceneKey, 'qq-group:g1:scene');

  const normalized = normalizeShortTermState({
    activeTopic: '旧话题',
    expression: { replyPosture: 'playful' },
    moduleState: { activePersonaModules: ['daily_energy'] }
  });
  assert.strictEqual(normalized.expression.replyPosture, 'playful');
  assert.ok(normalized.moduleState.activePersonaModules.includes('daily_energy'));
  assert.strictEqual(resolveShortTermSceneKey({ groupId: 'g1' }), 'qq-group:g1:scene');

  console.log('shortTermContinuityKernel.test.js passed');
})();
