const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';
process.env.IMAGE_MODEL_INPUT_TOKEN_HARD_LIMIT = '20000';
process.env.VISION_ROUTE_USER_TEXT_MAX_TOKENS = '6000';
process.env.VISION_ROUTE_SYSTEM_CONTEXT_MAX_TOKENS = '10000';

const config = require('../config');
config.IMAGE_MODEL_INPUT_TOKEN_HARD_LIMIT = 20000;
config.VISION_ROUTE_USER_TEXT_MAX_TOKENS = 6000;
config.VISION_ROUTE_SYSTEM_CONTEXT_MAX_TOKENS = 10000;

const { createDirectReplyNode } = require('../api/runtimeV2/nodes/directReply');
const { buildVisionLiteTextContent } = require('../api/runtimeV2/context/service');
const { buildMainModelRequest } = require('../api/runtimeV2/model/shared');
const { prepareRequest } = require('../api/httpClient');
const { summarizeRequest } = require('../utils/modelCallTracker/requestSummary');

module.exports = (async () => {
  const hugeVisionPayload = [
    '用户原始文本：总结这张图',
    'VisionCaptionJSON:',
    JSON.stringify({
      summary: '管理员图片总结',
      recommended_prompt_context: '细节'.repeat(180000)
    })
  ].join('\n');
  let capturedMessages = null;
  let buildDirectReplyCalls = 0;

  const directReplyNode = createDirectReplyNode({
    normalizeObject: (value, fallback = {}) => (value && typeof value === 'object' ? value : fallback),
    normalizeArray: (value) => (Array.isArray(value) ? value : []),
    createEvent: (type, payload = {}) => ({ type, ...payload }),
    isReviewMode: () => false,
    shouldBypassHumanizerForPolicy: () => false,
    computeEffectiveAllowedTools: () => [],
    getToolPlannerExecutionPlan: () => null,
    isPlannerSingleAuthorityEnabled: () => false,
    getRouteToolPlanner: () => null,
    buildVisionMessageContent: (text) => text,
    stripMemoryCliInstruction: (text) => String(text || ''),
    getMainConversationSystemMessages: () => [
      { role: 'system', content: 'stable system prompt' }
    ],
    buildDirectReplyMessages(_state, messageContent) {
      buildDirectReplyCalls += 1;
      return {
        messages: [
          { role: 'system', content: 'stable system prompt' },
          {
            role: 'user',
            content: [{
              type: 'text',
              text: buildVisionLiteTextContent(messageContent, 1)
            }]
          }
        ],
        disableMemoryContextSegments: true,
        contextBudgetMode: 'vision_lite',
        compactionPlan: {
          diagnostics: {
            modelWindowTokens: 28192,
            usageRatio: 0.2,
            level: 'normal'
          }
        },
        canonicalSegments: {
          current_user_turn: [{
            role: 'user',
            content: [{
              type: 'text',
              text: buildVisionLiteTextContent(messageContent, 1)
            }]
          }]
        }
      };
    },
    buildLiveMainConversationSnapshot() {
      return null;
    },
    ensureOutputStream: (_output, mode = 'none') => ({ mode, hadOutput: false, completed: false, fallbackToNonStream: false }),
    createMemoryCliTurnState: (value) => value || null,
    cloneDirectToolLoopState: (value) => ({ ...(value || {}) }),
    normalizeMessageForToolLoop: (value) => value,
    requestAssistantMessageImpl: async () => {
      throw new Error('tool probe should not run');
    },
    compileDirectChatToolCallsToPlan: (toolCalls, plan) => ({ ...(plan || {}), steps: toolCalls }),
    saveAndEmit: (state) => state,
    mirrorStreamingFlags: () => ({}),
    isPureToolCallMarkup: () => false,
    streamDirectReply: async () => {
      throw new Error('stream path should not run');
    },
    async requestReplyImpl(messages) {
      capturedMessages = messages;
      return '图片总结完成';
    },
    classifyDirectReplyError: () => 'generic_model_failure',
    summarizeDirectReplyError: (error) => String(error?.message || error || ''),
    attemptDirectMemoryRecovery: async () => null,
    getControlledFailureReply: () => 'controlled failure',
    updateMemoryCliTurnStateAfterError: (state) => state,
    classifyReplyFailure: () => ({ type: 'none' })
  });

  const state = {
    request: {
      question: hugeVisionPayload,
      userId: 'admin_user',
      routePolicyKey: 'transform/vision-summary',
      routeDebugKey: 'direct_chat/image_summary/summary',
      routeMeta: {
        chatMode: 'image_summary',
        chatType: 'group',
        visualContext: {
          worker: {
            succeeded: true,
            imageCount: 1
          }
        }
      },
      topRouteType: 'direct_chat',
      customPrompt: '',
      allowTools: false,
      allowedTools: [],
      modelConfig: {
        model: 'claude-opus-4-6',
        apiBaseUrl: 'https://api.example/v1/chat/completions',
        apiKey: 'test-key',
        promptTokenHardLimit: 20000,
        promptTokenWarningThreshold: 18000,
        maxTokens: 512
      },
      imageUrl: null,
      imageUrls: [],
      streaming: false,
      reviewMode: ''
    },
    execution: { mode: 'chat', memoryCliTurn: null, latencyBreakdown: {} },
    memory: {
      dynamicPrompt: '',
      affinity: null,
      preparedMainConversationContext: {
        messages: [
          { role: 'system', content: 'prepared full context should not be reused' },
          { role: 'user', content: hugeVisionPayload }
        ],
        contextBudgetMode: 'full'
      }
    },
    output: { stream: {} },
    plan: {}
  };

  await directReplyNode(state);

  assert.strictEqual(buildDirectReplyCalls, 1, 'vision route must rebuild instead of reusing prepared full context');
  assert.ok(Array.isArray(capturedMessages), 'expected model messages to be captured');
  const serialized = JSON.stringify(capturedMessages);
  assert.ok(!serialized.includes('prepared full context should not be reused'));
  assert.ok(serialized.includes('用户图片意图'));

  const request = buildMainModelRequest(state.request.modelConfig, {
    messages: capturedMessages,
    stream: false,
    defaultMaxTokens: 512,
    trace: {
      source: 'direct_reply',
      routePolicyKey: 'transform/vision-summary',
      routeDebugKey: 'direct_chat/image_summary/summary',
      topRouteType: 'direct_chat',
      dispatchBranch: 'direct_reply',
      triggerBranch: 'direct_reply.non_stream'
    },
    routeMeta: state.request.routeMeta,
    topRouteType: 'direct_chat',
    allowedTools: []
  });
  const prepared = await prepareRequest(request.url, request.body);
  const promptIntegrity = summarizeRequest(prepared.requestBody).prompt_integrity;
  assert.ok(promptIntegrity.token_budget.estimated_input_tokens < 20000, 'vision lite prompt should stay below hard limit');
  assert.ok(promptIntegrity.token_budget.largest_messages[0].tokens < 10000, 'current user turn should be trimmed');

  console.log('imageSummaryVisionLiteBudget.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
