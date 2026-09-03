const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-guanxi-prompt-'));
process.env.DATA_DIR = tempRoot;
process.env.CONVERSATION_VARIABLES_ENABLED = 'true';
process.env.CONVERSATION_VARIABLES_PRIMARY_READ = 'true';
process.env.CONVERSATION_VARIABLES_DB_FILE = path.join(tempRoot, 'conversation_variables.sqlite');
process.env.ADMIN_USER_IDS = 'guanxi-admin';
process.env.PROMPTS_DIR = path.join(__dirname, '..', 'prompts');
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';

const variables = require('../utils/conversationVariables');
const {
  loadGuanxiStagePrompt,
  normalizePromptText,
  shouldInjectGuanxiPrompt,
  STAGE_PROMPT_FILES
} = require('../utils/guanxiPrompt');
const { composePersonaMemoryState, renderPersonaMemoryPrompt } = require('../utils/personaMemoryState');
const { buildBaseDynamicPrompt, buildDynamicPrompt } = require('../src/runtime-v2/context/render');
const { buildNormalFastReplyMessages } = require('../core/normalFastReplyRuntime');
const { createMessageSideEffects } = require('../core/messageSideEffects');
const { favorites, getUserAffinityState, getUserProfile, updateFavor } = require('../utils/memory');

const STAGE_VALUES = {
  stranger: { affection: 0, trust: 0, familiarity: 0 },
  acquaintance: { affection: 20, trust: 10, familiarity: 10 },
  friend: { affection: 50, trust: 40, familiarity: 30 },
  close: { affection: 75, trust: 65, familiarity: 55 },
  intimate_companion: { affection: 90, trust: 80, familiarity: 75 }
};

function setRelationship(userId, stage, now) {
  for (const [key, value] of Object.entries(STAGE_VALUES[stage])) {
    variables.setOverride({
      scopeType: 'user',
      scopeId: userId,
      key,
      value,
      locked: true,
      reason: `guanxi test: ${stage}`,
      actorId: 'guanxi-test',
      now,
      eventKey: `guanxi-test:${userId}:${stage}:${key}:${now}`
    });
  }
}

function getMessagesText(messages = []) {
  return messages.map((message) => String(message?.content || '')).join('\n');
}

function buildBaseOptions(userId) {
  return {
    routePolicyKey: 'chat/default',
    topRouteType: 'direct_chat',
    routeMeta: { userId, chatType: 'private' },
    sharedShortTermContext: {
      recentHistory: [],
      shortTermSummary: '',
      sharedShortTermSignature: ''
    },
    memoryContext: { segments: {}, summary: 'none' },
    resolvePersonaModules: false,
    includeDynamicFewShotBlock: false,
    promptsDir: process.env.PROMPTS_DIR
  };
}

function buildFastConfig() {
  return {
    AI_MODEL: 'gemini-3-flash-preview',
    ADMIN_USER_IDS: ['guanxi-admin'],
    NORMAL_FAST_REPLY_RECENT_TURNS: 12,
    NORMAL_FAST_REPLY_CONTEXT_MAX_CHARS: 8000,
    NORMAL_FAST_REPLY_SUMMARY_MAX_CHARS: 1500,
    NORMAL_FAST_REPLY_MAX_TOKENS: 1024,
    NORMAL_FAST_REPLY_PERSONA_MODULE_MAX_ACTIVE: 2,
    NORMAL_FAST_REPLY_PERSONA_MODULE_MAX_TOKEN_COST: 100,
    NORMAL_FAST_REPLY_PERSONA_MODULE_TEXT_MAX_CHARS: 700,
    NORMAL_FAST_REPLY_WORLDBOOK_ENABLED: false,
    SYSTEM_PROMPT_BLOCKS: []
  };
}

function assertOnlyStageText(text, stage) {
  assert.ok(text.includes(`阶段${{ stranger: '一', acquaintance: '二', friend: '三', close: '四', intimate_companion: '五' }[stage]}：`));
  for (const otherStage of Object.keys(STAGE_PROMPT_FILES)) {
    if (otherStage === stage) continue;
    const numeral = { stranger: '一', acquaintance: '二', friend: '三', close: '四', intimate_companion: '五' }[otherStage];
    assert.ok(!text.includes(`阶段${numeral}：`), `${stage} 不应包含 ${otherStage} 的完整阶段标题`);
  }
  assert.ok(!/[（(]\s*\d+\s*[–—-]\s*\d+\s*[）)]/.test(text), `${stage} 不应暴露阶段分数区间`);
}

