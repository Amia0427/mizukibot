const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const { GLOBAL_TOOL_NAME_SET } = require('../api/globalToolRuntime');
const { TOOL_EXECUTORS } = require('../api/toolExecutors');
const { TOOL_SCHEMAS } = require('../api/toolSchemas');
const { detectIntent } = require('../core/router');
const { planDirectChat } = require('../core/directChatPlanner');
const { buildDirectChatToolCatalog } = require('../core/directChatToolCatalog');
const planning = require('../src/runtime-v2/planning');
const {
  deriveEarthquakeToolArgs,
  deriveWeatherCloudToolArgs,
  deriveWeatherToolArgs,
  isEarthquakeDataQuery,
  isWeatherCloudQuery
} = require('../utils/environmentDataQuery');
const {
  COMPANION_PLANNER_SAFE_READ_TOOLS,
  COMPANION_TOOL_PRESET
} = require('../utils/companionTools');
const { enforceToolPolicy, getPolicy, POLICY_VERSION } = require('../utils/toolPolicy');

function detect(rawText) {
  return detectIntent({
    rawText,
    botQQ: '123456',
    userId: 'u1',
    chatType: 'group'
  });
}

const earthquakeRoute = detect('中国最近一周4级以上地震，给我3条');
assert.strictEqual(isEarthquakeDataQuery('最新地震'), true);
assert.strictEqual(isEarthquakeDataQuery('地震是如何形成的'), false);
assert.strictEqual(isEarthquakeDataQuery('汶川地震发生了什么'), false);
assert.deepStrictEqual(deriveEarthquakeToolArgs('中国最近一周4级以上地震，给我3条'), {
  scope: 'china',
  time_window: 'week',
  min_magnitude: 4,
  limit: 3
});
assert.deepStrictEqual(earthquakeRoute.meta.allowedTools, ['skill_earthquake_latest']);
assert.strictEqual(earthquakeRoute.intent.risk, 'low');
assert.deepStrictEqual(earthquakeRoute.intent.toolNeed, ['web']);
assert.strictEqual(earthquakeRoute.facets.sourceScope, 'live');
assert.strictEqual(earthquakeRoute.facets.freshness, 'latest');
assert.deepStrictEqual(
  planning.pickMinimalToolAllowlist(earthquakeRoute, { allowedToolNames: ['web_search', 'skill_earthquake_latest'] }),
  ['skill_earthquake_latest']
);
assert.deepStrictEqual(planning.deriveToolArgs('skill_earthquake_latest', earthquakeRoute), {
  scope: 'china',
  time_window: 'week',
  min_magnitude: 4,
  limit: 3
});

const genericEarthquakeRoute = detect('最新地震');
assert.deepStrictEqual(planning.deriveToolArgs('skill_earthquake_latest', genericEarthquakeRoute), {
  scope: 'global',
  time_window: 'day',
  min_magnitude: 4.5,
  limit: 5
});
assert.notDeepStrictEqual(detect('地震是如何形成的').meta.allowedTools, ['skill_earthquake_latest']);

const cloudRoute = detect('给我看看最新水汽云图');
assert.strictEqual(isWeatherCloudQuery('最新卫星云图'), true);
assert.deepStrictEqual(deriveWeatherCloudToolArgs('给我看看最新水汽云图'), { channel: 'water_vapor', area: 'china' });
assert.deepStrictEqual(deriveWeatherCloudToolArgs('亚太全圆盘水汽云图'), { channel: 'water_vapor', area: 'full_disk' });
assert.deepStrictEqual(cloudRoute.meta.allowedTools, ['skill_weather_cloud']);
assert.strictEqual(cloudRoute.meta.qqActionKey, 'qq_weather_cloud');
assert.strictEqual(cloudRoute.intent.risk, 'medium');
assert.deepStrictEqual(cloudRoute.intent.toolNeed, ['image']);
assert.strictEqual(cloudRoute.facets.domain, 'weather');
assert.strictEqual(cloudRoute.facets.sourceScope, 'live');
assert.strictEqual(cloudRoute.facets.freshness, 'latest');
assert.deepStrictEqual(
  planning.pickMinimalToolAllowlist(cloudRoute, { allowedToolNames: ['skill_weather', 'skill_weather_cloud'] }),
  ['skill_weather_cloud']
);
assert.deepStrictEqual(planning.deriveToolArgs('skill_weather_cloud', cloudRoute), { channel: 'water_vapor', area: 'china' });

const weatherRoute = detect('上海今天天气怎么样');
assert.deepStrictEqual(deriveWeatherToolArgs('上海今天天气怎么样'), { location: '上海' });
assert.deepStrictEqual(planning.deriveToolArgs('skill_weather', weatherRoute), { location: '上海' });
assert.notDeepStrictEqual(weatherRoute.meta.allowedTools, ['skill_weather_cloud']);
assert.deepStrictEqual(
  planning.pickMinimalToolAllowlist(weatherRoute, { allowedToolNames: ['skill_weather', 'skill_weather_cloud'] }),
  ['skill_weather']
);

