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

function buildRoute(rawText = '') {
  const text = String(rawText || '').trim();
  return {
    topRouteType: 'direct_chat',
    cleanText: text,
    rawText: text,
    imageUrl: null,
    intent: {
      risk: 'low',
      toolNeed: ['none'],
      executionMode: 'immediate',
      needsPlanning: false,
      needsMemory: false
    },
    facets: {
      modality: 'text',
      sourceScope: 'none',
      domain: 'general',
      outputKind: 'answer',
      freshness: 'unknown'
    },
    meta: {
      reason: 'test-direct-chat'
    }
  };
}

function buildPrivateImageMessage() {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: 'bot_test',
    user_id: 'vision_user',
    message_id: 'vision_msg_1',
    raw_message: '[CQ:image,url=cached-image://current] 这是谁',
    message: [
      { type: 'image', data: { url: 'cached-image://current' } },
      { type: 'text', data: { text: '这是谁' } }
    ],
    time: Math.floor(Date.now() / 1000),
    sender: {
      user_id: 'vision_user',
      nickname: 'vision_user'
    }
  };
}

function buildPrivateMultiImageMessage() {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: 'bot_test',
    user_id: 'vision_user',
    message_id: 'vision_msg_multi',
    raw_message: '[CQ:image,url=cached-image://current-a][CQ:image,url=cached-image://current-b] 对比这两张',
    message: [
      { type: 'image', data: { url: 'cached-image://current-a' } },
      { type: 'image', data: { url: 'cached-image://current-b' } },
      { type: 'text', data: { text: '对比这两张' } }
    ],
    time: Math.floor(Date.now() / 1000),
    sender: {
      user_id: 'vision_user',
      nickname: 'vision_user'
    }
  };
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-vision-flow-'));
  let originalAskAIByGraph = null;
  let originalRunPersistInBackground = null;

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDataDir;
    process.env.BOT_QQ = 'bot_test';
    process.env.ENABLE_DEBUG_LOG = 'false';
    process.env.CONTINUOUS_MESSAGE_ENABLED = 'false';
    process.env.REFUSAL_AGENT_ENABLED = 'false';
    process.env.PASSIVE_AWARENESS_API_BASE_URL = ' ';
    process.env.PASSIVE_AWARENESS_API_KEY = ' ';
    process.env.PASSIVE_AWARENESS_MODEL = ' ';
    process.env.PRIVATE_CHAT_TEST_USER_IDS = '*';

    async function runScenario(workerResult, message = buildPrivateImageMessage()) {
      const observed = {
        askQuestion: '',
        askImageUrl: undefined,
        askImageUrls: undefined
      };

      clearProjectCache();
      const agentGraph = require('../api/agentGraph');
      if (!originalAskAIByGraph) originalAskAIByGraph = agentGraph.askAIByGraph;
      if (!originalRunPersistInBackground) originalRunPersistInBackground = agentGraph.runPersistInBackgroundFromCheckpoint;
      agentGraph.askAIByGraph = async (question, _userInfo, _userId, _customPrompt, imageUrl, options = {}) => {
        observed.askQuestion = String(question || '');
        observed.askImageUrl = imageUrl;
        observed.askImageUrls = options.imageUrls;
        return 'ok';
      };
      agentGraph.runPersistInBackgroundFromCheckpoint = async () => true;

      const config = require('../config');
      const { createMessageHandler } = require('../core/messageHandler');
      const { handleIncomingMessage } = createMessageHandler({
        config,
        sendWithRetry: async (payload) => {
          if (String(payload?.action || '').trim() === 'send_private_msg') return true;
          return true;
        },
        detectIntentHybridOverride: async ({ rawText }) => buildRoute(rawText),
        runVisionCaptionWorkerOverride: async () => workerResult
      });

      await handleIncomingMessage(message);
      return observed;
    }

    const successObserved = await runScenario({
      ok: true,
      fallbackReason: '',
      visualContext: {
        hasVisualInput: true,
        worker: {
          name: 'vision-caption-worker',
          succeeded: true,
          fallbackUsed: false,
          fallbackReason: '',
          model: 'test-model',
          imageCount: 1
        },
        images: [
          {
            imageIndex: 0,
            source: 'current',
            url: 'cached-image://current'
          }
        ],
        captionJson: { summary: 'cat' },
        summary: 'cat',
        recommendedPromptContext: '一张猫图',
        shortPersistSummary: '猫图',
        runtimeQuestionText: '用户原始文本：这是谁\nVisionCaptionJSON:{"summary":"cat"}',
        persistUserText: '用户原始文本：这是谁\n视觉摘要：猫图',
        originalUserText: '这是谁'
      }
    });

    assert.ok(successObserved.askQuestion.includes('VisionCaptionJSON'));
    assert.strictEqual(successObserved.askImageUrl, null);

    clearProjectCache();
    const failureObserved = await runScenario({
      ok: false,
      fallbackReason: 'timeout',
      visualContext: null
    });

    assert.ok(failureObserved.askQuestion.includes('这是谁'));
    assert.strictEqual(failureObserved.askImageUrl, 'cached-image://current');
    assert.deepStrictEqual(failureObserved.askImageUrls, ['cached-image://current']);

    clearProjectCache();
    const multiFailureObserved = await runScenario({
      ok: false,
      fallbackReason: 'timeout',
      visualContext: null
    }, buildPrivateMultiImageMessage());

    assert.ok(multiFailureObserved.askQuestion.includes('对比这两张'));
    assert.strictEqual(multiFailureObserved.askImageUrl, 'cached-image://current-a');
    assert.deepStrictEqual(multiFailureObserved.askImageUrls, [
      'cached-image://current-a',
      'cached-image://current-b'
    ]);

    console.log('messageHandlerVisionFlow.test.js passed');
  } finally {
    try {
      const agentGraph = require('../api/agentGraph');
      if (agentGraph && originalAskAIByGraph) {
        agentGraph.askAIByGraph = originalAskAIByGraph;
      }
      if (agentGraph && originalRunPersistInBackground) {
        agentGraph.runPersistInBackgroundFromCheckpoint = originalRunPersistInBackground;
      }
    } catch (_) {}
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
