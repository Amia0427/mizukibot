const config = require('../../config');

const DEFAULT_MCP_DISCOVERY_TTL_MS = Math.max(
  10_000,
  Number(process.env.MCP_DISCOVERY_TTL_MS || 5 * 60 * 1000) || 5 * 60 * 1000
);
const DEFAULT_MCP_INIT_TIMEOUT_MS = Math.max(
  2_000,
  Number(process.env.MCP_INIT_TIMEOUT_MS || config.TOOL_TIMEOUT_MS || 15_000) || 15_000
);
const DEFAULT_MCP_CALL_TIMEOUT_MS = Math.max(
  2_000,
  Number(process.env.MCP_CALL_TIMEOUT_MS || config.TOOL_TIMEOUT_MS || 20_000) || 20_000
);
const DEFAULT_MCP_RESULT_CHAR_BUDGET = Math.max(
  400,
  Number(process.env.MCP_RESULT_CHAR_BUDGET || 2_000) || 2_000
);
const DEFAULT_MCP_ARG_STRING_LIMIT = Math.max(
  32,
  Number(process.env.MCP_ARG_STRING_LIMIT || 500) || 500
);
const DEFAULT_MCP_MAX_OBJECT_KEYS = Math.max(
  4,
  Number(process.env.MCP_ARG_MAX_OBJECT_KEYS || 50) || 50
);
const DEFAULT_MCP_MAX_ARRAY_ITEMS = Math.max(
  4,
  Number(process.env.MCP_ARG_MAX_ARRAY_ITEMS || 20) || 20
);
const DEFAULT_MCP_MAX_DEPTH = Math.max(
  2,
  Number(process.env.MCP_ARG_MAX_DEPTH || 4) || 4
);

module.exports = {
  DEFAULT_MCP_ARG_STRING_LIMIT,
  DEFAULT_MCP_CALL_TIMEOUT_MS,
  DEFAULT_MCP_DISCOVERY_TTL_MS,
  DEFAULT_MCP_INIT_TIMEOUT_MS,
  DEFAULT_MCP_MAX_ARRAY_ITEMS,
  DEFAULT_MCP_MAX_DEPTH,
  DEFAULT_MCP_MAX_OBJECT_KEYS,
  DEFAULT_MCP_RESULT_CHAR_BUDGET
};
