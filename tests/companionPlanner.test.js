const assert = require('assert');

const {
  collectAvailableToolSummary,
  normalizePlannerDecisionV2,
  planRequestV2
} = require('../api/runtimeV2/planning/service');

module.exports = (async () => {
  const webRoute = {
    question: '?????? AI ??',
    cleanText: '?????? AI ??',
    topRouteType: 'direct_chat',
    meta: { chatMode: 'chat', toolIntent: 'force_tools', responseIntent: 'summary' },
    facets: { sourceScope: 'web', freshness: 'latest' }
  };

  const available = collectAvailableToolSummary(webRoute, {
    allowedTools: ['web_search', 'web_fetch', 'memory_cli', 'getWeather'],
    toolCatalog: [
      { name: 'web_search', bucket: 'global_tools' },
      { name: 'web_fetch', bucket: 'global_tools' },
      { name: 'memory_cli', bucket: 'global_tools' },
      { name: 'getWeather', bucket: 'local_tools' }
    ]
  });
  assert.deepStrictEqual(available.allowedToolNames.sort(), ['getWeather', 'memory_cli'].sort());

  const normalizedWeb = normalizePlannerDecisionV2({
    mode: 'tool_plan',
    taskShape: 'tool_augmented_reply',
    allowedToolNames: ['web_search', 'web_fetch'],
    steps: [
      { id: 's1', tool: 'web_search', args: { query: 'AI news' }, purpose: 'search' },
      { id: 's2', tool: 'web_fetch', args: { url: '' }, dependsOn: ['s1'], purpose: 'fetch' }
    ],
    plannerMeta: { decisionSource: 'planner' }
  }, webRoute, {
    allowedTools: ['web_search', 'web_fetch'],
    toolCatalog: [
      { name: 'web_search', bucket: 'global_tools' },
      { name: 'web_fetch', bucket: 'global_tools' }
    ]
  });
  assert.strictEqual(normalizedWeb.mode, 'chat_only');
  assert.deepStrictEqual(normalizedWeb.allowedToolNames, []);
  assert.deepStrictEqual(normalizedWeb.steps, []);
  assert.strictEqual(normalizedWeb.plannerMeta.backgroundResearchRequested, true);
  assert.ok(normalizedWeb.plannerMeta.backgroundResearchQuery);

  const weatherDecision = await planRequestV2({
    question: '??????',
    cleanText: '??????',
    topRouteType: 'direct_chat',
    routeMeta: { chatMode: 'chat', toolIntent: 'maybe_tools', responseIntent: 'answer' },
    facets: { domain: 'weather' },
    allowedTools: ['getWeather', 'web_search'],
    toolCatalog: [
      { name: 'getWeather', bucket: 'local_tools' },
      { name: 'web_search', bucket: 'global_tools' }
    ],
    planner: async () => ({
      mode: 'tool_plan',
      taskShape: 'tool_augmented_reply',
      allowedToolNames: ['web_search'],
      steps: [{ id: 's1', tool: 'web_search', args: { query: 'weather' }, purpose: 'search weather' }],
      plannerMeta: { decisionSource: 'planner' }
    })
  });
  assert.strictEqual(weatherDecision.mode, 'tool_plan');
  assert.deepStrictEqual(weatherDecision.allowedToolNames, ['getWeather']);
  assert.strictEqual(weatherDecision.steps[0].tool, 'getWeather');

  console.log('companionPlanner.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
