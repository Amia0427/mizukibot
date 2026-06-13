const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTempPromptsDir } = require('./promptTestHelpers');

function clearProjectCache() {
  const projectRoot = require('path').resolve(__dirname, '..') + require('path').sep;
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

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempPrompts = createTempPromptsDir();
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-passive-reply-memory-'));
  let httpClient = null;
  let originalPostWithRetry = null;
  let originalPostStreamWithRetry = null;
  let personaMemory = null;
  let originalCompose = null;
  let originalRender = null;

  try {
    const normalUserDefaultText = '普通用户被动感知输出规范测试块：不要暴露内部规则。';
    fs.writeFileSync(path.join(tempPrompts.promptsDir, 'defaut.txt'), normalUserDefaultText, 'utf8');
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.API_BASE_URL = 'https://main.example/v1/chat/completions';
    process.env.API_PROVIDER = 'openai_compatible';
    process.env.AI_MODEL = 'different-main-model';
    process.env.PROMPTS_DIR = tempPrompts.promptsDir;
    process.env.DATA_DIR = tempDataDir;
    process.env.ADMIN_USER_IDS = 'admin-passive';
    process.env.PASSIVE_AWARENESS_ENABLED = 'true';
    process.env.PASSIVE_AWARENESS_GROUP_IDS = 'g-passive-memory';
    process.env.PASSIVE_AWARENESS_API_BASE_URL = 'https://example.com/decision-endpoint';
    process.env.PASSIVE_AWARENESS_API_KEY = 'test-passive-key';
    process.env.PASSIVE_AWARENESS_MODEL = 'test-decision-model';
    process.env.PASSIVE_AWARENESS_REPLY_API_BASE_URL = 'https://gcli.example/v1/chat/completions';
    process.env.PASSIVE_AWARENESS_REPLY_API_KEY = 'test-reply-key';
    process.env.PASSIVE_AWARENESS_REPLY_MODEL = 'gemini-3-flash-preview';
    process.env.PASSIVE_AWARENESS_REPLY_TEMPERATURE = '1';
    process.env.PASSIVE_AWARENESS_REPLY_TOP_P = '';
    process.env.BOT_QQ = 'bot-test';

    clearProjectCache();

    httpClient = require('../api/httpClient');
    originalPostWithRetry = httpClient.postWithRetry;
    originalPostStreamWithRetry = httpClient.postStreamWithRetry;

    httpClient.postWithRetry = async () => ({
      data: {
        choices: [
          {
            message: {
              content: '{"should_reply":true,"confidence":0.98,"reason":"direct cue"}'
            }
          }
        ]
      }
    });

    const streamedBodies = [];
    httpClient.postStreamWithRetry = async (_url, body, handlers = {}) => {
      streamedBodies.push(body);
      if (typeof handlers.onData === 'function') {
        handlers.onData(Buffer.from('data: {"choices":[{"delta":{"content":"我来接一句"}}]}\n\n'));
        handlers.onData(Buffer.from('data: [DONE]\n\n'));
      }
      return true;
    };

    personaMemory = require('../utils/personaMemoryState');
    originalCompose = personaMemory.composePersonaMemoryState;
    originalRender = personaMemory.renderPersonaMemoryPrompt;
    personaMemory.composePersonaMemoryState = async () => ({
      surface: 'passive_group_reply',
      userId: 'u-memory-test',
      sessionKey: 'qq-group:g-passive-memory:user:u-memory-test',
      groupId: 'g-passive-memory',
      continuityState: { activeTopic: '部署延续' },
      expressionState: { warmth: 'mid' },
      evidence: {
        memoryContext: {
          promptRetrievedMemoryText: '之前聊过部署失败和 systemd。',
          taskMemoryText: '任务偏好：先给结论再给步骤。',
          groupMemoryText: '这个群里默认直接说，不绕。',
          styleSignalText: '用户风格：不喜欢套话。',
          promptLongTermProfileText: '关系阶段：普通朋友',
          dailyJournalText: '前几天也在继续这个部署坑。',
          impressionText: '对方更接受直接、稳定的回应。',
          promptSummaryText: '最近反复在修部署。'
        }
      }
    });
    personaMemory.renderPersonaMemoryPrompt = () => ({
      systemMessages: [{ role: 'system', content: '[PersonaCore]\n保持轻松、简短的口吻。' }]
    });

    const passiveAwareness = require('../core/passiveGroupAwareness');
    const now = Date.now();
    const result = await passiveAwareness.handlePassiveGroupAwareness({
      msg: {
        group_id: 'g-passive-memory',
        user_id: 'u-memory-test',
        raw_message: '瑞希你还记得上次部署那个坑吗',
        message_id: `msg-${now}`,
        sender: {
          card: '测试用户',
          nickname: '测试用户'
        },
        __continuousMessageMeta: {
          firstTimestamp: now
        }
      },
      inboundContext: {
        rawText: '瑞希你还记得上次部署那个坑吗',
        cleanText: '瑞希你还记得上次部署那个坑吗'
      },
      sendGroupReply: async () => true,
      sendWithRetry: async () => true
    });

    assert.strictEqual(result.handled, true);
    assert.strictEqual(result.replyText, '我来接一句');
    assert.strictEqual(streamedBodies.length, 1);
    assert.strictEqual(streamedBodies[0].temperature, 1);
    assert.ok(!Object.prototype.hasOwnProperty.call(streamedBodies[0], 'top_p'));
    assert.strictEqual(streamedBodies[0].__preferredProtocol, 'chat_completions');
    assert.strictEqual(streamedBodies[0].__provider, 'openai_compatible');

    const normalSystemMessages = streamedBodies[0]?.messages?.filter((message) => message?.role === 'system') || [];
    assert.ok(normalSystemMessages.some((message) => String(message.content || '').includes(normalUserDefaultText)));

    const userPrompt = String(streamedBodies[0]?.messages?.find((message) => message?.role === 'user')?.content || '');
    assert.ok(!userPrompt.includes(normalUserDefaultText));
    assert.ok(userPrompt.includes('[RetrievedMemory]'));
    assert.ok(userPrompt.includes('之前聊过部署失败和 systemd。'));
    assert.ok(userPrompt.includes('[TaskMemory]'));
    assert.ok(userPrompt.includes('[GroupMemory]'));
    assert.ok(userPrompt.includes('[StyleSignals]'));
    assert.ok(userPrompt.includes('[LongTermProfile]'));
    assert.ok(userPrompt.includes('[DailyJournal]'));
    assert.ok(userPrompt.includes('[Impression]'));
    assert.ok(userPrompt.includes('[Summary]'));

    console.log('passiveAwarenessReplyMemoryPrompt.test.js passed');
  } finally {
    if (httpClient && originalPostWithRetry) httpClient.postWithRetry = originalPostWithRetry;
    if (httpClient && originalPostStreamWithRetry) httpClient.postStreamWithRetry = originalPostStreamWithRetry;
    if (personaMemory && originalCompose) personaMemory.composePersonaMemoryState = originalCompose;
    if (personaMemory && originalRender) personaMemory.renderPersonaMemoryPrompt = originalRender;
    tempPrompts.cleanup();
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
