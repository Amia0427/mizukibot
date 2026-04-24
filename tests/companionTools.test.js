const assert = require('assert');

const config = require('../config');
const {
  COMPANION_TOOL_PRESET,
  filterCompanionAllowedTools,
  filterCompanionToolExecutors,
  filterCompanionToolSchemas,
  getCompanionAllowedTools,
  isCompanionToolModeEnabled
} = require('../utils/companionTools');
const { getToolExecutors, getToolSchemas, getToolNames } = require('../api/toolRegistry');

module.exports = (async () => {
  assert.strictEqual(isCompanionToolModeEnabled({ BOT_TOOL_MODE: 'companion' }), true);
  assert.strictEqual(isCompanionToolModeEnabled({ BOT_TOOL_MODE: 'full' }), false);
  assert.deepStrictEqual(getCompanionAllowedTools({ COMPANION_ALLOWED_TOOLS: 'memory_cli,get_current_time' }), ['memory_cli', 'get_current_time']);
  assert.deepStrictEqual(
    filterCompanionAllowedTools(['memory_cli', 'web_search', 'getWeather'], { BOT_TOOL_MODE: 'companion' }),
    ['memory_cli', 'getWeather']
  );
  assert.deepStrictEqual(
    Object.keys(filterCompanionToolExecutors({ memory_cli: () => {}, web_search: () => {} }, { BOT_TOOL_MODE: 'companion' })),
    ['memory_cli']
  );
  assert.deepStrictEqual(
    filterCompanionToolSchemas([
      { function: { name: 'memory_cli' } },
      { function: { name: 'web_search' } }
    ], { BOT_TOOL_MODE: 'companion' }).map((item) => item.function.name),
    ['memory_cli']
  );

  assert.strictEqual(config.BOT_TOOL_MODE, 'companion');
  const allowedSet = new Set(COMPANION_TOOL_PRESET);
  const registeredToolNames = getToolNames();
  assert.ok(registeredToolNames.length > 0);
  assert.ok(registeredToolNames.every((toolName) => allowedSet.has(toolName)));
  assert.ok(getToolSchemas().every((schema) => allowedSet.has(schema.function.name)));
  assert.ok(Object.keys(getToolExecutors()).every((toolName) => allowedSet.has(toolName)));
  assert.ok(registeredToolNames.includes('memory_cli'));
  assert.ok(!registeredToolNames.includes('web_search'));
  assert.ok(!registeredToolNames.includes('skill_stock_price_query'));

  console.log('companionTools.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
