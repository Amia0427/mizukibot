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

function getUserContent(body) {
  return body?.messages?.find((message) => message?.role === 'user')?.content;
}

function assertVisualRequest(body, expectedUrl) {
  const content = getUserContent(body);
  assert.ok(Array.isArray(content), 'user content should be multimodal content parts');
  const textPart = content.find((part) => part?.type === 'text');
  assert.ok(textPart, 'multimodal content should include the text prompt');
  assert.ok(String(textPart.text || '').includes('[VisualInput]'));
  assert.ok(
    content.some((part) => (
      part?.type === 'image_url'
        && part?.image_url?.url === expectedUrl
    )),
    `expected image_url content part for ${expectedUrl}`
  );
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-passive-vision-input-'));
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
    process.env.PASSIVE_AWARENESS_GROUP_IDS = 'g-passive-vision';
    process.env.PASSIVE_AWARENESS_API_BASE_URL = 'https://example.com/decision-endpoint';
    process.env.PASSIVE_AWARENESS_API_KEY = 'test-passive-key';
    process.env.PASSIVE_AWARENESS_MODEL = 'test-decision-model';
    process.env.PASSIVE_AWARENESS_REPLY_API_BASE_URL = 'https://example.com/reply-endpoint';
    process.env.PASSIVE_AWARENESS_REPLY_API_KEY = 'test-reply-key';
    process.env.PASSIVE_AWARENESS_REPLY_MODEL = 'test-reply-model';
    process.env.PASSIVE_AWARENESS_REPLY_USE_MAIN_MODEL = 'false';
    process.env.PASSIVE_AWARENESS_MIN_INTERVAL_MS = '0';
    process.env.PASSIVE_AWARENESS_GLOBAL_MIN_INTERVAL_MS = '0';
    process.env.PASSIVE_AWARENESS_REPLY_COOLDOWN_MS = '0';
    process.env.PASSIVE_AWARENESS_MAX_REPLIES_PER_HOUR = '20';
    process.env.PASSIVE_AWARENESS_VISION_INPUT_ENABLED = 'true';
    process.env.PASSIVE_AWARENESS_VISION_MAX_IMAGES = '2';
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
                content: '{"should_reply":true,"confidence":0.98,"reason":"visual cue"}'
              }
            }
          ]
        }
      };
    };
    httpClient.postStreamWithRetry = async (_url, body, handlers = {}) => {
      streamedBodies.push(body);
      if (typeof handlers.onData === 'function') {
        handlers.onData(Buffer.from('data: {"choices":[{"delta":{"content":"vision ok"}}]}\n\n'));
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
    const now = Date.now();
    const result = await passiveAwareness.handlePassiveGroupAwareness({
      msg: {
        group_id: 'g-passive-vision',
        user_id: 'u-passive-vision',
        raw_message: 'bot can you see this image?',
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
        rawText: 'bot can you see this image?',
        cleanText: 'bot can you see this image?',
        imageUrl: 'cached-image://passive-test-image',
        visualContext: {
          worker: {
            enabled: false,
            succeeded: false,
            fallbackReason: 'disabled'
          }
        }
      },
      sendGroupReply: async () => true,
      sendWithRetry: async () => true
    });

    assert.strictEqual(result.handled, true);
    assert.strictEqual(decisionBodies.length, 1);
    assert.strictEqual(streamedBodies.length, 1);
    assertVisualRequest(decisionBodies[0], 'cached-image://passive-test-image');
    assertVisualRequest(streamedBodies[0], 'cached-image://passive-test-image');

    const replyCountBeforeForce = streamedBodies.length;
    const forced = await passiveAwareness.forcePassiveGroupInterjection({
      msg: {
        group_id: 'g-passive-vision-force',
        user_id: 'u-passive-vision-force',
        raw_message: 'bot look at this image?',
        message_id: `msg-force-${now}`,
        sender: {
          card: 'tester',
          nickname: 'tester'
        },
        __continuousMessageMeta: {
          firstTimestamp: now + 1000
        }
      },
      inboundContext: {
        rawText: 'bot look at this image?',
        cleanText: 'bot look at this image?',
        imageUrl: 'cached-image://passive-force-image'
      },
      sendGroupReply: async () => true
    });

    assert.strictEqual(forced.handled, true);
    assert.strictEqual(streamedBodies.length, replyCountBeforeForce + 1);
    assertVisualRequest(streamedBodies[replyCountBeforeForce], 'cached-image://passive-force-image');

    console.log('passiveAwarenessVisionInput.test.js passed');
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
