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
const {
  collectAvailableToolSummary
} = require('../api/runtimeV2/planning/service');

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

const recallRoute = {
  question: '你还记得我们之前聊到哪了吗',
  cleanText: '你还记得我们之前聊到哪了吗',
  topRouteType: 'direct_chat',
  meta: {
    chatMode: 'chat',
    toolIntent: 'maybe_tools',
    responseIntent: 'answer',
    allowedTools: ['memory_cli', 'notebook_search']
  },
  intent: {
    needsMemory: true
  },
  facets: {
    sourceScope: 'notebook'
  }
};

const disabledAvailable = collectAvailableToolSummary(recallRoute, {
  allowedTools: ['memory_cli', 'notebook_search'],
  toolCatalog: [
    { name: 'memory_cli', bucket: 'global_tools' },
    { name: 'notebook_search', bucket: 'global_tools' }
  ]
});
assert.deepStrictEqual(disabledAvailable.allowedToolNames, ['notebook_search']);

config.MEMORY_CLI_CHAT_ENABLED = true;
const enabledAvailable = collectAvailableToolSummary(recallRoute, {
  allowedTools: ['memory_cli', 'notebook_search'],
  toolCatalog: [
    { name: 'memory_cli', bucket: 'global_tools' },
    { name: 'notebook_search', bucket: 'global_tools' }
  ]
});
assert.deepStrictEqual(enabledAvailable.allowedToolNames.sort(), ['memory_cli', 'notebook_search'].sort());
assert.strictEqual(shouldExposeMemoryCli(directChatOptions), true);

console.log('memoryCliChatHotPathDisabled.test.js passed');
