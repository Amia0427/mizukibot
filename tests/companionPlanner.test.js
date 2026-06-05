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

  const explicitNasdaqQuestion = '据说你能联网搜索 那我问你纳斯达克2026年的最高点是多少 必须网络搜索再回答';
  const explicitWebRoute = {
    question: explicitNasdaqQuestion,
    cleanText: explicitNasdaqQuestion,
    topRouteType: 'direct_chat',
    meta: {
      chatMode: 'text_chat',
      toolIntent: 'maybe_tools',
      responseIntent: 'answer',
      allowedTools: ['web_search', 'web_fetch'],
      explicitWebSearchRequired: true
    },
    facets: { sourceScope: 'web', freshness: 'latest' }
  };

  const explicitAvailable = collectAvailableToolSummary(explicitWebRoute, {
    allowedTools: ['web_search', 'web_fetch'],
    toolCatalog: [
      { name: 'web_search', bucket: 'global_tools' },
      { name: 'web_fetch', bucket: 'global_tools' }
    ],
    config: { COMPANION_TOOL_MODE_ENABLED: true }
  });
  assert.deepStrictEqual(explicitAvailable.allowedToolNames.sort(), ['web_fetch', 'web_search'].sort());

  const correctedExplicitWeb = normalizePlannerDecisionV2({
    mode: 'chat_only',
    taskShape: 'fast_reply',
    allowedToolNames: [],
    steps: [],
    plannerMeta: { decisionSource: 'planner' }
  }, explicitWebRoute, {
    allowedTools: ['web_search', 'web_fetch'],
    toolCatalog: [
      { name: 'web_search', bucket: 'global_tools' },
      { name: 'web_fetch', bucket: 'global_tools' }
    ],
    config: { COMPANION_TOOL_MODE_ENABLED: true }
  });
  assert.strictEqual(correctedExplicitWeb.mode, 'tool_plan');
  assert.deepStrictEqual(correctedExplicitWeb.allowedToolNames, ['web_search']);
  assert.strictEqual(correctedExplicitWeb.steps[0].tool, 'web_search');
  assert.strictEqual(correctedExplicitWeb.taskShape, 'tool_augmented_reply');
  assert.strictEqual(correctedExplicitWeb.plannerMeta.toolGateReason, 'allow_safe_explicit_web_search');
  assert.strictEqual(correctedExplicitWeb.plannerMeta.normalizedByRule, true);

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
