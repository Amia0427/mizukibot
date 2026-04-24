const assert = require('assert');

process.env.PLANNER_SINGLE_AUTHORITY_ENABLED = 'true';

const { buildRouteMetaEnvelope } = require('../core/executablePlan');
const { detectIntent } = require('../core/router');
const { resolveRouteExecution } = require('../core/routeExecution');

function assertEnvelopeBasics(envelope, expected = {}) {
  assert.strictEqual(envelope.topRouteType, expected.topRouteType || 'direct_chat');
  assert.ok(envelope.routePolicyKey);
  assert.ok(envelope.routeTrace);
  assert.ok(Object.prototype.hasOwnProperty.call(envelope, 'executablePlan'));
  assert.ok(Object.prototype.hasOwnProperty.call(envelope, 'planId'));
  assert.ok(Array.isArray(envelope.planSteps));
}

const toolRoute = {
  confidence: 0.8,
  topRouteType: 'direct_chat',
  meta: {
    chatMode: 'text_chat',
    toolIntent: 'force_tools',
    responseIntent: 'answer',
    toolPlanner: {
      shouldUseTools: true,
      needsBackground: false,
      allowedToolNames: ['web_search'],
      executablePlan: {
        goal: 'lookup',
        policyKey: 'lookup/web-answer',
        source: 'planner',
        needsTools: true,
        steps: [{ id: 'search', action: 'web_search', purpose: 'search' }]
      },
      executionPlan: {
        mode: 'tool_plan',
        steps: [{ id: 'search', action: 'web_search', args: {}, purpose: 'search' }]
      }
    }
  },
  intent: { risk: 'low', toolNeed: ['web'], executionMode: 'staged', needsPlanning: false, needsMemory: false },
  facets: { modality: 'text', sourceScope: 'web', domain: 'general', outputKind: 'answer', freshness: 'latest' }
};
const toolExec = resolveRouteExecution(toolRoute);
const toolEnvelope = buildRouteMetaEnvelope(toolRoute, toolExec, toolRoute.meta.toolPlanner, { groupId: 'g1' });
assertEnvelopeBasics(toolEnvelope);
assert.strictEqual(toolEnvelope.allowedTools[0], 'web_search');
assert.strictEqual(toolEnvelope.executablePlan.steps[0].action, 'web_search');

const textPlanRoute = detectIntent({ rawText: 'plan a study roadmap', botQQ: '123456', userId: 'u1', chatType: 'group' });
const textPlanExec = resolveRouteExecution(textPlanRoute);
const textPlanEnvelope = buildRouteMetaEnvelope(textPlanRoute, textPlanExec, null, {});
assertEnvelopeBasics(textPlanEnvelope);
assert.strictEqual(textPlanEnvelope.routePolicyKey, 'plan/general-direct');
assert.strictEqual(textPlanEnvelope.allowedTools.length, 0);

const adminRoute = { topRouteType: 'admin', meta: { command: { cmd: 'status' }, chatType: 'group' }, intent: {}, facets: {} };
const adminEnvelope = buildRouteMetaEnvelope(adminRoute, resolveRouteExecution(adminRoute), null, {});
assertEnvelopeBasics(adminEnvelope, { topRouteType: 'admin' });
assert.strictEqual(adminEnvelope.routePolicyKey, 'admin/default');

const refuseRoute = { topRouteType: 'refuse', meta: { reason: 'bad' }, intent: {}, facets: {} };
const refuseEnvelope = buildRouteMetaEnvelope(refuseRoute, resolveRouteExecution(refuseRoute), null, {});
assertEnvelopeBasics(refuseEnvelope, { topRouteType: 'refuse' });
assert.strictEqual(refuseEnvelope.routePolicyKey, 'refuse/default');

const notebookRoute = detectIntent({ rawText: '宝我昨天给你发了什么图', botQQ: '123456', userId: 'u1', chatType: 'group' });
notebookRoute.meta.toolPlanner = {
  allowedToolNames: ['notebook_search'],
  executablePlan: {
    goal: 'notebook lookup',
    policyKey: 'lookup/notebook-answer',
    source: 'planner',
    needsTools: true,
    steps: [{ id: 'search', action: 'notebook_search', purpose: 'search notes' }]
  },
  executionPlan: { mode: 'tool_plan', steps: [{ id: 'search', action: 'notebook_search', args: {}, purpose: 'search notes' }] }
};
const notebookExec = resolveRouteExecution(notebookRoute);
const notebookEnvelope = buildRouteMetaEnvelope(notebookRoute, notebookExec, notebookRoute.meta.toolPlanner, {});
assertEnvelopeBasics(notebookEnvelope);
assert.strictEqual(notebookEnvelope.routePolicyKey, 'lookup/notebook-answer');

console.log('routeMetaEnvelope.test.js passed');


