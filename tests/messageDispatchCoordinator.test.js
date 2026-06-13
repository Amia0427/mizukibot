const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-dispatch-stream-'));
process.env.DATA_DIR = tempDir;
process.env.GROUP_MAIN_MODEL_STREAM_POLICY_FILE = path.join(tempDir, 'group_main_model_stream_policy.json');
process.env.AI_STREAM_ENABLED = 'true';

const { createMessageDispatchCoordinator } = require('../core/messageDispatchCoordinator');
const {
  setGroupMainModelStreamEnabled,
  setGroupPublic
} = require('../utils/groupMainModelStreamPolicy');

module.exports = (async () => {
  let backgroundCalled = false;
  let toolCalled = false;
  let aiCalled = false;
  const aiReplyOptionsSeen = [];
  const injectedActionClient = { marker: 'injected-action-client' };
  const thinkingEmojiOptionsSeen = [];

  const coordinator = createMessageDispatchCoordinator({
    config: {
      BACKGROUND_TOOL_TASKS_ENABLED: true
    },
    buildRoutePromptBundle: () => ({
      toolGuidancePrompt: 'tool',
      streamingSegmentationPrompt: 'stream',
      qqRichReplyPrompt: 'qq',
      disableStreamForReply: false
    }),
    getStreamMaxSegments: () => 3,
    buildToolGuidancePrompt: () => 'tool',
    buildStreamingSegmentationPrompt: () => 'stream',
    shouldPreferQqRichReply: () => false,
    buildQqRichReplyPrompt: () => 'qq',
    buildSafetyBoundaryRoutePrompt: () => null,
    buildLlmPerception: () => ({ text: 'perception' }),
    buildRoutePlanLogPayload: () => ({}),
    maybeCaptureUnavailableFeatureRequest: () => {},
    buildUnavailableRouteReply: () => 'unavailable',
    getEffectivePolicyKey: () => 'direct_chat/default',
    runBackgroundToolTask: async () => { backgroundCalled = true; return { backgroundHandled: true }; },
    detectQzonePostDraftMode: () => 'manual',
    generateBotDiaryDraft: async () => ({ ok: false, reason: 'skip' }),
    generateGenericQzoneDraft: async () => ({ ok: false }),
    normalizeGeneratedQzoneContent: (text) => text,
    publishQzoneForContext: async () => ({ ok: true }),
    markThinkingEmojiBeforeLlm: async (options = {}) => {
      thinkingEmojiOptionsSeen.push(options);
      return true;
    },
    askToolTaskLocally: async () => { toolCalled = true; return 'tool reply'; },
    createStreamingDispatcher: () => ({ onDelta() {}, async finish() {} }),
    composeDirectRoutePrompt: (parts = {}) => Object.entries(parts)
      .filter(([, value]) => String(value || '').trim())
      .map(([key, value]) => `${key}:${value}`)
      .join('\n'),
    askAIDispatch: async (_text, _userInfo, _senderId, _customPrompt, _imageUrl, replyOptions) => {
      aiCalled = true;
      aiReplyOptionsSeen.push({ ...(replyOptions || {}) });
      return 'ai reply';
    },
    sendWithRetry: async () => true,
    actionClient: injectedActionClient
  });

  const background = await coordinator.dispatchByRoutePlan({
    route: { meta: {} },
    routeExecutionPlan: { executor: 'background_direct', allowTools: true, topRouteType: 'direct_chat', allowedTools: [] },
    cleanText: 'task',
    imageUrl: null,
    userInfo: {},
    senderId: 'u1',
    groupId: 'g1'
  });
  assert.strictEqual(background.backgroundHandled, true);
  assert.strictEqual(backgroundCalled, true);

  const tool = await coordinator.dispatchByRoutePlan({
    route: { meta: {} },
    routeExecutionPlan: { executor: 'direct', allowTools: true, topRouteType: 'direct_chat', allowedTools: [] },
    cleanText: 'task',
    imageUrl: null,
    userInfo: {},
    senderId: 'u1',
    groupId: 'g1'
  });
  assert.strictEqual(tool.reply, 'tool reply');
  assert.strictEqual(toolCalled, true);
  assert.strictEqual(thinkingEmojiOptionsSeen.at(-1).actionClient, injectedActionClient);

  const chat = await coordinator.dispatchByRoutePlan({
    route: {
      meta: {
        visualContext: {
          worker: {
            succeeded: false,
            fallbackUsed: true
          }
        }
      }
    },
    routeExecutionPlan: { executor: 'direct', allowTools: false, topRouteType: 'direct_chat', allowedTools: [] },
    cleanText: 'task',
    imageUrl: 'https://example.com/fallback-image.png',
    userInfo: {},
    senderId: 'u1',
    groupId: 'g1'
  });
  assert.strictEqual(chat.reply, 'ai reply');
  assert.strictEqual(aiCalled, true);
  assert.strictEqual(thinkingEmojiOptionsSeen.at(-1).actionClient, injectedActionClient);
  assert.ok(chat.replyOptions.modelConfig);
  assert.strictEqual(typeof chat.replyOptions.modelConfig.model, 'string');
  assert.strictEqual(chat.replyOptions.disableStream, true, 'vision fallback should stay non-streaming');
  assert.strictEqual(chat.replyOptions.deferPersist, true, 'direct chat replies should defer persist until send succeeds');

  const workerSuccessImageSummary = await coordinator.dispatchByRoutePlan({
    route: {
      meta: {
        chatMode: 'image_summary',
        visualContext: {
          worker: {
            succeeded: true,
            imageCount: 1
          }
        }
      }
    },
    routeExecutionPlan: {
      executor: 'direct',
      allowTools: false,
      allowStream: false,
      topRouteType: 'direct_chat',
      routeDebugKey: 'direct_chat/image_summary/summary',
      policyKey: 'transform/vision-summary',
      allowedTools: []
    },
    cleanText: 'worker evidence summary',
    imageUrl: null,
    userInfo: {},
    senderId: 'u1',
    groupId: 'g1'
  });
  assert.strictEqual(workerSuccessImageSummary.reply, 'ai reply');
  assert.ok(workerSuccessImageSummary.replyOptions.modelConfig, 'worker-success image_summary should still use image model config');
  assert.strictEqual(workerSuccessImageSummary.replyOptions.modelConfig.promptTokenHardLimit, 20000);
  assert.strictEqual(workerSuccessImageSummary.replyOptions.modelConfig.timeoutMs, 18000);

  const unavailableToolChat = await coordinator.dispatchByRoutePlan({
    route: { meta: {} },
    routeExecutionPlan: {
      executor: 'direct',
      allowTools: false,
      allowStream: false,
      topRouteType: 'direct_chat',
      routeDebugKey: 'direct_chat/tool-missing',
      unavailableReason: 'no-allowed-tools',
      allowedTools: []
    },
    cleanText: '不要用工具，直接聊',
    imageUrl: null,
    userInfo: {},
    senderId: 'u1',
    groupId: 'g1'
  });
  assert.strictEqual(unavailableToolChat.reply, 'ai reply');
  assert.strictEqual(toolCalled, true, 'previous tool route should be the only tool call');
  assert.ok(aiReplyOptionsSeen.length >= 2);
  assert.ok(!String(aiReplyOptionsSeen.at(-1).routePrompt || '').includes('toolGuidancePrompt:tool'));

  setGroupPublic('g1', true, 'test', Date.parse('2026-05-23T23:20:00+08:00'));
  setGroupMainModelStreamEnabled('g1', true, 'test', Date.parse('2026-05-23T23:20:01+08:00'));
  const publicGroupChat = await coordinator.dispatchByRoutePlan({
    route: { meta: {} },
    routeExecutionPlan: { executor: 'direct', allowTools: false, allowStream: true, topRouteType: 'direct_chat', allowedTools: [] },
    cleanText: 'task',
    imageUrl: null,
    userInfo: {},
    senderId: 'u1',
    groupId: 'g1'
  });
  assert.strictEqual(publicGroupChat.reply, 'ai reply');
  assert.strictEqual(publicGroupChat.replyOptions.disableStream, false, 'public group with /main_stream on should allow streaming');

  setGroupMainModelStreamEnabled('g1', false, 'test', Date.parse('2026-05-23T23:20:02+08:00'));
  const explicitOffGroupChat = await coordinator.dispatchByRoutePlan({
    route: { meta: {} },
    routeExecutionPlan: { executor: 'direct', allowTools: false, allowStream: true, topRouteType: 'direct_chat', allowedTools: [] },
    cleanText: 'task',
    imageUrl: null,
    userInfo: {},
    senderId: 'u1',
    groupId: 'g1'
  });
  assert.strictEqual(explicitOffGroupChat.reply, 'ai reply');
  assert.strictEqual(explicitOffGroupChat.replyOptions.disableStream, true, 'public group with /main_stream off should disable streaming');

  const privateChat = await coordinator.dispatchByRoutePlan({
    route: {
      meta: {
        chatType: 'private'
      }
    },
    routeExecutionPlan: { executor: 'direct', allowTools: false, allowStream: true, topRouteType: 'direct_chat', allowedTools: [] },
    cleanText: 'task',
    imageUrl: null,
    userInfo: {},
    senderId: 'u1',
    groupId: ''
  });
  assert.strictEqual(privateChat.reply, 'ai reply');
  assert.strictEqual(privateChat.replyOptions.disableStream, false, 'private chat should keep the original stream setting');
  assert.strictEqual(privateChat.replyOptions.deferPersist, true, 'private direct chat replies should also use deferred persist');

  console.log('messageDispatchCoordinator.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