module.exports = (async () => {
  variables.resetDbForTests();

  const loadedStages = {};
  for (const stage of Object.keys(STAGE_PROMPT_FILES)) {
    const loaded = loadGuanxiStagePrompt({ relationship: { stage } });
    assert.ok(loaded, `${stage} 应能读取阶段文件`);
    assert.strictEqual(loaded.fileName, STAGE_PROMPT_FILES[stage]);
    assert.strictEqual(loaded.source, `guanxi/${STAGE_PROMPT_FILES[stage]}`);
    assertOnlyStageText(loaded.text, stage);
    loadedStages[stage] = loaded.text;
  }
  assert.strictEqual(loadGuanxiStagePrompt({ relationship: { stage: 'unknown' } }).stage, 'stranger');
  assert.ok(!loadedStages.stranger.includes('家里人的期待'));
  assert.ok(!loadedStages.acquaintance.includes('家里人的期待'));
  assert.ok(loadedStages.friend.includes('25时'));
  assert.ok(loadedStages.close.includes('25时'));
  assert.ok(loadedStages.intimate_companion.includes('25时'));
  assert.strictEqual(normalizePromptText('标题（0–20）\n\n\n正文'), '标题\n\n正文');

  assert.strictEqual(shouldInjectGuanxiPrompt({ surface: 'direct_chat' }), true);
  assert.strictEqual(shouldInjectGuanxiPrompt({ surface: 'private_chat' }), true);
  assert.strictEqual(shouldInjectGuanxiPrompt({ surface: 'group_direct_chat' }), true);
  assert.strictEqual(shouldInjectGuanxiPrompt({ surface: 'direct_chat', isAdmin: true }), false);
  assert.strictEqual(shouldInjectGuanxiPrompt({ surface: 'qzone_diary' }), false);
  assert.strictEqual(shouldInjectGuanxiPrompt({ surface: 'passive_reply' }), false);
  assert.strictEqual(shouldInjectGuanxiPrompt({ surface: 'tool_call' }), false);

  const userId = 'guanxi-user';
  setRelationship(userId, 'stranger', 1000);
  const firstFormal = await buildBaseDynamicPrompt(
    { level: 'stranger' },
    userId,
    '你好',
    null,
    buildBaseOptions(userId)
  );
  assert.strictEqual(firstFormal.personaMemoryState.guanxiStage.stage, 'stranger');
  const firstFormalText = getMessagesText(firstFormal.promptSegments.systemPrompt);
  assert.ok(firstFormalText.includes('[GuanxiStage]'));
  assert.strictEqual((firstFormalText.match(/\[GuanxiStage\]/g) || []).length, 1);
  assert.ok(firstFormalText.includes('阶段一：初次认识的网友'));
  assert.ok(!firstFormalText.includes('阶段三：密友'));

  setRelationship(userId, 'friend', 2000);
  const secondFormal = await buildBaseDynamicPrompt(
    { level: 'friend' },
    userId,
    '继续聊聊',
    null,
    buildBaseOptions(userId)
  );
  assert.strictEqual(secondFormal.personaMemoryState.guanxiStage.stage, 'friend');
  const secondFormalText = getMessagesText(secondFormal.promptSegments.systemPrompt);
  assert.ok(secondFormalText.includes('阶段三：密友'));
  assert.ok(secondFormalText.includes('25时'));
  assert.ok(!secondFormalText.includes('阶段一：初次认识的网友'));
  assert.ok(!secondFormalText.includes('阶段四：无话不谈的闺蜜/兄弟'));

  const staleMemoryContext = {
    affinityState: { relationship: 'playful_affection', attitude: '过期关系' },
    profile: { relation_stage: '初识' },
    persona: {},
    segments: {},
    summary: 'none',
    memoryForPrompt: 'none'
  };
  const fullFormal = await buildDynamicPrompt(
    { level: '初识', points: -2, relationship: 'playful_affection' },
    userId,
    '继续聊聊',
    null,
    {
      ...buildBaseOptions(userId),
      memoryContext: staleMemoryContext,
      includeOptionalContextBlocks: false
    }
  );
  const fullFormalText = getMessagesText(fullFormal.promptSegments.systemPrompt);
  assert.ok(fullFormalText.includes('[GuanxiStage]'));
  assert.ok(fullFormalText.includes('阶段三：密友'));
  assert.ok(!fullFormalText.includes('[Affinity] 初识'));
  assert.ok(!fullFormalText.includes('[AffinityPoints] -2'));
  assert.ok(!fullFormalText.includes('playful_affection'));
  assert.ok(!fullFormalText.includes('relationship_state=playful_affection'));

  favorites[userId] = { points: -2, level: '陌生人', relationship: 'playful_affection' };
  assert.strictEqual(getUserAffinityState(userId).level, '普通朋友');
  assert.strictEqual(getUserProfile(userId).relation_stage, '普通朋友');
  const sideEffects = createMessageSideEffects({
    config: { PASSIVE_AWARENESS_CONTEXT_SIZE: 4 },
    updateFavor,
    getUserAffinityState,
    saveData: () => {},
    recordMemoryScope: () => {},
    appendGroupMessage: () => {},
    recordSocialHumanGroupMessage: () => {},
    recordStyleHumanGroupMessage: () => {},
    maybeSendMemeFollowup: async () => {}
  });
  assert.strictEqual(sideEffects.updateUserPresence(userId, '继续聊聊', '').level, '普通朋友');

  const directState = await composePersonaMemoryState({
    userId,
    question: '日常聊天',
    routeMeta: { chatType: 'private' }
  }, {
    surface: 'qzone_diary',
    memoryContext: {},
    promptsDir: process.env.PROMPTS_DIR
  });
  assert.strictEqual(directState.guanxiStage, null);
  const nonMainText = getMessagesText(renderPersonaMemoryPrompt(directState, 'qzone_diary').systemMessages);
  assert.ok(!nonMainText.includes('[GuanxiStage]'));

  setRelationship('guanxi-admin', 'intimate_companion', 3000);
  const adminFormal = await buildBaseDynamicPrompt(
    { level: 'intimate_companion' },
    'guanxi-admin',
    '管理员检查',
    null,
    buildBaseOptions('guanxi-admin')
  );
  assert.strictEqual(adminFormal.personaMemoryState.guanxiStage, null);
  assert.ok(!getMessagesText(adminFormal.promptSegments.systemPrompt).includes('[GuanxiStage]'));

  setRelationship(userId, 'acquaintance', 4000);
  const fastAcquaintance = buildNormalFastReplyMessages({
    userId,
    routeMeta: { userId, chatType: 'private' },
    text: '今天聊点什么',
    sessionKey: 'direct:guanxi-user'
  }, {
    config: buildFastConfig(),
    chatHistory: {},
    getRecentSessionContextSummaries: () => []
  });
  const fastAcquaintanceText = getMessagesText(fastAcquaintance.messages);
  assert.ok(fastAcquaintanceText.includes('阶段二：相熟的朋友'));
  assert.ok(!fastAcquaintanceText.includes('阶段三：密友'));
  assert.ok(!fastAcquaintanceText.includes('25时'));

  setRelationship(userId, 'close', 5000);
  const fastClose = buildNormalFastReplyMessages({
    userId,
    routeMeta: { userId, chatType: 'private' },
    text: '今天聊点什么',
    sessionKey: 'direct:guanxi-user'
  }, {
    config: buildFastConfig(),
    chatHistory: {},
    getRecentSessionContextSummaries: () => []
  });
  const fastCloseText = getMessagesText(fastClose.messages);
  assert.ok(fastCloseText.includes('阶段四：无话不谈的闺蜜/兄弟'));
  assert.ok(fastCloseText.includes('25时'));
  assert.ok(!fastCloseText.includes('阶段五：最好的朋友'));

  const fastAdmin = buildNormalFastReplyMessages({
    userId: 'guanxi-admin',
    routeMeta: { userId: 'guanxi-admin', chatType: 'private', isAdmin: true },
    text: '管理员检查',
    sessionKey: 'direct:guanxi-admin'
  }, {
    config: buildFastConfig(),
    chatHistory: {},
    getRecentSessionContextSummaries: () => []
  });
  assert.ok(!getMessagesText(fastAdmin.messages).includes('[GuanxiStage]'));

  variables.closeDb();
  console.log('guanxiPrompt.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
