const NOTEBOOK_SEARCH_TOOLS = ['notebook_search', 'notebook_list_docs'];
const NOTEBOOK_MEMORY_TOOLS = ['memory_cli', ...NOTEBOOK_SEARCH_TOOLS];

function getNotebookAllowedTools({ needsMemory = false } = {}) {
  return needsMemory ? NOTEBOOK_MEMORY_TOOLS.slice() : NOTEBOOK_SEARCH_TOOLS.slice();
}

module.exports = {
  getNotebookAllowedTools
};
