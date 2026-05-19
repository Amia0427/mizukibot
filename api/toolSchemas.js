// api/toolSchemas.js
// Compatibility facade for static tool schema modules.
const { baseToolSchemas } = require('./toolSchemas/base');
const { batch2ToolSchemas } = require('./toolSchemas/batch2');
const { batch3ToolSchemas } = require('./toolSchemas/batch3');
const { memoryNotebookToolSchemas } = require('./toolSchemas/memoryNotebook');
const { extraToolSchemas } = require('./toolSchemas/extra');
const { skillsAndIntegrationsToolSchemas } = require('./toolSchemas/skillsAndIntegrations');

const TOOL_SCHEMAS = [
  ...baseToolSchemas,
  ...batch2ToolSchemas,
  ...batch3ToolSchemas,
  ...memoryNotebookToolSchemas,
  ...extraToolSchemas,
  ...skillsAndIntegrationsToolSchemas
];

module.exports = { TOOL_SCHEMAS };
