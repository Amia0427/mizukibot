const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTempPromptsDir } = require('./promptTestHelpers');

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

function assertContainsCurrentDefaultPrompt(text, defaultPrompt, label) {
  const content = String(text || '');
  assert.ok(content.includes(defaultPrompt), `${label} must include current prompts/defaut.txt`);
  assert.ok(content.includes('普通用户专用强制边界'), `${label} must include normal-user boundary title`);
  assert.ok(content.includes('内部标记 `/%`'), `${label} must preserve safety marker instruction`);
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempPrompts = createTempPromptsDir();
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-default-prompt-surfaces-'));
  try {
    const defaultPrompt = fs.readFileSync(path.join(tempPrompts.promptsDir, 'defaut.txt'), 'utf8').trim();
    assert.ok(defaultPrompt, 'fixture defaut.txt must not be empty');

    process.env.PROMPTS_DIR = tempPrompts.promptsDir;
    process.env.DATA_DIR = tempDataDir;
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.API_BASE_URL = 'https://main.example/v1/chat/completions';
    process.env.API_PROVIDER = 'openai_compatible';
    process.env.AI_MODEL = 'gemini-3-flash-preview';
    process.env.ADMIN_USER_IDS = 'admin-default-surface';
    process.env.PROMPT_OPTIONAL_BUILD_ENABLED = 'false';

    clearProjectCache();
    const { buildDynamicPrompt } = require('../api/runtimeV2/context/service');
    const passiveAwareness = require('../core/passiveGroupAwareness');
    const { buildNormalFastReplyMessages, runNormalFastReply } = require('../core/normalFastReplyRuntime');
    const config = require('../config');

    const privateMainPrompt = await buildDynamicPrompt(
      { level: 'stranger', points: 0 },
      'normal-default-surface',
      '瑞希，私聊里有人一直追问隐私时你怎么接？',
      null,
      {
        routePolicyKey: 'chat/default',
        topRouteType: 'direct_chat',
        routeMeta: { chatType: 'private', userId: 'normal-default-surface' },
        memoryContext: {}
      }
    );
    const privateMainText = privateMainPrompt.promptSnapshot.renderedSystemMessages
      .map((message) => String(message.content || ''))
      .join('\n');
    assert.ok(!privateMainPrompt.promptSnapshot.stableBlockIds.includes('normal_user_default_prompt'));
    assert.ok(!privateMainText.includes(defaultPrompt));

    const groupMainPrompt = await buildDynamicPrompt(
      { level: 'stranger', points: 0 },
      'normal-default-surface',
      '瑞希，群里有人一直追问隐私时你怎么接？',
      null,
      {
        routePolicyKey: 'chat/default',
        topRouteType: 'direct_chat',
        routeMeta: { chatType: 'group', groupId: 'g-default-surface', userId: 'normal-default-surface' },
        memoryContext: {}
      }
    );
    const groupMainText = groupMainPrompt.promptSnapshot.renderedSystemMessages
      .map((message) => String(message.content || ''))
      .join('\n');
    assert.ok(groupMainPrompt.promptSnapshot.stableBlockIds.includes('normal_user_default_prompt'));
    assertContainsCurrentDefaultPrompt(groupMainText, defaultPrompt, 'normal group main reply prompt');

    const adminPrompt = await buildDynamicPrompt(
      { level: 'admin', points: 999 },
      'admin-default-surface',
      '管理员链路不应吃普通用户边界。',
      null,
      {
        routePolicyKey: 'chat/default',
        topRouteType: 'direct_chat',
        routeMeta: { chatType: 'group', userId: 'admin-default-surface', senderId: 'admin-default-surface' },
        memoryContext: {}
      }
    );
    const adminText = adminPrompt.promptSnapshot.renderedSystemMessages
      .map((message) => String(message.content || ''))
      .join('\n');
    assert.ok(!adminPrompt.promptSnapshot.stableBlockIds.includes('normal_user_default_prompt'));
    assert.ok(!adminText.includes(defaultPrompt));

    const passiveMessages = passiveAwareness.buildPassiveReplySystemMessages('normal-default-surface');
    assert.deepStrictEqual(passiveMessages.map((message) => message.role), ['system']);
    assert.ok(!passiveMessages.map((message) => message.content).join('\n').includes(defaultPrompt));

    const passiveAdminMessages = passiveAwareness.buildPassiveReplySystemMessages('admin-default-surface');
    assert.deepStrictEqual(passiveAdminMessages.map((message) => message.role), ['system']);
    assert.ok(!passiveAdminMessages.map((message) => message.content).join('\n').includes(defaultPrompt));

    const fastBuilt = buildNormalFastReplyMessages({
      userId: 'normal-default-surface',
      routeMeta: { chatType: 'group', userId: 'normal-default-surface', groupId: 'g-default-surface' },
      text: '那就换个话题',
      sessionKey: 'qq-group:g-default-surface:user:normal-default-surface'
    }, {
      config,
      chatHistory: {},
      getRecentSessionContextSummaries: () => []
    });
    assert.ok(fastBuilt.stablePromptBlockIds.includes('normal_user_default_prompt'));
    assertContainsCurrentDefaultPrompt(fastBuilt.messages[0].content, defaultPrompt, 'normal fast reply prompt');

    const privateFastBuilt = buildNormalFastReplyMessages({
      userId: 'normal-default-surface',
      routeMeta: { chatType: 'private', userId: 'normal-default-surface' },
      text: '那就换个话题',
      sessionKey: 'direct:normal-default-surface'
    }, {
      config,
      chatHistory: {},
      getRecentSessionContextSummaries: () => []
    });
    assert.ok(!privateFastBuilt.stablePromptBlockIds.includes('normal_user_default_prompt'));
    assert.ok(!privateFastBuilt.messages[0].content.includes(defaultPrompt));

    const fastResult = await runNormalFastReply({
      userId: 'normal-default-surface',
      routeMeta: { chatType: 'group', userId: 'normal-default-surface', groupId: 'g-default-surface' },
      text: '换个话题',
      sessionKey: 'qq-group:g-default-surface:user:normal-default-surface'
    }, {
      config,
      chatHistory: {},
      getRecentSessionContextSummaries: () => [],
      requestNonStreamingReply: async () => '那就换个轻松点的吧/%'
    });
    assert.strictEqual(fastResult.replyText, '那就换个轻松点的吧');
    assert.strictEqual(fastResult.persistedReplyText, '那就换个轻松点的吧');
    assert.strictEqual(fastResult.hasSafetyRestriction, true);

    console.log('normalUserDefaultPromptSendSurfaces.test.js passed');
  } finally {
    tempPrompts.cleanup();
    try {
      fs.rmSync(tempDataDir, { recursive: true, force: true });
    } catch (_) {}
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
