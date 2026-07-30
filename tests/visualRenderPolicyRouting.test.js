const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';
process.env.ADMIN_USER_IDS = process.env.ADMIN_USER_IDS || 'admin-1';

const { createToolExecutionHelpers } = require('../api/runtimeV2/runtime/toolExecution');
const { isParallelSafeCapability } = require('../api/runtimeV2/capabilities/scheduler');
const { TOOL_EXECUTORS } = require('../api/toolExecutors');
const { TOOL_SCHEMAS } = require('../api/toolSchemas');
const { resolveRouteExecution } = require('../core/routeExecution');
const { detectIntent } = require('../core/router');
const { COMPANION_TOOL_PRESET } = require('../utils/companionTools');
const {
  enforceToolPolicy,
  getPolicy,
  sanitizeToolArgsForLog
} = require('../utils/toolPolicy');

const schema = TOOL_SCHEMAS.find((item) => item?.function?.name === 'render_qq_visual');
assert.ok(schema);
assert.strictEqual(schema.function.parameters.additionalProperties, false);
assert.deepStrictEqual(schema.function.parameters.required, ['renderer', 'markup']);
assert.deepStrictEqual(Object.keys(schema.function.parameters.properties), [
  'renderer',
  'markup',
  'width',
  'max_height'
]);
assert.deepStrictEqual(schema.function.parameters.properties.renderer.enum, ['svg', 'html']);
assert.strictEqual(schema.function.parameters.properties.width.minimum, 320);
assert.strictEqual(schema.function.parameters.properties.width.maximum, 1200);
assert.strictEqual(schema.function.parameters.properties.max_height.minimum, 200);
assert.strictEqual(schema.function.parameters.properties.max_height.maximum, 2000);
assert.strictEqual(typeof TOOL_EXECUTORS.render_qq_visual, 'function');

assert.deepStrictEqual(getPolicy('render_qq_visual'), {
  risk: 'medium',
  capability: 'local_write'
});
assert.ok(COMPANION_TOOL_PRESET.includes('render_qq_visual'));

const normalizedArgs = enforceToolPolicy('render_qq_visual', {
  renderer: ' SVG ',
  markup: ' <svg viewBox="0 0 1 1"/> ',
  width: 800,
  max_height: 1600,
  selector: 'body',
  url: 'https://example.com'
});
assert.deepStrictEqual(normalizedArgs, {
  renderer: 'svg',
  markup: '<svg viewBox="0 0 1 1"/>',
  width: 800,
  max_height: 1600
});
assert.throws(
  () => enforceToolPolicy('render_qq_visual', { renderer: 'url', markup: 'x' }),
  /renderer must be svg or html/
);
assert.throws(
  () => enforceToolPolicy('render_qq_visual', { renderer: 'html', markup: '<div>x</div>', width: 1201 }),
  /width must be an integer between 320 and 1200/
);

const sanitizedLogArgs = sanitizeToolArgsForLog('render_qq_visual', {
  renderer: 'html',
  markup: '<div>private markup</div>',
  __context: { rawText: 'private prompt' }
});
assert.deepStrictEqual(sanitizedLogArgs, {
  renderer: 'html',
  markup: '[redacted markup 25 chars]'
});

const executionHelpers = createToolExecutionHelpers();
assert.strictEqual(executionHelpers.isSideEffectPolicy(getPolicy('render_qq_visual')), true);
assert.strictEqual(isParallelSafeCapability({
  name: 'render_qq_visual',
  kind: 'tool',
  parallelSafe: true
}), false);
const toolContext = executionHelpers.buildToolContext({
  request: {
    userId: 'u1',
    question: 'normalized question',
    routeMeta: {
      rawText: 'original prompt',
      cleanText: 'clean prompt',
      chatType: 'private'
    }
  },
  execution: {},
  memory: {}
});
assert.strictEqual(toolContext.question, 'normalized question');
assert.strictEqual(toolContext.rawText, 'original prompt');
assert.strictEqual(toolContext.cleanText, 'clean prompt');
assert.strictEqual(toolContext.chatType, 'private');

const visualRoute = detectIntent({
  rawText: '请画一张系统架构流程图',
  botQQ: '123456',
  userId: 'ordinary-user',
  chatType: 'private'
});
assert.strictEqual(visualRoute.meta.qqActionKey, 'qq_render_visual');
assert.deepStrictEqual(visualRoute.meta.allowedTools, ['render_qq_visual']);
assert.strictEqual(visualRoute.intent.risk, 'medium');

const visualExecution = resolveRouteExecution({
  ...visualRoute,
  meta: {
    ...visualRoute.meta,
    userId: 'ordinary-user',
    chatType: 'private',
    toolPlanner: {
      shouldUseTools: true,
      allowedToolNames: ['render_qq_visual'],
      executionPlan: {
        mode: 'tool_plan',
        steps: [{
          id: 'render_step',
          action: 'render_qq_visual',
          args: {
            renderer: 'svg',
            markup: '<svg viewBox="0 0 1 1"/>'
          }
        }]
      }
    }
  }
}, {
  BOT_TOOL_MODE: 'companion',
  COMPANION_TOOL_MODE_ENABLED: true,
  ADMIN_USER_IDS: ['admin-1'],
  PRIVATE_CHAT_ENABLED: false
});
assert.deepStrictEqual(visualExecution.allowedTools, ['render_qq_visual']);
assert.strictEqual(visualExecution.allowedPlanSteps.length, 1);

for (const prompt of ['画一只写实的小猫', '生成一张写实照片']) {
  const route = detectIntent({
    rawText: prompt,
    botQQ: '123456',
    userId: 'ordinary-user',
    chatType: 'private'
  });
  assert.notStrictEqual(route.meta.qqActionKey, 'qq_render_visual');
  assert.ok(!Array.isArray(route.meta.allowedTools) || !route.meta.allowedTools.includes('render_qq_visual'));
}

console.log('visualRenderPolicyRouting.test.js passed');
