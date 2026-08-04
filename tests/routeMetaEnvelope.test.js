const assert = require('assert');

process.env.BOT_TOOL_MODE = 'full';

const { buildRouteMetaEnvelope } = require('../core/executablePlan');
const { detectIntent } = require('../core/router');
const { resolveRouteExecution } = require('../core/routeExecution');

function assertEnvelopeBasics(envelope, expectedTopRouteType = 'direct_chat') {
  assert.strictEqual(envelope.topRouteType, expectedTopRouteType);
  assert.ok(envelope.routePolicyKey);
  assert.ok(envelope.routeTrace);
  for (const key of ['toolPlanner', 'directChatPlanner', 'executablePlan', 'planSteps', 'plannerValidation']) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(envelope, key), false);
  }
}

const toolRoute = {
  confidence: 0.8,
  topRouteType: 'direct_chat',
  meta: {
    chatType: 'group',
    chatMode: 'text_chat',
    toolIntent: 'force_tools',
    responseIntent: 'answer',
    allowedTools: ['web_search']
  },
  intent: { risk: 'low', toolNeed: ['web'], executionMode: 'staged', needsPlanning: false, needsMemory: false },
  facets: { modality: 'text', sourceScope: 'web', domain: 'general', outputKind: 'answer', freshness: 'latest' }
};
const toolExec = resolveRouteExecution(toolRoute);
const toolEnvelope = buildRouteMetaEnvelope(toolRoute, toolExec, null, { groupId: 'g1' });
assertEnvelopeBasics(toolEnvelope);
assert.deepStrictEqual(toolEnvelope.allowedTools, toolExec.allowedTools);

const textPlanRoute = detectIntent({ rawText: 'plan a study roadmap', botQQ: '123456', userId: 'u1', chatType: 'group' });
const textPlanExec = resolveRouteExecution(textPlanRoute);
const textPlanEnvelope = buildRouteMetaEnvelope(textPlanRoute, textPlanExec, null, {});
assertEnvelopeBasics(textPlanEnvelope);
assert.strictEqual(textPlanEnvelope.routePolicyKey, 'plan/general-direct');
assert.deepStrictEqual(textPlanEnvelope.allowedTools, []);

const adminRoute = { topRouteType: 'admin', meta: { command: { cmd: 'status' }, chatType: 'group' }, intent: {}, facets: {} };
const adminEnvelope = buildRouteMetaEnvelope(adminRoute, resolveRouteExecution(adminRoute), null, {});
assertEnvelopeBasics(adminEnvelope, 'admin');
assert.strictEqual(adminEnvelope.routePolicyKey, 'admin/default');

const refuseRoute = { topRouteType: 'refuse', meta: { reason: 'bad' }, intent: {}, facets: {} };
const refuseEnvelope = buildRouteMetaEnvelope(refuseRoute, resolveRouteExecution(refuseRoute), null, {});
assertEnvelopeBasics(refuseEnvelope, 'refuse');
assert.strictEqual(refuseEnvelope.routePolicyKey, 'refuse/default');

console.log('routeMetaEnvelope.test.js passed');
