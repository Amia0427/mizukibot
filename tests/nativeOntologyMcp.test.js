const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const nativeOntology = require('../api/skills_native/ontology');
const { discoverMcpTools, callMcpTool } = require('../api/mcpRuntime');
const { TOOL_EXECUTORS } = require('../api/toolExecutors');

module.exports = (async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-native-ontology-'));
  const originalWebFetch = TOOL_EXECUTORS.web_fetch;
  try {
    TOOL_EXECUTORS.web_fetch = async ({ url }) => `标题：Example Domain\nURL：${url}`;

    const created = nativeOntology.mutateOntology(dataDir, {
      action: 'create',
      type: 'Task',
      id: 'task_test_1',
      props: { title: 'hello', status: 'open' }
    });
    assert.ok(String(created).includes('task_test_1'));

    const listed = nativeOntology.mutateOntology(dataDir, {
      action: 'list',
      type: 'Task'
    });
    assert.ok(typeof listed === 'string');

    const related = nativeOntology.mutateOntology(dataDir, {
      action: 'relate',
      from_id: 'task_test_1',
      rel: 'blocks',
      to_id: 'task_test_2'
    });
    assert.ok(String(related).includes('blocks'));

    const mcpTools = await discoverMcpTools({ discoveryMode: 'static' });
    assert.ok(Array.isArray(mcpTools));
    assert.ok(mcpTools.some((item) => item.serverName === 'fetch'));
    assert.ok(mcpTools.some((item) => item.serverName === 'bing-search'));

    const mcpFetch = await callMcpTool('fetch', 'fetch_url', { url: 'https://example.com' }, {
      discoveryMode: 'static'
    });
    assert.strictEqual(mcpFetch.ok, true);
    assert.ok(String(mcpFetch.text).includes('Example Domain') || String(mcpFetch.text).includes('标题：'));

    console.log('nativeOntologyMcp.test.js passed');
  } finally {
    TOOL_EXECUTORS.web_fetch = originalWebFetch;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
