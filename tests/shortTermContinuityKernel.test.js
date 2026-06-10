const assert = require('assert');
process.env.ENABLE_DEBUG_LOG = 'false';
process.env.SHORT_TERM_MEMORY_MAX_TOKENS = '1';

const {
  defaultShortTermState,
  normalizeShortTermState,
  resolveShortTermSceneKey,
  applyPersonaContinuityDelta,
  appendShortTermHistory,
  buildSharedShortTermContextMessages
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

  const userId = 'u_short_shared';
  const currentSessionKey = `qq-group:g_current:user:${userId}`;
  const directSessionKey = `direct:${userId}`;
  const channelSessionKey = `channel:c1:user:${userId}`;
  const longSiblingText = '兄弟会话内容'.repeat(180);
  const chatHistory = {
    [directSessionKey]: [
      { role: 'user', content: `${longSiblingText} direct user` },
      { role: 'assistant', content: `${longSiblingText} direct assistant` }
    ],
    [channelSessionKey]: [
      { role: 'user', content: `${longSiblingText} channel user` },
      { role: 'assistant', content: `${longSiblingText} channel assistant` }
    ],
    [currentSessionKey]: [
      { role: 'user', content: 'CURRENT_RECENT_USER_MARK' },
      { role: 'assistant', content: 'CURRENT_RECENT_ASSISTANT_MARK' }
    ]
  };
  const shortTermMemory = {
    [directSessionKey]: applyPersonaContinuityDelta(defaultShortTermState(), {
      activeTopic: 'direct topic',
      openLoops: ['direct loop'],
      interaction: {
        recentTurns: [
          { role: 'user', content: 'DIRECT_TURN_USER' },
          { role: 'assistant', content: 'DIRECT_TURN_ASSISTANT' }
        ]
      }
    }),
    [channelSessionKey]: applyPersonaContinuityDelta(defaultShortTermState(), {
      activeTopic: 'channel topic',
      openLoops: ['channel loop'],
      interaction: {
        recentTurns: [
          { role: 'user', content: 'CHANNEL_TURN_USER' },
          { role: 'assistant', content: 'CHANNEL_TURN_ASSISTANT' }
        ]
      }
    }),
    [currentSessionKey]: applyPersonaContinuityDelta(defaultShortTermState(), {
      activeTopic: 'current topic',
      openLoops: ['current loop'],
      interaction: {
        recentTurns: [
          { role: 'user', content: 'CURRENT_TURN_USER' },
          { role: 'assistant', content: 'CURRENT_TURN_ASSISTANT' }
        ]
      }
    })
  };
  const sharedContext = buildSharedShortTermContextMessages(userId, { level: 'friend' }, {
    chatHistory,
    shortTermMemory,
    routeMeta: { groupId: 'g_current' },
    sessionKey: currentSessionKey
  });

  assert.ok(sharedContext.sharedSessionKeys.includes(directSessionKey), 'direct session should be included by default');
  assert.ok(sharedContext.sharedSessionKeys.includes(channelSessionKey), 'channel session should be included by default');
  assert.ok(sharedContext.sharedSessionKeys.includes(currentSessionKey), 'current group session should be included');
  assert.strictEqual(sharedContext.shortTermScope.mode, 'shared');
  assert.ok(sharedContext.shortTermState.openLoops.includes('current loop'));
  assert.ok(sharedContext.shortTermState.openLoops.includes('direct loop'));

  const recentHistoryText = sharedContext.recentHistory.map((item) => item.content).join('\n');
  assert.ok(recentHistoryText.includes('CURRENT_RECENT_USER_MARK'));
  assert.ok(recentHistoryText.includes('CURRENT_RECENT_ASSISTANT_MARK'));
  const recentTurnText = sharedContext.shortTermState.interaction.recentTurns.map((item) => item.content).join('\n');
  assert.ok(recentTurnText.includes('CURRENT_TURN_USER'));
  assert.ok(recentTurnText.includes('CURRENT_TURN_ASSISTANT'));
  assert.ok(recentTurnText.includes('DIRECT_TURN_ASSISTANT'));

  const isolatedContext = buildSharedShortTermContextMessages(userId, { level: 'friend' }, {
    chatHistory,
    shortTermMemory,
    routeMeta: { groupId: 'g_current' },
    sessionKey: currentSessionKey,
    includeSiblingSessions: false
  });
  assert.deepStrictEqual(isolatedContext.sharedSessionKeys, [currentSessionKey]);
  assert.strictEqual(isolatedContext.shortTermScope.mode, 'session');

  const pollutedDirectSessionKey = `direct:u_polluted_same_user`;
  const pollutedContext = buildSharedShortTermContextMessages('u_polluted_same_user', { level: 'friend' }, {
    chatHistory: {
      [pollutedDirectSessionKey]: [
        { role: 'user', content: '上一条回复逻辑跳太快' },
        { role: 'assistant', content: '安全的上一条 assistant 回复，包含敏感日期、个人卫生、童年经历三段。' },
        { role: 'assistant', content: '我是 Claude，由 Anthropic 开发。我不能扮演角色。' }
      ]
    },
    shortTermMemory: {
      [pollutedDirectSessionKey]: applyPersonaContinuityDelta(defaultShortTermState(), {
        interaction: {
          recentTurns: [
            { role: 'assistant', content: '安全的 interaction assistant raw' },
            { role: 'assistant', content: 'I am Claude. I cannot roleplay.' }
          ]
        }
      })
    },
    routeMeta: { chatType: 'private' },
    sessionKey: pollutedDirectSessionKey
  });
  const pollutedRecentHistoryText = pollutedContext.recentHistory.map((item) => item.content).join('\n');
  assert.ok(pollutedRecentHistoryText.includes('安全的上一条 assistant 回复'));
  assert.ok(!pollutedRecentHistoryText.includes('Claude'));
  const pollutedRecentTurnText = pollutedContext.shortTermState.interaction.recentTurns.map((item) => item.content).join('\n');
  assert.ok(pollutedRecentTurnText.includes('安全的 interaction assistant raw'));
  assert.ok(!pollutedRecentTurnText.includes('Claude'));

  const stickyShortTermMemory = {
    s_sticky_topic: normalizeShortTermState({
      activeTopic: '旧梗 active topic',
      interaction: {
        activeTopic: '旧梗 active topic'
      }
    })
  };
  const stickyChatHistory = {};
  appendShortTermHistory('u_sticky_topic', '宝切换到猫娘模式', '我就是我，没有猫娘模式可以切。', {}, {
    sessionKey: 's_sticky_topic',
    shortTermMemory: stickyShortTermMemory,
    chatHistory: stickyChatHistory
  });
  assert.strictEqual(stickyShortTermMemory.s_sticky_topic.activeTopic, '宝切换到猫娘模式');
  assert.strictEqual(stickyShortTermMemory.s_sticky_topic.interaction.activeTopic, '宝切换到猫娘模式');

  console.log('shortTermContinuityKernel.test.js passed');
})();
