const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';
process.env.BOT_TOOL_MODE = 'companion';
process.env.PLAN_API_BASE_URL = 'https://planner.example/v1/chat/completions';
process.env.PLAN_API_KEY = 'planner-key';
process.env.PLANNER_SUBAGENT_ENABLED = 'false';
process.env.MEMOS_MCP_ENABLED = 'false';
process.env.OPENVIKING_RECALL_ENABLED = 'false';
process.env.IMAGE_MODEL_TIMEOUT_MS = '18000';
process.env.IMAGE_MODEL_RETRIES = '3';

const config = require('../config');
config.BOT_TOOL_MODE = 'companion';
config.PLAN_API_BASE_URL = 'https://planner.example/v1/chat/completions';
config.PLAN_API_KEY = 'planner-key';
config.PLANNER_SUBAGENT_ENABLED = false;
config.MEMOS_MCP_ENABLED = false;
config.OPENVIKING_RECALL_ENABLED = false;
config.IMAGE_MODEL_TIMEOUT_MS = 18000;
config.IMAGE_MODEL_RETRIES = 3;

const { planDirectChat } = require('../core/directChatPlanner');
const { resolveRouteExecution } = require('../core/routeExecution');
const { resolveVisionFallbackModelConfig } = require('../core/messageRouteFlow/helpers');
const { buildImageModelConfig } = require('../utils/imageModelConfigResolver');
const { buildMainModelRequest } = require('../api/runtimeV2/model/shared');

module.exports = (async () => {
  let plannerCalled = false;
  const imageSummaryRoute = {
    topRouteType: 'direct_chat',
    question: '总结这张图',
    cleanText: '总结这张图',
    imageUrl: 'https://example.com/image.png',
    intent: {},
    facets: {},
    meta: {
      chatMode: 'image_summary',
      responseIntent: 'summary',
      toolIntent: 'none',
      allowedTools: [],
      chatType: 'group',
      userId: 'u_image_summary'
    }
  };

  const plannerDecision = await planDirectChat(imageSummaryRoute, {
    userId: 'u_image_summary',
    allowedTools: [],
    planner: async () => {
      plannerCalled = true;
      return { mode: 'tool_plan', allowedToolNames: ['memory_cli'], steps: [] };
    }
  });

  assert.strictEqual(plannerCalled, false, 'image summary without available tools should not call the remote planner');
  assert.strictEqual(plannerDecision.shouldUseTools, false);
  assert.strictEqual(plannerDecision.executionPlan.mode, 'chat_only');
  assert.deepStrictEqual(plannerDecision.allowedToolNames, []);
  assert.strictEqual(plannerDecision.decisionSource, 'rule_preflight_image_summary');

  const noExplicitToolsRoute = {
    ...imageSummaryRoute,
    meta: {
      ...imageSummaryRoute.meta
    }
  };
  delete noExplicitToolsRoute.meta.allowedTools;
  let plannerCalledForImplicitCatalog = false;
  const implicitCatalogDecision = await planDirectChat(noExplicitToolsRoute, {
    userId: 'u_image_summary',
    toolCatalog: [{ name: 'memory_cli', bucket: 'local_tools', description: 'read memory' }],
    planner: async () => {
      plannerCalledForImplicitCatalog = true;
      return { mode: 'chat_only', allowedToolNames: [] };
    }
  });
  assert.strictEqual(plannerCalledForImplicitCatalog, false, 'plain image summary should skip planner even when a generic tool catalog exists');
  assert.strictEqual(implicitCatalogDecision.executionPlan.mode, 'chat_only');
  assert.deepStrictEqual(implicitCatalogDecision.allowedToolNames, []);

  let plainChatPlannerCalled = false;
  const plainChatDecision = await planDirectChat({
    topRouteType: 'direct_chat',
    question: '今晚就这么睡吧',
    cleanText: '今晚就这么睡吧',
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
      chatMode: 'text_chat',
      responseIntent: 'answer',
      toolIntent: 'none',
      chatType: 'private',
      userId: 'u_plain_chat'
    }
  }, {
    userId: 'u_plain_chat',
    planner: async () => {
      plainChatPlannerCalled = true;
      return { mode: 'tool_plan', allowedToolNames: ['memory_cli'], steps: [] };
    }
  });
  assert.strictEqual(plainChatPlannerCalled, false, 'plain chat/default should not call the remote planner');
  assert.strictEqual(plainChatDecision.executionPlan.mode, 'chat_only');
  assert.strictEqual(plainChatDecision.decisionSource, 'rule_preflight_plain_chat');

  const routeExecution = resolveRouteExecution({
    ...imageSummaryRoute,
    imageUrl: null,
    meta: {
      ...imageSummaryRoute.meta,
      toolPlanner: plannerDecision
    }
  }, config);
  assert.strictEqual(routeExecution.routeDebugKey, 'direct_chat/image_summary/summary');
  assert.strictEqual(routeExecution.policyKey, 'transform/vision-summary');
  assert.strictEqual(routeExecution.allowTools, false);
  assert.strictEqual(routeExecution.allowStream, false, 'image_summary must stay non-streaming even after worker clears route.imageUrl');

  const fallbackModelConfig = resolveVisionFallbackModelConfig({
    ...imageSummaryRoute,
    imageUrl: null,
    meta: {
      ...imageSummaryRoute.meta,
      visualContext: {
        worker: {
          succeeded: false,
          fallbackUsed: true,
          fallbackReason: 'worker_failed'
        }
      }
    }
  }, null, 'u_image_summary', buildImageModelConfig);
  assert.ok(fallbackModelConfig, 'image_summary should keep image model config when imageUrl was cleared but worker did not succeed');
  assert.strictEqual(fallbackModelConfig.timeoutMs, 18000);
  assert.strictEqual(fallbackModelConfig.retries, 3);

  const imageModelConfig = buildImageModelConfig(null, 'u_image_summary', { routeMeta: imageSummaryRoute.meta });
  assert.strictEqual(imageModelConfig.timeoutMs, 18000);
  assert.strictEqual(imageModelConfig.retries, 3);
  assert.strictEqual(imageModelConfig.promptTokenHardLimit, 20000);

  const request = buildMainModelRequest(imageModelConfig, {
    messages: [{ role: 'user', content: '总结图片' }],
    stream: false,
    defaultMaxTokens: 512,
    trace: {
      source: 'direct_reply',
      routePolicyKey: 'transform/vision-summary',
      routeDebugKey: 'direct_chat/image_summary/summary',
      topRouteType: 'direct_chat',
      dispatchBranch: 'direct_reply'
    },
    routeMeta: imageSummaryRoute.meta,
    topRouteType: 'direct_chat',
    allowedTools: []
  });
  assert.strictEqual(request.body.stream, false);
  assert.strictEqual(request.body.__timeoutMs, 18000);
  assert.strictEqual(request.body.__promptTokenHardLimit, 20000);

  console.log('imageSummaryLatencyPath.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
