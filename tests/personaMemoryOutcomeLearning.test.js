const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-persona-outcome-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';

fs.mkdirSync(tempRoot, { recursive: true });

const personaMemoryState = require('../utils/personaMemoryState');
const { loadMemoryEvents } = require('../utils/memory-v3/events');

module.exports = (async () => {
  const result = await personaMemoryState.recordPersonaMemoryOutcome('direct_chat', {
    userId: 'u_learning',
    sessionKey: 'direct:u_learning',
    question: '你这样说更好，就保持这种直接一点的风格',
    finalReply: '那我之后尽量直接一点，先给结论。',
    request: {
      userId: 'u_learning',
      sessionKey: 'direct:u_learning',
      question: '你这样说更好，就保持这种直接一点的风格',
      routePolicyKey: 'direct_chat/default',
      topRouteType: 'direct_chat',
      routeMeta: {}
    },
    state: {
      userId: 'u_learning',
      sessionKey: 'direct:u_learning',
      continuityState: {
        activeTopic: '回复风格',
        openLoops: ['保持直接风格'],
        assistantCommitments: ['先给结论'],
        userConstraints: ['不要铺垫'],
        carryOverUserTurn: '保持直接风格',
        replyPosture: 'focused',
        styleAnchors: ['先给结论', '不要铺垫'],
        activePersonaModules: ['scene_private_chat'],
        phaseHint: 'phase2'
      },
      relationshipState: {
        relationship: '普通朋友',
        attitude: '自然接话',
        replyStylePolicy: '像熟人一样直接接话',
        distanceMode: 'friendly',
        salutationStyle: 'friendly'
      },
      expressionState: {
        replyPosture: { value: 'focused', source: 'continuity_state' },
        warmth: { value: 'mid', source: 'relationship_memory' },
        playfulness: { value: 'low', source: 'runtime_inference' },
        tease: { value: 'off', source: 'runtime_inference' },
        initiative: { value: 'reply', source: 'surface_policy' },
        jargon: { value: 'off', source: 'surface_policy' },
        verbosity: { value: 'terse', source: 'persona_memory' },
        guardedness: { value: 'guarded', source: 'persona_memory' }
      },
      evidence: {
        memoryContext: {
          persona: {
            botBasePersona: 'bot_persona_tone: 直接、结论先行',
            relationshipStyle: 'relationship_reply_style: 更像熟人聊天'
          }
        }
      }
    }
  });
  const recorded = loadMemoryEvents();

  assert.strictEqual(result.persisted, true);
  assert.ok(Array.isArray(result.updatedSlots.personaSlotsUpdated));
  assert.ok(Array.isArray(result.updatedSlots.relationshipSlotsUpdated));
  assert.ok(recorded.some((event) => event.type === 'session_checkpoint'));
  assert.ok(recorded.some((event) => event.memoryKind === 'bot_persona'));
  assert.ok(recorded.some((event) => event.memoryKind === 'relationship_style'));
  const checkpoint = recorded.find((event) => event.type === 'session_checkpoint');
  assert.ok(checkpoint?.payload?.expressionState?.replyPosture === 'focused');
  assert.ok(Array.isArray(checkpoint?.payload?.moduleState?.activePersonaModules));
  assert.ok(checkpoint?.payload?.interactionState?.phaseHint === 'phase2');
  console.log('personaMemoryOutcomeLearning.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