const companionOptions = { config: { COMPANION_TOOL_MODE_ENABLED: true } };
assert.strictEqual(
  planning.resolveCompanionPlannerToolGateReason(earthquakeRoute, ['skill_earthquake_latest'], companionOptions),
  'allow_safe_earthquake'
);
assert.strictEqual(
  planning.resolveCompanionPlannerToolGateReason(cloudRoute, ['skill_weather_cloud'], companionOptions),
  'allow_safe_explicit_weather_cloud'
);

for (const toolName of ['skill_earthquake_latest', 'skill_weather_cloud']) {
  assert.ok(TOOL_SCHEMAS.some((schema) => schema?.function?.name === toolName));
  assert.strictEqual(typeof TOOL_EXECUTORS[toolName], 'function');
  assert.ok(COMPANION_TOOL_PRESET.includes(toolName));
}
assert.ok(COMPANION_PLANNER_SAFE_READ_TOOLS.includes('skill_earthquake_latest'));
assert.ok(!COMPANION_PLANNER_SAFE_READ_TOOLS.includes('skill_weather_cloud'));
assert.ok(GLOBAL_TOOL_NAME_SET.has('skill_earthquake_latest'));
assert.ok(!GLOBAL_TOOL_NAME_SET.has('skill_weather_cloud'));

assert.deepStrictEqual(getPolicy('skill_weather_cloud'), {
  version: POLICY_VERSION,
  risk: 'medium',
  capability: 'network',
  effect: 'external_send',
  confirmation: 'none',
  scope: 'user',
  idempotency: 'required',
  replay: 'block_uncertain',
  exposure: 'public'
});
assert.strictEqual(getPolicy('skill_earthquake_latest').effect, 'none');
assert.strictEqual(getPolicy('skill_earthquake_latest').capability, 'network');
assert.deepStrictEqual(enforceToolPolicy('skill_earthquake_latest', {}), {
  scope: 'global',
  time_window: 'day',
  min_magnitude: 4.5,
  limit: 5
});
assert.deepStrictEqual(enforceToolPolicy('skill_earthquake_latest', { scope: 'china' }), {
  scope: 'china',
  time_window: 'day',
  min_magnitude: 2.5,
  limit: 5
});
assert.deepStrictEqual(enforceToolPolicy('skill_weather_cloud', {}), { channel: 'infrared', area: 'china' });
assert.throws(
  () => enforceToolPolicy('skill_earthquake_latest', { time_window: 'year' }),
  /time_window/
);
assert.throws(
  () => enforceToolPolicy('skill_weather_cloud', { channel: 'true_color' }),
  /channel/
);
assert.throws(
  () => enforceToolPolicy('skill_weather_cloud', { area: 'global' }),
  /area/
);

module.exports = (async () => {
  const toolCatalog = buildDirectChatToolCatalog({ userId: 'u1' });
  const earthquakeDescriptor = toolCatalog.find((item) => item.name === 'skill_earthquake_latest');
  const cloudDescriptor = toolCatalog.find((item) => item.name === 'skill_weather_cloud');
  assert.strictEqual(earthquakeDescriptor.readOnly, true);
  assert.strictEqual(cloudDescriptor.readOnly, false);
  assert.strictEqual(cloudDescriptor.writeCapable, true);

  const earthquakeDecision = await planDirectChat(genericEarthquakeRoute, {
    userId: 'u1',
    allowedTools: genericEarthquakeRoute.meta.allowedTools,
    config: { COMPANION_TOOL_MODE_ENABLED: true }
  });
  assert.strictEqual(earthquakeDecision.taskShape, 'tool_augmented_reply');
  assert.deepStrictEqual(earthquakeDecision.allowedToolNames, ['skill_earthquake_latest']);
  assert.strictEqual(earthquakeDecision.executionPlan.steps.length, 1);
  assert.strictEqual(earthquakeDecision.executionPlan.steps[0].action, 'skill_earthquake_latest');

  const cloudDecision = await planDirectChat(cloudRoute, {
    userId: 'u1',
    allowedTools: cloudRoute.meta.allowedTools,
    config: { COMPANION_TOOL_MODE_ENABLED: true }
  });
  assert.strictEqual(cloudDecision.taskShape, 'background_tool_task');
  assert.deepStrictEqual(cloudDecision.allowedToolNames, ['skill_weather_cloud']);
  assert.strictEqual(cloudDecision.executionPlan.steps.length, 1);
  assert.strictEqual(cloudDecision.executionPlan.steps[0].action, 'skill_weather_cloud');
  assert.strictEqual(cloudDecision.plannerDecisionV2.steps[0].sideEffect, true);
  assert.deepStrictEqual(cloudDecision.plannerDecisionV2.steps[0].repairPolicy, {
    strategy: 'never_retry_completed_side_effect',
    allowModelRepair: false
  });

  console.log('environmentDataRouting.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
