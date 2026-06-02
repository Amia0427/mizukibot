const assert = require('assert');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

const snapshot = { ...process.env };
let failed = false;

try {
  process.env.API_KEY = process.env.API_KEY || 'test-key';
  process.env.BOT_TOOL_MODE = 'companion';
  process.env.COMPANION_TOOL_MODE_ENABLED = 'true';
  process.env.COMPANION_ALLOWED_TOOLS = '';
  process.env.ADMIN_USER_IDS = 'admin_1';
  clearProjectCache();
  const service = require('../api/runtimeV2/model/service');

  const first = service.getFilteredToolSchemas({
    allowedTools: ['web_search', 'memory_cli'],
    disableTools: false
  });
  const second = service.getFilteredToolSchemas({
    allowedTools: ['memory_cli', 'web_search'],
    disableTools: false
  });
  const third = service.getFilteredToolSchemas({
    allowedTools: ['web_search'],
    disableTools: false
  });

  assert.ok(Array.isArray(first));
  assert.ok(Array.isArray(second));
  assert.ok(Array.isArray(third));
  assert.strictEqual(first.length, second.length);
  assert.ok(third.length <= first.length);

  const ordinaryPrivateQzoneSchemas = service.getFilteredToolSchemas({
    userId: 'user_1',
    routeMeta: {
      chatType: 'private',
      userId: 'user_1'
    },
    allowedTools: ['qzone_draft'],
    disableTools: false
  });
  assert.deepStrictEqual(
    ordinaryPrivateQzoneSchemas.map((schema) => schema.function.name),
    [],
    'ordinary private chat should still follow companion tool filtering'
  );

  const adminPrivateQzoneSchemas = service.getFilteredToolSchemas({
    userId: 'admin_1',
    routeMeta: {
      chatType: 'private',
      userId: 'admin_1'
    },
    allowedTools: ['qzone_draft'],
    disableTools: false
  });
  assert.deepStrictEqual(
    adminPrivateQzoneSchemas.map((schema) => schema.function.name),
    ['qzone_draft'],
    'admin private chat must keep qzone_draft visible to the main model'
  );

  console.log('modelServiceToolSchemaCache.test.js passed');
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
  clearProjectCache();
  if (failed) process.exit(1);
}
