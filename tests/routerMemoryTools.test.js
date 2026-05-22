const assert = require('assert');
const { getNotebookAllowedTools } = require('../core/router/memoryTools');

assert.deepStrictEqual(
  getNotebookAllowedTools({ needsMemory: true }),
  ['memory_cli', 'notebook_search', 'notebook_list_docs']
);
assert.deepStrictEqual(
  getNotebookAllowedTools({ needsMemory: false }),
  ['notebook_search', 'notebook_list_docs']
);

const tools = getNotebookAllowedTools({ needsMemory: true });
tools.push('mutated');
assert.deepStrictEqual(
  getNotebookAllowedTools({ needsMemory: true }),
  ['memory_cli', 'notebook_search', 'notebook_list_docs']
);

console.log('routerMemoryTools.test.js passed');
