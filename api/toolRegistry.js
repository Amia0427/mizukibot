// api/toolRegistry.js
// Thin compatibility layer after registry split.
const { TOOL_EXECUTORS: STATIC_TOOL_EXECUTORS } = require('./toolExecutors');
const { TOOL_SCHEMAS: STATIC_TOOL_SCHEMAS } = require('./toolSchemas');
const {
  callMcpTool,
  getCachedDynamicMcpToolRegistry,
  getDynamicMcpToolRegistry,
  warmMcpRegistry
} = require('./mcpRuntime');

let dynamicSchemaCache = [];
let dynamicExecutorCache = {};
let dynamicNameCache = [];
let lastDynamicGeneratedAt = -1;

function refreshDynamicCachesFromRegistry(registry = null) {
  const current = registry || getCachedDynamicMcpToolRegistry();
  const generatedAt = Number(current?.generatedAt || 0);
  if (generatedAt === lastDynamicGeneratedAt && dynamicNameCache.length > 0) return;

  dynamicSchemaCache = Array.isArray(current?.tools)
    ? current.tools.map((item) => item.schema).filter(Boolean)
    : [];

  dynamicExecutorCache = {};
  dynamicNameCache = [];
  for (const item of Array.isArray(current?.tools) ? current.tools : []) {
    const functionName = String(item?.functionName || '').trim();
    if (!functionName) continue;
    dynamicNameCache.push(functionName);
    dynamicExecutorCache[functionName] = async (args = {}) => {
      try {
        const out = await callMcpTool(item.serverName, item.toolName, args, args?.__context || {});
        return String(out?.text || '').trim() || 'MCP tool returned no text output.';
      } catch (error) {
        return `MCP tool failed: ${String(error?.message || 'unknown error').slice(0, 240)}`;
      }
    };
  }
  lastDynamicGeneratedAt = generatedAt;
}

function getStaticToolSchemas() {
  return Array.isArray(STATIC_TOOL_SCHEMAS) ? STATIC_TOOL_SCHEMAS : [];
}

function getStaticToolExecutors() {
  return STATIC_TOOL_EXECUTORS && typeof STATIC_TOOL_EXECUTORS === 'object'
    ? STATIC_TOOL_EXECUTORS
    : {};
}

function getToolSchemas() {
  refreshDynamicCachesFromRegistry();
  return [...getStaticToolSchemas(), ...dynamicSchemaCache];
}


function getToolSchemaByName(toolName = '') {
  const name = String(toolName || '').trim();
  if (!name) return null;
  return getToolSchemas().find((schema) => String(schema?.function?.name || '').trim() === name) || null;
}

function getToolExecutors() {
  refreshDynamicCachesFromRegistry();
  return {
    ...getStaticToolExecutors(),
    ...dynamicExecutorCache
  };
}

function getToolNames() {
  return Object.keys(getToolExecutors());
}

function getDynamicToolNames() {
  refreshDynamicCachesFromRegistry();
  return [...dynamicNameCache];
}

function getDynamicToolDescriptors() {
  const registry = getCachedDynamicMcpToolRegistry();
  refreshDynamicCachesFromRegistry(registry);
  return Array.isArray(registry?.tools)
    ? registry.tools.map((item) => ({ ...item }))
    : [];
}

async function refreshDynamicToolRegistry(options = {}) {
  const registry = await getDynamicMcpToolRegistry({
    ...options,
    forceRefresh: true
  });
  refreshDynamicCachesFromRegistry(registry);
  return registry;
}

const TOOL_SCHEMAS = STATIC_TOOL_SCHEMAS;
const TOOL_EXECUTORS = STATIC_TOOL_EXECUTORS;

module.exports = {
  TOOL_SCHEMAS,
  TOOL_EXECUTORS,
  getDynamicToolDescriptors,
  getDynamicToolNames,
  getStaticToolExecutors,
  getStaticToolSchemas,
  getToolExecutors,
  getToolNames,
  getToolSchemaByName,
  getToolSchemas,
  refreshDynamicToolRegistry,
  warmMcpRegistry
};
