const assert = require('assert');

try {
  process.env.API_KEY = process.env.API_KEY || 'test-key';
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

  console.log('modelServiceToolSchemaCache.test.js passed');
} catch (error) {
  console.error(error);
  process.exit(1);
}
