const assert = require('assert');

const nativeOntology = require('../api/skills_native/ontology');
const { discoverMcpTools, callMcpTool } = require('../api/mcpRuntime');

module.exports = (async () => {
  const created = nativeOntology.mutateOntology('D:\\waifu\\data', {
    action: 'create',
    type: 'Task',
    id: 'task_test_1',
    props: { title: 'hello', status: 'open' }
  });
  assert.ok(String(created).includes('task_test_1'));

  const listed = nativeOntology.mutateOntology('D:\\waifu\\data', {
    action: 'list',
    type: 'Task'
  });
  assert.ok(typeof listed === 'string');

  const related = nativeOntology.mutateOntology('D:\\waifu\\data', {
    action: 'relate',
    from_id: 'task_test_1',
    rel: 'blocks',
    to_id: 'task_test_2'
  });
  assert.ok(String(related).includes('blocks'));

  const mcpTools = await discoverMcpTools();
  assert.ok(Array.isArray(mcpTools));
  assert.ok(mcpTools.some((item) => item.serverName === 'fetch'));
  assert.ok(mcpTools.some((item) => item.serverName === 'bing-search'));

  const mcpFetch = await callMcpTool('fetch', 'fetch_url', { url: 'https://example.com' });
  assert.strictEqual(mcpFetch.ok, true);
  assert.ok(String(mcpFetch.text).includes('Example Domain') || String(mcpFetch.text).includes('标题：'));

  console.log('nativeOntologyMcp.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
