const assert = require('assert');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

clearProjectCache();
const runtimePath = require.resolve('../api/mcpRuntime');
require.cache[runtimePath] = {
  id: runtimePath,
  filename: runtimePath,
  loaded: true,
  exports: {
    getCachedDynamicMcpToolRegistry: () => ({
      generatedAt: 1,
      tools: [
        {
          serverName: 'memos-api-mcp',
          toolName: 'search_memory',
          functionName: 'mcp_memos_api_mcp_search_memory',
          description: 'MemOS search',
          schema: {
            type: 'function',
            function: {
              name: 'mcp_memos_api_mcp_search_memory',
              description: 'MemOS search',
              parameters: { type: 'object', properties: {} }
            }
          }
        }
      ],
      byName: new Map()
    }),
    callMcpTool: async () => ({ ok: true, text: 'stub' }),
    warmMcpRegistry: async () => ({ generatedAt: 1, tools: [] }),
    getDynamicMcpToolRegistry: async () => ({ generatedAt: 1, tools: [] })
  }
};

const config = require('../config');
const oldBotToolMode = process.env.BOT_TOOL_MODE;
const oldCompanionEnabled = process.env.COMPANION_TOOL_MODE_ENABLED;
const oldConfigBotToolMode = config.BOT_TOOL_MODE;
const oldConfigCompanionEnabled = config.COMPANION_TOOL_MODE_ENABLED;
process.env.BOT_TOOL_MODE = 'full';
process.env.COMPANION_TOOL_MODE_ENABLED = 'false';
config.BOT_TOOL_MODE = 'full';
config.COMPANION_TOOL_MODE_ENABLED = false;

const {
  buildPlannerUserPayload,
  planRequestV2,
  convertPlannerDecisionToDirectChatDecision,
  DYNAMIC_CONTEXT_PLAN_VERSION
} = require('../api/runtimeV2/planning/service');
const { buildBaseDynamicPrompt, buildDynamicPrompt } = require('../api/runtimeV2/context/service');
const { buildDirectChatToolCatalog } = require('../core/directChatToolCatalog');

