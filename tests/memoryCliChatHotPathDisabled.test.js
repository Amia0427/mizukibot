const assert = require('assert');

process.env.MEMORY_CLI_ENABLED = 'true';
process.env.MEMORY_CLI_CHAT_ENABLED = 'false';
process.env.BOT_TOOL_MODE = 'full';

const config = require('../config');
config.MEMORY_CLI_ENABLED = true;
config.MEMORY_CLI_CHAT_ENABLED = false;
config.BOT_TOOL_MODE = 'full';

const {
  mergeAllowedToolsWithMemoryCli,
  shouldExposeMemoryCli
} = require('../api/runtimeV2/context/service');

const directChatOptions = {
  topRouteType: 'direct_chat',
  routePolicyKey: 'direct_chat/default',
  allowTools: true,
  routeMeta: {
    topRouteType: 'direct_chat'
  }
};

assert.strictEqual(shouldExposeMemoryCli(directChatOptions), false);
assert.deepStrictEqual(
  mergeAllowedToolsWithMemoryCli(['memory_cli'], directChatOptions),
  ['get_context_stats']
);
assert.deepStrictEqual(
  mergeAllowedToolsWithMemoryCli(['memory_cli', 'notebook_search'], directChatOptions),
  ['notebook_search', 'get_context_stats']
);

config.MEMORY_CLI_CHAT_ENABLED = true;
assert.strictEqual(shouldExposeMemoryCli(directChatOptions), true);

console.log('memoryCliChatHotPathDisabled.test.js passed');
