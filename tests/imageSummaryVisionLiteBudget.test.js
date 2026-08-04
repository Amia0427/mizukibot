const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';
process.env.IMAGE_MODEL_INPUT_TOKEN_HARD_LIMIT = '20000';
process.env.VISION_ROUTE_USER_TEXT_MAX_TOKENS = '6000';
process.env.VISION_ROUTE_SYSTEM_CONTEXT_MAX_TOKENS = '10000';

const config = require('../config');
config.IMAGE_MODEL_INPUT_TOKEN_HARD_LIMIT = 20000;
config.VISION_ROUTE_USER_TEXT_MAX_TOKENS = 6000;
config.VISION_ROUTE_SYSTEM_CONTEXT_MAX_TOKENS = 10000;

const { createAgentDecideNode } = require('../api/runtimeV2/nodes/agentDecide');
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
  let buildReplyMessagesCalls = 0;

  const agentDecide = createAgentDecideNode({
    createEvent: (type, payload = {}) => ({ type, ...payload }),
    saveAndEmit: (state) => state,
    buildVisionMessageContent: (text) => text,
    getMainConversationSystemMessages: () => [{ role: 'system', content: 'stable system prompt' }],
    buildDirectReplyMessages(_state, messageContent) {
      buildReplyMessagesCalls += 1;
      return {
        messages: [
          { role: 'system', content: 'stable system prompt' },
          {
            role: 'user',
            content: [{ type: 'text', text: buildVisionLiteTextContent(messageContent, 1) }]
          }
        ]
      };
    },
    isReviewMode: () => false,
    streamDirectReply: async () => {
      throw new Error('stream path should not run');
    },
    requestReplyImpl: async (messages) => {
      capturedMessages = messages;
      return '图片总结完成';
    },
    requestAssistantMessageImpl: async () => {
      throw new Error('tool path should not run');
    },
    ensureOutputStream: () => ({ mode: 'none' }),
    classifyDirectReplyError: () => 'generic_model_failure',
    summarizeDirectReplyError: (error) => String(error?.message || error || ''),
    getControlledFailureReply: () => 'controlled failure'
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
        allowedTools: [],
        visualContext: { worker: { succeeded: true, imageCount: 1 } }
      },
      topRouteType: 'direct_chat',
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
      streaming: false
    },
    execution: { agent: {} },
    memory: {
      dynamicPrompt: '',
      preparedMainConversationContext: {
        messages: [
          { role: 'system', content: 'prepared full context should not be reused' },
          { role: 'user', content: hugeVisionPayload }
        ]
      }
    },
    output: { stream: {} },
    messages: [],
    events: []
  };

  const result = await agentDecide(state);
  assert.strictEqual(result.output.draftReply, '图片总结完成');
  assert.strictEqual(buildReplyMessagesCalls, 1);
  assert.ok(Array.isArray(capturedMessages));
  const serialized = JSON.stringify(capturedMessages);
  assert.ok(!serialized.includes('prepared full context should not be reused'));
  assert.ok(serialized.includes('用户图片意图'));

  const request = buildMainModelRequest(state.request.modelConfig, {
    messages: capturedMessages,
    stream: false,
    defaultMaxTokens: 512,
    trace: {
      source: 'agent_decide',
      routePolicyKey: 'transform/vision-summary',
      routeDebugKey: 'direct_chat/image_summary/summary',
      topRouteType: 'direct_chat',
      dispatchBranch: 'agent',
      triggerBranch: 'agent_decide.plain_reply'
    },
    routeMeta: state.request.routeMeta,
    topRouteType: 'direct_chat',
    allowedTools: []
  });
  const prepared = await prepareRequest(request.url, request.body);
  const promptIntegrity = summarizeRequest(prepared.requestBody).prompt_integrity;
  assert.ok(promptIntegrity.token_budget.estimated_input_tokens < 20000);
  assert.ok(promptIntegrity.token_budget.largest_messages[0].tokens < 10000);

  console.log('imageSummaryVisionLiteBudget.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