module.exports = (async () => {
  const memosRecall = {
    query: '继续计划',
    used: true,
    promptText: '[MemOSRecall]\n1. 用户偏好直接给结论。\n2. 用户强调不能覆盖他人改动。',
    items: [
      { id: 'm1', text: '用户偏好直接给结论。' }
    ]
  };
  const route = {
    question: '继续刚才的实现计划',
    cleanText: '继续刚才的实现计划',
    topRouteType: 'direct_chat',
    meta: {
      chatMode: 'chat',
      toolIntent: 'none',
      responseIntent: 'answer'
    },
    intent: {},
    facets: {}
  };

  const payload = buildPlannerUserPayload(route, [], {
    memosRecall,
    memosRecallText: memosRecall.promptText,
    availableContextSignals: {
      memosRecall: true
    }
  });
  const memosMeta = payload.dynamicPromptBlockCatalog.find((item) => item.blockId === 'memos_recall');
  assert.ok(memosMeta);
  assert.strictEqual(memosMeta.available, true);
  assert.strictEqual(memosMeta.signalKey, 'memosRecall');
  assert.strictEqual(memosMeta.selectionPolicy, 'high_value_only');
  assert.deepStrictEqual(payload.memosRecall, memosRecall);

  const decision = await planRequestV2({
    ...route,
    route,
    routeMeta: route.meta,
    allowedTools: ['memory_cli'],
    memosRecall,
    memosRecallText: memosRecall.promptText,
    availableContextSignals: {
      memosRecall: true
    },
    planner: async (_route, options) => {
      assert.strictEqual(options.availableContextSignals.memosRecall, true);
      assert.ok(String(options.memosRecallText || '').includes('[MemOSRecall]'));
      return {
        mode: 'chat_only',
        taskShape: 'fast_reply',
        allowedToolNames: ['mcp_memos_api_mcp_search_memory'],
        steps: [],
        dynamicPromptPlan: {
          schemaVersion: DYNAMIC_CONTEXT_PLAN_VERSION,
          enabledBlockIds: ['memos_recall'],
          personaModules: [],
          blockDecisions: [
            { blockId: 'memos_recall', decision: 'include', confidence: 0.9, priority: 20, reason: 'specific MemOS evidence' }
          ]
        },
        plannerMeta: {
          decisionVersion: 'planner_decision_v2',
          plannerVersion: 'direct_chat_single_authority_v2',
          reason: 'use memos recall only as prompt evidence',
          plannerModel: 'mock-planner',
          decisionSource: 'planner'
        }
      };
    }
  });
  assert.deepStrictEqual(decision.allowedToolNames, []);
  assert.ok(decision.dynamicPromptPlan.enabledBlockIds.includes('memos_recall'));

  const directChatDecision = convertPlannerDecisionToDirectChatDecision(decision, route, {
    memosRecall,
    toolCatalog: [{ name: 'mcp_memos_api_mcp_search_memory', bucket: 'mcp' }]
  });
  assert.deepStrictEqual(directChatDecision.allowedToolNames, []);
  assert.deepStrictEqual(directChatDecision.memosRecall, memosRecall);

  const catalog = buildDirectChatToolCatalog({ userId: 'u_memos' });
  assert.ok(!catalog.some((item) => /^mcp_memos_api_mcp_/i.test(item.name)));

  const prompt = await buildDynamicPrompt(
    { level: 'friend', points: 7 },
    'u_memos_prompt',
    '继续刚才的实现计划',
    null,
    {
      topRouteType: 'direct_chat',
      routePolicyKey: 'chat/default',
      routeMeta: {
        directChatPlanner: {
          memosRecall,
          dynamicPromptPlan: {
            schemaVersion: DYNAMIC_CONTEXT_PLAN_VERSION,
            enabledBlockIds: ['memos_recall'],
            personaModules: [],
            blockDecisions: [
              { blockId: 'memos_recall', decision: 'include', confidence: 0.9, priority: 20, reason: 'specific MemOS evidence' }
            ]
          }
        }
      }
    }
  );
  const memosBlock = prompt.promptSnapshot.assembledBlocks.find((item) => item.id === 'memos_recall');
  assert.ok(memosBlock);
  assert.ok(memosBlock.content.startsWith('[MemOSRecall]'));
  assert.ok(prompt.promptSegments.systemPrompt.some((message) => String(message.content || '').includes('[MemOSRecall]')));

  const duplicateMemoryContext = {
    memoryForPrompt: '[RelevantEvidence]\n用户偏好直接给结论。',
    promptRetrievedMemoryText: '用户偏好直接给结论。'
  };
  let dedupedPlannerMemosRecall = null;
  const dedupedDecision = await planRequestV2({
    ...route,
    route,
    routeMeta: route.meta,
    allowedTools: [],
    memoryContext: duplicateMemoryContext,
    memosRecall,
    memosRecallText: memosRecall.promptText,
    planner: async (_route, options) => {
      assert.strictEqual(options.availableContextSignals.memosRecall, true);
      assert.ok(!String(options.memosRecallText || '').includes('用户偏好直接给结论。'));
      assert.ok(String(options.memosRecallText || '').includes('不能覆盖他人改动'));
      dedupedPlannerMemosRecall = options.memosRecall;
      return {
        mode: 'chat_only',
        taskShape: 'fast_reply',
        allowedToolNames: [],
        steps: [],
        dynamicPromptPlan: {
          schemaVersion: DYNAMIC_CONTEXT_PLAN_VERSION,
          enabledBlockIds: ['memos_recall'],
          personaModules: [],
          blockDecisions: [
            { blockId: 'memos_recall', decision: 'include', confidence: 0.9, priority: 20, reason: 'deduped MemOS evidence remains useful' }
          ]
        },
        plannerMeta: {
          decisionVersion: 'planner_decision_v2',
          plannerVersion: 'direct_chat_single_authority_v2',
          reason: 'deduped memos recall',
          plannerModel: 'mock-planner',
          decisionSource: 'planner'
        }
      };
    }
  });
  assert.ok(dedupedDecision.dynamicPromptPlan.enabledBlockIds.includes('memos_recall'));
  assert.strictEqual(dedupedPlannerMemosRecall.items.length, 1);
  assert.ok(!dedupedPlannerMemosRecall.promptText.includes('直接给结论'));
  assert.ok(dedupedPlannerMemosRecall.promptText.includes('不能覆盖他人改动'));

  const duplicateOnlyRecall = {
    query: '继续计划',
    used: true,
    promptText: '[MemOSRecall]\n1. 用户偏好直接给结论。',
    items: [
      { id: 'dup-only', text: '用户偏好直接给结论。' }
    ]
  };
  let duplicateOnlyPlannerMemosRecall = null;
  const duplicateOnlyDecision = await planRequestV2({
    ...route,
    route,
    routeMeta: route.meta,
    allowedTools: [],
    memoryContext: duplicateMemoryContext,
    memosRecall: duplicateOnlyRecall,
    memosRecallText: duplicateOnlyRecall.promptText,
    planner: async (_route, options) => {
      assert.strictEqual(options.availableContextSignals.memosRecall, undefined);
      assert.strictEqual(options.memosRecallText, '');
      duplicateOnlyPlannerMemosRecall = options.memosRecall;
      return {
        mode: 'chat_only',
        taskShape: 'fast_reply',
        allowedToolNames: [],
        steps: [],
        dynamicPromptPlan: {
          schemaVersion: DYNAMIC_CONTEXT_PLAN_VERSION,
          enabledBlockIds: ['memos_recall'],
          personaModules: [],
          blockDecisions: [
            { blockId: 'memos_recall', decision: 'include', confidence: 0.9, priority: 20, reason: 'duplicate should be rejected' }
          ]
        },
        plannerMeta: {
          decisionVersion: 'planner_decision_v2',
          plannerVersion: 'direct_chat_single_authority_v2',
          reason: 'duplicate-only memos recall',
          plannerModel: 'mock-planner',
          decisionSource: 'planner'
        }
      };
    }
  });
  assert.ok(!duplicateOnlyDecision.dynamicPromptPlan.enabledBlockIds.includes('memos_recall'));
  assert.strictEqual(duplicateOnlyPlannerMemosRecall.used, false);
  assert.strictEqual(duplicateOnlyPlannerMemosRecall.rejectedReason, 'deduped_by_local_memory');

  const dedupedPrompt = await buildBaseDynamicPrompt(
    { level: 'friend', points: 7 },
    'u_memos_prompt_dedupe',
    '继续刚才的实现计划',
    null,
    {
      topRouteType: 'direct_chat',
      routePolicyKey: 'chat/default',
      promptMaterials: {
        userInfo: { level: 'friend', points: 7 },
        userId: 'u_memos_prompt_dedupe',
        question: '继续刚才的实现计划',
        customPrompt: null,
        routeMeta: {
          directChatPlanner: {
            memosRecall: duplicateOnlyRecall,
            dynamicPromptPlan: {
              schemaVersion: DYNAMIC_CONTEXT_PLAN_VERSION,
              enabledBlockIds: ['memos_recall'],
              personaModules: [],
              blockDecisions: [
                { blockId: 'memos_recall', decision: 'include', confidence: 0.9, priority: 20, reason: 'duplicate should be rejected' }
              ]
            }
          }
        },
        routePolicyKey: 'chat/default',
        topRouteType: 'direct_chat',
        memoryContext: duplicateMemoryContext,
        personaMemoryState: {},
        personaMemoryPrompt: { systemMessages: [], promptBlocks: [], policy: {} },
        personaModuleCandidates: [],
        personaWorldbookSearch: {},
        personaModuleDecision: { selected: [], rejected: [] },
        memosRecall: duplicateOnlyRecall,
        dynamicPromptPlan: {
          schemaVersion: DYNAMIC_CONTEXT_PLAN_VERSION,
          enabledBlockIds: ['memos_recall'],
          personaModules: [],
          blockDecisions: [
            { blockId: 'memos_recall', decision: 'include', confidence: 0.9, priority: 20, reason: 'duplicate should be rejected' }
          ]
        },
        summaryText: 'none',
        dynamicFewShotPrompt: ''
      },
      routeMeta: {
        directChatPlanner: {
          memosRecall: duplicateOnlyRecall,
          dynamicPromptPlan: {
            schemaVersion: DYNAMIC_CONTEXT_PLAN_VERSION,
            enabledBlockIds: ['memos_recall'],
            personaModules: [],
            blockDecisions: [
              { blockId: 'memos_recall', decision: 'include', confidence: 0.9, priority: 20, reason: 'duplicate should be rejected' }
            ]
          }
        }
      }
    }
  );
  assert.ok(!dedupedPrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'memos_recall'));
  assert.ok(!dedupedPrompt.promptSegments.systemPrompt.some((message) => String(message.content || '').includes('[MemOSRecall]')));

  const unavailableDecision = await planRequestV2({
    ...route,
    route,
    routeMeta: route.meta,
    allowedTools: [],
    config: {
      MEMOS_MCP_ENABLED: false
    },
    availableContextSignals: {
      memosRecall: false
    },
    planner: async () => ({
      mode: 'chat_only',
      taskShape: 'fast_reply',
      allowedToolNames: [],
      steps: [],
      dynamicPromptPlan: {
        schemaVersion: DYNAMIC_CONTEXT_PLAN_VERSION,
        enabledBlockIds: ['memos_recall'],
        personaModules: [],
        blockDecisions: [
          { blockId: 'memos_recall', decision: 'include', confidence: 0.9, priority: 20, reason: 'bad include' }
        ]
      },
      plannerMeta: {
        decisionVersion: 'planner_decision_v2',
        plannerVersion: 'direct_chat_single_authority_v2',
        reason: 'bad unavailable block include',
        plannerModel: 'mock-planner',
        decisionSource: 'planner'
      }
    })
  });
  assert.ok(!unavailableDecision.dynamicPromptPlan.enabledBlockIds.includes('memos_recall'));

  console.log('memosPlannerPromptIntegration.test.js passed');
  if (oldBotToolMode === undefined) delete process.env.BOT_TOOL_MODE;
  else process.env.BOT_TOOL_MODE = oldBotToolMode;
  if (oldCompanionEnabled === undefined) delete process.env.COMPANION_TOOL_MODE_ENABLED;
  else process.env.COMPANION_TOOL_MODE_ENABLED = oldCompanionEnabled;
  config.BOT_TOOL_MODE = oldConfigBotToolMode;
  config.COMPANION_TOOL_MODE_ENABLED = oldConfigCompanionEnabled;
  clearProjectCache();
})().catch((error) => {
  if (oldBotToolMode === undefined) delete process.env.BOT_TOOL_MODE;
  else process.env.BOT_TOOL_MODE = oldBotToolMode;
  if (oldCompanionEnabled === undefined) delete process.env.COMPANION_TOOL_MODE_ENABLED;
  else process.env.COMPANION_TOOL_MODE_ENABLED = oldCompanionEnabled;
  config.BOT_TOOL_MODE = oldConfigBotToolMode;
  config.COMPANION_TOOL_MODE_ENABLED = oldConfigCompanionEnabled;
  clearProjectCache();
  console.error(error);
  process.exit(1);
});
