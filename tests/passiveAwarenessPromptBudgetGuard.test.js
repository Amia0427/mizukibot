const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

function getUserPromptText(body) {
  const content = body?.messages?.find((message) => message?.role === 'user')?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textPart = content.find((part) => part?.type === 'text');
    return String(textPart?.text || '');
  }
  return '';
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-passive-budget-'));
  let httpClient = null;
  let originalPostWithRetry = null;
  let originalPostStreamWithRetry = null;
  let personaMemory = null;
  let originalCompose = null;
  let originalRender = null;
  let originalRecord = null;

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDataDir;
    process.env.PASSIVE_AWARENESS_ENABLED = 'true';
    process.env.PASSIVE_AWARENESS_GROUP_IDS = 'g-passive-budget';
    process.env.PASSIVE_AWARENESS_API_BASE_URL = 'https://example.com/decision-endpoint';
    process.env.PASSIVE_AWARENESS_API_KEY = 'test-passive-key';
    process.env.PASSIVE_AWARENESS_MODEL = 'test-decision-model';
    process.env.PASSIVE_AWARENESS_REPLY_API_BASE_URL = 'https://example.com/reply-endpoint';
    process.env.PASSIVE_AWARENESS_REPLY_API_KEY = 'test-reply-key';
    process.env.PASSIVE_AWARENESS_REPLY_MODEL = 'test-reply-model';
    process.env.PASSIVE_AWARENESS_MIN_INTERVAL_MS = '0';
    process.env.PASSIVE_AWARENESS_GLOBAL_MIN_INTERVAL_MS = '0';
    process.env.PASSIVE_AWARENESS_REPLY_COOLDOWN_MS = '0';
    process.env.PASSIVE_AWARENESS_MAX_REPLIES_PER_HOUR = '20';
    process.env.PASSIVE_AWARENESS_VISION_INPUT_ENABLED = 'true';
    process.env.PASSIVE_AWARENESS_VISION_MAX_IMAGES = '1';
    process.env.VISION_CAPTION_WORKER_ENABLED = 'false';
    process.env.BOT_QQ = 'bot-test';

    clearProjectCache();

    httpClient = require('../api/httpClient');
    originalPostWithRetry = httpClient.postWithRetry;
    originalPostStreamWithRetry = httpClient.postStreamWithRetry;

    const decisionBodies = [];
    const streamedBodies = [];
    httpClient.postWithRetry = async (_url, body) => {
      decisionBodies.push(body);
      return {
        data: {
          choices: [
            {
              message: {
                content: '{"should_reply":true,"confidence":0.99,"reason":"direct long cue"}'
              }
            }
          ]
        }
      };
    };
    httpClient.postStreamWithRetry = async (_url, body, handlers = {}) => {
      streamedBodies.push(body);
      if (typeof handlers.onData === 'function') {
        handlers.onData(Buffer.from('data: {"choices":[{"delta":{"content":"在"}}]}\n\n'));
        handlers.onData(Buffer.from('data: [DONE]\n\n'));
      }
      return true;
    };

    personaMemory = require('../utils/personaMemoryState');
    originalCompose = personaMemory.composePersonaMemoryState;
    originalRender = personaMemory.renderPersonaMemoryPrompt;
    originalRecord = personaMemory.recordPersonaMemoryOutcome;
    personaMemory.composePersonaMemoryState = async (request = {}) => ({
      surface: 'passive_group_reply',
      userId: String(request.userId || ''),
      sessionKey: `qq-group:${request.groupId || ''}:user:${request.userId || ''}`,
      groupId: String(request.groupId || ''),
      evidence: { memoryContext: {} }
    });
    personaMemory.renderPersonaMemoryPrompt = () => ({ systemMessages: [] });
    personaMemory.recordPersonaMemoryOutcome = async () => ({ ok: true });

    const passiveAwareness = require('../core/passiveGroupAwareness');
    const groupState = require('../utils/groupAwarenessState');
    const longTail = '超长引用'.repeat(12000);
    const longText = `瑞希你还在吗 ${longTail}`;
    const now = Date.now();

    const result = await passiveAwareness.handlePassiveGroupAwareness({
      msg: {
        group_id: 'g-passive-budget',
        user_id: 'u-passive-budget',
        raw_message: longText,
        message_id: `msg-${now}`,
        sender: {
          card: 'tester',
          nickname: 'tester'
        },
        __continuousMessageMeta: {
          firstTimestamp: now
        }
      },
      inboundContext: {
        rawText: longText,
        cleanText: longText,
        imageUrl: `data:image/png;base64,${'x'.repeat(400000)}`
      },
      sendGroupReply: async () => true,
      sendWithRetry: async () => true
    });

    assert.strictEqual(result.handled, true);
    assert.strictEqual(decisionBodies.length, 1);
    assert.strictEqual(streamedBodies.length, 1);

    const decisionPrompt = getUserPromptText(decisionBodies[0]);
    const replyPrompt = getUserPromptText(streamedBodies[0]);
    assert.ok(decisionPrompt.length < 7000, `decision prompt too large: ${decisionPrompt.length}`);
    assert.ok(replyPrompt.length < 9000, `reply prompt too large: ${replyPrompt.length}`);
    assert.ok(!decisionPrompt.includes('超长引用'.repeat(1000)));
    assert.ok(!replyPrompt.includes('超长引用'.repeat(1000)));

    const stored = groupState.getRecentMessages('g-passive-budget');
    assert.strictEqual(stored.length, 2);
    assert.ok(stored.every((item) => Array.from(String(item.text || '')).length <= 800));

    console.log('passiveAwarenessPromptBudgetGuard.test.js passed');
  } finally {
    if (httpClient && originalPostWithRetry) httpClient.postWithRetry = originalPostWithRetry;
    if (httpClient && originalPostStreamWithRetry) httpClient.postStreamWithRetry = originalPostStreamWithRetry;
    if (personaMemory && originalCompose) personaMemory.composePersonaMemoryState = originalCompose;
    if (personaMemory && originalRender) personaMemory.renderPersonaMemoryPrompt = originalRender;
    if (personaMemory && originalRecord) personaMemory.recordPersonaMemoryOutcome = originalRecord;
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
