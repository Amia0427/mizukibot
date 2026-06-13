const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function restoreEnv(snapshot = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

function writeRequiredPersonaFiles(personaDir) {
  fs.mkdirSync(personaDir, { recursive: true });
  for (const name of [
    '01_identity.txt',
    '02_style.txt',
    '03_boundaries.txt',
    '04_behavior.txt',
    '06_state_modulation.txt'
  ]) {
    fs.writeFileSync(path.join(personaDir, name), `persona-${name}`, 'utf8');
  }
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-local-prompt-recall-'));
  const promptsDir = path.join(tempRoot, 'prompts');
  const personaDir = path.join(promptsDir, 'persona');
  const modulesDir = path.join(promptsDir, 'persona_modules');
  const dbFile = path.join(tempRoot, 'data', 'local_prompt_recall.sqlite');

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = path.join(tempRoot, 'data');
    process.env.PROMPTS_DIR = promptsDir;
    process.env.LOCAL_PROMPT_RECALL_DB_FILE = dbFile;
    process.env.LOCAL_PROMPT_RECALL_ENABLED = 'true';
    process.env.MEMORY_EMBEDDING_ENABLED = 'false';
    writeRequiredPersonaFiles(personaDir);
    fs.mkdirSync(modulesDir, { recursive: true });
    fs.writeFileSync(path.join(personaDir, '05_examples.index.json'), JSON.stringify({
      version: 2,
      max_examples: 2,
      examples: [
        {
          id: 'semantic_care',
          priority: 10,
          match: { keywords_any: ['陪我'] },
          user: '今天有点撑不住，能陪我待一会吗？',
          assistant: '嗯，我在。先不用解释那么多，能呼吸一下就够了。'
        },
        {
          id: 'hot_drink',
          priority: 90,
          match: { keywords_any: ['热奶茶'] },
          user: '给你带了热奶茶。',
          assistant: '先放一下啦，猫舌真的会被烫到。'
        }
      ]
    }), 'utf8');
    fs.writeFileSync(path.join(modulesDir, 'care_light.txt'), '轻量关心，不追问，陪伴。', 'utf8');
    fs.writeFileSync(path.join(modulesDir, 'deep_pain.txt'), '深层疼痛，关系变味和说不出口。', 'utf8');
    fs.writeFileSync(path.join(modulesDir, 'daily_energy.txt'), '日常高能，主动带起聊天。', 'utf8');
    fs.writeFileSync(path.join(modulesDir, 'module-catalog.json'), JSON.stringify({
      version: 1,
      max_active_modules: 2,
      default_max_active_modules: 2,
      modules: [
        {
          id: 'core_baseline',
          path: 'persona_modules/core_baseline.txt',
          purpose: '基础补丁',
          triggerHints: ['always_on_core_patch'],
          tokenCost: 20,
          priority: 1,
          conflictsWith: [],
          phase: 'all',
          slot: 'core'
        },
        {
          id: 'care_light',
          path: 'persona_modules/care_light.txt',
          purpose: '轻量关心模式',
          triggerHints: ['陪我', '难受', '低落'],
          tokenCost: 40,
          priority: 20,
          conflictsWith: ['deep_pain'],
          phase: 'all',
          slot: 'emotion'
        },
        {
          id: 'deep_pain',
          path: 'persona_modules/deep_pain.txt',
          purpose: '深层疼痛模式',
          triggerHints: ['关系变味', '说不出口'],
          tokenCost: 60,
          priority: 30,
          conflictsWith: ['care_light'],
          phase: 'all',
          slot: 'emotion'
        },
        {
          id: 'daily_energy',
          path: 'persona_modules/daily_energy.txt',
          purpose: '日常带起聊天',
          triggerHints: ['闲聊'],
          tokenCost: 30,
          priority: 50,
          conflictsWith: [],
          phase: 'all',
          slot: 'energy'
        }
      ]
    }), 'utf8');
    clearProjectCache();

    const localPromptRecall = require('../utils/localPromptRecall');
    const personaModules = require('../utils/personaModules');
    const fewShotPrompts = require('../utils/fewShotPrompts');
    const normalFastReplyRuntime = require('../core/normalFastReplyRuntime');

    const rebuild = await localPromptRecall.rebuildLocalPromptRecallDb({
      dbFile,
      withEmbeddings: true,
      requestEmbedding: async (text) => String(text || '').includes('撑不住') || String(text || '').includes('轻量关心')
        ? [1, 0]
        : [0, 1]
    });
    assert.strictEqual(rebuild.ok, true);
    assert.strictEqual(rebuild.examples, 2);
    assert.strictEqual(rebuild.modules, 3, 'core_baseline should not be indexed as a dynamic module');
    assert.strictEqual(rebuild.embedded, 5);

    const lexical = localPromptRecall.recallFewShotExamplesSync({
      question: '热奶茶有点烫',
      routePolicyKey: 'chat/default',
      topRouteType: 'chat'
    }, { dbFile, limit: 1 });
    assert.strictEqual(lexical.ok, true);
    assert.strictEqual(lexical.examples[0].id, 'hot_drink');

    const semantic = await localPromptRecall.recallFewShotExamples({
      question: '我现在快撑不住了，想有人安静陪一下',
      routePolicyKey: 'chat/default',
      topRouteType: 'chat'
    }, {
      dbFile,
      limit: 1,
      requestEmbedding: async () => [1, 0]
    });
    assert.strictEqual(semantic.ok, true);
    assert.strictEqual(semantic.usedEmbedding, true);
    assert.strictEqual(semantic.examples[0].id, 'semantic_care');

    const candidates = personaModules.buildPersonaModuleCandidates({
      question: '我有点难受，陪我一下就好',
      mainReplyPromptMode: 'balanced',
      disableLocalPromptRecall: false
    });
    assert.ok(candidates.some((item) => item.id === 'care_light'));
    assert.ok(candidates.some((item) => item.localPromptRecall));

    const selected = personaModules.selectPersonaModules({}, {
      question: '我有点难受，陪我一下就好',
      mainReplyPromptMode: 'balanced',
      personaModuleCandidates: candidates
    });
    assert.ok(selected.selected.some((item) => item.id === 'care_light'));
    assert.ok(!selected.selected.some((item) => item.id === 'deep_pain'), 'conflicting local modules should not both be selected');

    const { buildBaseDynamicPrompt } = require('../src/runtime-v2/context/render');
    const rendered = await buildBaseDynamicPrompt(
      { level: 'friend' },
      'u_prompt',
      '我有点难受，陪我一下就好',
      null,
      {
        routePolicyKey: 'chat/default',
        topRouteType: 'direct_chat',
        routeMeta: { chatType: 'private' },
        mainReplyPromptMode: 'balanced',
        promptMaterials: {
          userInfo: { level: 'friend' },
          userId: 'u_prompt',
          question: '我有点难受，陪我一下就好',
          routeMeta: { chatType: 'private' },
          routePolicyKey: 'chat/default',
          topRouteType: 'direct_chat',
          mainReplyPromptMode: 'balanced',
          affinity: { contextWindowTokens: 4000, shortTermMemoryTokens: 500 },
          sharedShortTermContext: {},
          memoryContext: { segments: {}, summary: 'none' },
          personaMemoryState: {},
          personaMemoryPrompt: { systemMessages: [] },
          personaModuleCandidates: candidates,
          personaModuleDecision: selected,
          dynamicPromptPlan: { plannerProvided: false, enabledBlockIds: [], personaModules: [] },
          summaryText: 'none',
          dynamicFewShotPrompt: ''
        }
      }
    );
    assert.ok(rendered.dynamicPromptPlan.personaModules.includes('care_light'));
    assert.ok(rendered.promptSnapshot.dynamicBlockIds.includes('persona_module_care_light'));

    const prompt = fewShotPrompts.buildDynamicFewShotPrompt({
      question: '热奶茶有点烫',
      routePolicyKey: 'chat/default',
      topRouteType: 'chat',
      maxExamples: 1,
      forceDynamicFewShot: true
    });
    assert.ok(prompt.includes('[示例:hot_drink]'));

    const fast = normalFastReplyRuntime.buildNormalFastReplyMessages({
      userId: 'u_fast',
      routeMeta: { userId: 'u_fast', chatType: 'private' },
      text: '我有点难受，陪我一下',
      sessionKey: 'direct:u_fast'
    }, {
      config: {
        NORMAL_FAST_REPLY_RECENT_TURNS: 12,
        NORMAL_FAST_REPLY_CONTEXT_MAX_CHARS: 8000,
        NORMAL_FAST_REPLY_SUMMARY_MAX_CHARS: 1500,
        NORMAL_FAST_REPLY_MAX_TOKENS: 1024,
        NORMAL_FAST_REPLY_PERSONA_MODULE_MAX_ACTIVE: 2,
        NORMAL_FAST_REPLY_PERSONA_MODULE_MAX_TOKEN_COST: 100,
        NORMAL_FAST_REPLY_PERSONA_MODULE_TEXT_MAX_CHARS: 700,
        NORMAL_FAST_REPLY_WORLDBOOK_ENABLED: true
      },
      chatHistory: {},
      getRecentSessionContextSummaries: () => []
    });
    assert.ok(fast.messages[0].content.includes('persona_module_care_light'), 'normal fast reply should load short local persona modules');
    assert.ok(fast.messages[0].content.includes('轻量关心'), 'normal fast reply should inject selected short module text');
    assert.ok(fast.personaModules.length > 0 && fast.personaModules.length <= 2, 'normal fast reply should cap short modules at 2');
    assert.ok(fast.personaModules.every((id) => !String(id).startsWith('wb_mizuki_')), 'normal fast reply should keep short persona modules separate from worldbook modules');
    assert.deepStrictEqual(fast.worldbookModules, [], 'normal fast reply should not load worldbook modules for non-worldbook questions');
    assert.ok(fast.personaModuleTokenCost <= 200, 'normal fast reply should keep module token cost light');

    console.log('localPromptRecall.test.js passed');
  } finally {
    try {
      require('../utils/localPromptRecall').closeDb();
    } catch (_) {}
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
