const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const { GLOBAL_TOOL_NAME_SET } = require('../api/globalToolRuntime');
const { TOOL_EXECUTORS } = require('../api/toolExecutors');
const { TOOL_SCHEMAS } = require('../api/toolSchemas');
const { detectIntent } = require('../core/router');
const { buildDirectChatToolCatalog } = require('../core/directChatToolCatalog');
const { resolveRouteExecution } = require('../core/routeExecution');
const {
  deriveEarthquakeToolArgs,
  deriveWeatherCloudToolArgs,
  deriveWeatherToolArgs,
  isEarthquakeDataQuery,
  isWeatherDataQuery,
  isWeatherCloudQuery
} = require('../utils/environmentDataQuery');
const {
  COMPANION_SAFE_READ_TOOLS,
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
assert.deepStrictEqual(deriveEarthquakeToolArgs(earthquakeRoute.cleanText), {
  scope: 'china',
  time_window: 'week',
  min_magnitude: 4,
  limit: 3
});

const genericEarthquakeRoute = detect('最新地震');
assert.deepStrictEqual(deriveEarthquakeToolArgs(genericEarthquakeRoute.cleanText), {
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
assert.deepStrictEqual(deriveWeatherCloudToolArgs(cloudRoute.cleanText), { channel: 'water_vapor', area: 'china' });

const weatherRoute = detect('上海今天天气怎么样');
assert.strictEqual(isWeatherDataQuery('上海逐小时天气'), true);
assert.strictEqual(isWeatherDataQuery('什么是空气质量指数'), false);
assert.deepStrictEqual(deriveWeatherToolArgs('上海今天天气怎么样'), {
  location: '上海',
  sections: ['overview'],
  days: 4,
  hours: 24
});
assert.deepStrictEqual(deriveWeatherToolArgs(weatherRoute.cleanText), {
  location: '上海',
  sections: ['overview'],
  days: 4,
  hours: 24
});
assert.deepStrictEqual(weatherRoute.meta.allowedTools, ['skill_weather']);
assert.strictEqual(weatherRoute.intent.risk, 'low');
assert.deepStrictEqual(weatherRoute.intent.toolNeed, ['web']);
assert.strictEqual(weatherRoute.facets.domain, 'weather');
assert.strictEqual(weatherRoute.facets.sourceScope, 'live');
assert.strictEqual(weatherRoute.facets.freshness, 'latest');
assert.notDeepStrictEqual(weatherRoute.meta.allowedTools, ['skill_weather_cloud']);

const hourlyRoute = detect('上海未来12小时逐小时天气');
assert.deepStrictEqual(hourlyRoute.meta.allowedTools, ['skill_weather']);
assert.deepStrictEqual(deriveWeatherToolArgs(hourlyRoute.cleanText), {
  location: '上海',
  sections: ['hourly'],
  days: 4,
  hours: 12
});
assert.deepStrictEqual(deriveWeatherToolArgs('上海未来两小时降雨'), {
  location: '上海',
  sections: ['minutely'],
  days: 4,
  hours: 24
});
assert.deepStrictEqual(deriveWeatherToolArgs('北京空气质量'), {
  location: '北京',
  sections: ['air'],
  days: 4,
  hours: 24
});
assert.deepStrictEqual(deriveWeatherToolArgs('广州天气预警'), {
  location: '广州',
  sections: ['warning'],
  days: 4,
  hours: 24
});
assert.deepStrictEqual(deriveWeatherToolArgs('伦敦天气'), {
  location: '伦敦',
  sections: ['overview'],
  days: 4,
  hours: 24
});
assert.deepStrictEqual(deriveWeatherToolArgs('上海天气和空气质量'), {
  location: '上海',
  sections: ['overview', 'air'],
  days: 4,
  hours: 24
});
assert.deepStrictEqual(detect('最新卫星云图').meta.allowedTools, ['skill_weather_cloud']);

for (const toolName of ['skill_earthquake_latest', 'skill_weather', 'skill_weather_cloud']) {
  assert.ok(TOOL_SCHEMAS.some((schema) => schema?.function?.name === toolName));
  assert.strictEqual(typeof TOOL_EXECUTORS[toolName], 'function');
  assert.ok(COMPANION_TOOL_PRESET.includes(toolName));
}
assert.ok(COMPANION_SAFE_READ_TOOLS.includes('skill_earthquake_latest'));
assert.ok(COMPANION_SAFE_READ_TOOLS.includes('skill_weather'));
assert.ok(!COMPANION_SAFE_READ_TOOLS.includes('skill_weather_cloud'));
assert.ok(GLOBAL_TOOL_NAME_SET.has('skill_earthquake_latest'));
assert.ok(GLOBAL_TOOL_NAME_SET.has('skill_weather'));
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
assert.strictEqual(getPolicy('skill_weather').risk, 'low');
assert.strictEqual(getPolicy('skill_weather').effect, 'none');
assert.strictEqual(getPolicy('skill_weather').capability, 'network');
assert.deepStrictEqual(enforceToolPolicy('skill_weather', {}), {
  location: '',
  sections: ['overview'],
  days: 4,
  hours: 24
});
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

  const runtimeConfig = { COMPANION_TOOL_MODE_ENABLED: true };
  const earthquakeExecution = resolveRouteExecution(genericEarthquakeRoute, runtimeConfig);
  assert.strictEqual(earthquakeExecution.allowTools, true);
  assert.deepStrictEqual(earthquakeExecution.allowedTools, ['skill_earthquake_latest']);

  const cloudExecution = resolveRouteExecution(cloudRoute, runtimeConfig);
  assert.strictEqual(cloudExecution.allowTools, true);
  assert.deepStrictEqual(cloudExecution.allowedTools, ['skill_weather_cloud']);

  console.log('environmentDataRouting.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
