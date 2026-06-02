const assert = require('assert');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function buildPrivateWriteRoute(userId = '') {
  return {
    confidence: 0.91,
    topRouteType: 'direct_chat',
    meta: {
      chatType: 'private',
      userId,
      chatMode: 'text_chat',
      responseIntent: 'action_guidance',
      toolIntent: 'force_tools',
      toolPlanner: {
        shouldUseTools: true,
        needsBackground: false,
        allowedToolNames: ['notebook_add_document'],
        executablePlan: {
          goal: 'write notebook',
          policyKey: 'act/default',
          source: 'planner',
          needsTools: true,
          steps: [{ id: 'write', action: 'notebook_add_document', purpose: 'write note' }]
        },
        executionPlan: {
          mode: 'tool_plan',
          steps: [{ id: 'write', action: 'notebook_add_document', args: {}, purpose: 'write note' }]
        }
      }
    },
    intent: {
      risk: 'low',
      toolNeed: ['local-write'],
      executionMode: 'staged',
      needsPlanning: false,
      needsMemory: false
    },
    facets: {
      modality: 'text',
      sourceScope: 'personal',
      domain: 'general',
      outputKind: 'action',
      freshness: 'unknown'
    }
  };
}

function buildPrivateQzoneRoute(userId = '') {
  return {
    confidence: 0.96,
    topRouteType: 'direct_chat',
    meta: {
      chatType: 'private',
      userId,
      qqActionKey: 'qq_publish_qzone',
      chatMode: 'text_chat',
      responseIntent: 'action_guidance',
      toolIntent: 'force_tools',
      toolPlanner: {
        shouldUseTools: true,
        needsBackground: false,
        allowedToolNames: ['qzone_draft'],
        executablePlan: {
          goal: 'draft qzone post',
          policyKey: 'act/qq-publish-qzone',
          source: 'planner',
          needsTools: true,
          steps: [{ id: 'draft', action: 'qzone_draft', purpose: 'draft qzone post' }]
        },
        executionPlan: {
          mode: 'tool_plan',
          steps: [{ id: 'draft', action: 'qzone_draft', args: {}, purpose: 'draft qzone post' }]
        }
      }
    },
    intent: {
      risk: 'medium',
      toolNeed: ['local-write'],
      executionMode: 'staged',
      needsPlanning: false,
      needsMemory: false
    },
    facets: {
      modality: 'text',
      sourceScope: 'none',
      domain: 'general',
      outputKind: 'action',
      freshness: 'unknown'
    }
  };
}

module.exports = (() => {
  const snapshot = { ...process.env };
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.BOT_TOOL_MODE = 'full';
    process.env.PRIVATE_CHAT_TEST_USER_IDS = 'tester_1';
    process.env.PRIVATE_CHAT_ALLOWED_USER_IDS = '';
    process.env.ADMIN_USER_IDS = 'admin_1';

    clearProjectCache();
    const { resolveRouteExecution } = require('../core/routeExecution');
    const runtimeConfig = require('../config');

    const ordinaryPlan = resolveRouteExecution(buildPrivateWriteRoute('user_1'));
    assert.strictEqual(ordinaryPlan.allowTools, false);
    assert.strictEqual(ordinaryPlan.unavailableReason, 'private-write-disabled');
    assert.deepStrictEqual(ordinaryPlan.allowedTools, []);

    const whitelistPlan = resolveRouteExecution(buildPrivateWriteRoute('tester_1'));
    assert.strictEqual(whitelistPlan.allowTools, true);
    assert.strictEqual(whitelistPlan.unavailableReason, '');
    assert.deepStrictEqual(whitelistPlan.allowedTools, ['notebook_add_document']);

    const adminPlan = resolveRouteExecution(buildPrivateWriteRoute('admin_1'));
    assert.strictEqual(adminPlan.allowTools, true);
    assert.strictEqual(adminPlan.unavailableReason, '');
    assert.deepStrictEqual(adminPlan.allowedTools, ['notebook_add_document']);

    const companionRuntimeConfig = {
      ...runtimeConfig,
      BOT_TOOL_MODE: 'companion',
      COMPANION_TOOL_MODE_ENABLED: true,
      COMPANION_ALLOWED_TOOLS: ''
    };
    const adminQzonePlan = resolveRouteExecution(buildPrivateQzoneRoute('admin_1'), companionRuntimeConfig);
    assert.strictEqual(adminQzonePlan.allowTools, true);
    assert.strictEqual(adminQzonePlan.unavailableReason, '');
    assert.deepStrictEqual(adminQzonePlan.allowedTools, ['qzone_draft']);

    const adminCommandPlan = resolveRouteExecution({
      topRouteType: 'admin',
      meta: {
        chatType: 'private',
        userId: 'admin_1',
        command: { cmd: 'status', raw: '/status' }
      }
    }, companionRuntimeConfig);
    assert.strictEqual(adminCommandPlan.executor, 'admin');
    assert.strictEqual(adminCommandPlan.unavailableReason, '');

    console.log('privateChatExecutionExemption.test.js passed');
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
      process.env[key] = value;
    }
    clearProjectCache();
  }
})();
