const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-persona-memory-state-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';

fs.mkdirSync(tempRoot, { recursive: true });

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const {
  composePersonaMemoryState,
  renderPersonaMemoryPrompt,
  resolveContinuitySlots
} = require('../utils/personaMemoryState');

module.exports = (async () => {
  const resolved = resolveContinuitySlots({
    activeTopic: [
      { source: 'generic_recall', text: '旧话题', priority: 120, confidence: 0.5 },
      { source: 'short_term_bridge', text: '桥接话题', priority: 400, confidence: 0.8 },
      { source: 'session_projection', text: '当前会话话题', priority: 500, confidence: 0.9 }
    ],
    carryOver: [
      { source: 'short_term_bridge', text: '桥接遗留', priority: 400, confidence: 0.8 },
      { source: 'session_projection', text: '最新遗留', priority: 500, confidence: 0.9 }
    ],
    summary: [
      { source: 'same_session_summary', text: '旧摘要', priority: 300, confidence: 0.7 },
      { source: 'session_projection', text: '新摘要', priority: 500, confidence: 0.9 }
    ],
    openLoops: [
      { source: 'session_projection', text: '先修部署问题', priority: 500 },
      { source: 'generic_recall', text: '旧 open loop', priority: 120 }
    ],
    assistantCommitments: [
      { source: 'session_projection', text: '答应补排查步骤', priority: 500 }
    ],
    userConstraints: [
      { source: 'group_memory', text: '先给结论', priority: 160 }
    ]
  });
  assert.strictEqual(resolved.activeTopic, '当前会话话题');
  assert.strictEqual(resolved.carryOverUserTurn, '最新遗留');
  assert.strictEqual(resolved.summary, '新摘要');
  assert.ok(resolved.openLoops.includes('先修部署问题'));

  await appendMemoryEvent({
    type: 'session_checkpoint',
    userId: 'u_persona',
    sessionKey: 'qq-group:g1:user:u_persona',
    scopeType: 'session',
    source: 'test',
    payload: {
      snapshotType: 'post_reply',
      activeTopic: '部署',
      carryOverUserTurn: '上次还没回答部署步骤',
      summary: '在讨论 Linux 服务器部署',
      phaseHint: 'phase2',
      openLoops: ['补充 systemd 配置'],
      assistantCommitments: ['给出部署命令'],
      userConstraints: ['先给结论'],
      expressionState: {
        replyPosture: 'focused',
        styleAnchors: ['先给结论', '直接一点'],
        confidence: 0.86
      },
      moduleState: {
        activePersonaModules: ['scene_private_chat'],
        stickyTurnsRemaining: 3,
        switchReason: 'new_activation'
      },
      recentMessages: [
        { role: 'user', content: '继续上次部署问题' },
        { role: 'assistant', content: '我先给你结论' }
      ]
    }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_persona',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'style',
    text: 'style: 先给结论，再给步骤。',
    payload: { fieldKey: 'style_pattern', type: 'fact' }
  });
  await appendMemoryEvent({
    type: 'migration_bootstrap',
    userId: 'u_persona',
    groupId: 'g1',
    scopeType: 'personal',
    source: 'scope',
    sourceKind: 'migration',
    text: 'scope marker',
    payload: { type: 'fact' }
  });
  materializeMemoryViews();

  const state = await composePersonaMemoryState({
    userId: 'u_persona',
    question: '我们继续上次部署，顺便用群里的口吻说',
    sessionKey: 'qq-group:g1:user:u_persona',
    routeMeta: { groupId: 'g1' }
  }, {
    surface: 'direct_chat',
    groupId: 'g1'
  });

  assert.strictEqual(state.continuityState.activeTopic, '部署');
  assert.ok(state.continuityState.openLoops.includes('补充 systemd 配置'));
  assert.ok(String(state.continuityState.replyPosture || '').trim());
  assert.ok(state.continuityState.styleAnchors.includes('先给结论'));
  assert.ok(state.moduleState.activePersonaModules.includes('scene_private_chat'));
  assert.ok(String(state.expressionState.replyPosture.value || '').trim());
  assert.strictEqual(state.expressionState.jargon.value, 'group_only');
  assert.strictEqual(state.expressionState.jargon.source, 'surface_policy');
  assert.ok(renderPersonaMemoryPrompt(state, 'direct_chat').systemMessages.some((item) => item.content.includes('reply_posture=')));

  const rendered = renderPersonaMemoryPrompt(state, 'qzone_diary');
  const renderedText = rendered.systemMessages.map((item) => item.content).join('\n');
  assert.ok(renderedText.includes('[PersonaCore]'));
  assert.ok(renderedText.includes('[ExpressionPolicy]'));
  assert.ok(renderedText.includes('[SurfacePolicy]'));

  console.log('personaMemoryState.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
