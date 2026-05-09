// api/toolRegistry.js
// Thin compatibility layer after registry split.
const config = require('../config');
const {
  filterCompanionToolExecutors,
  filterCompanionToolSchemas
} = require('../utils/companionTools');
const {
  callMcpTool,
  getCachedDynamicMcpToolRegistry,
  getDynamicMcpToolRegistry,
  warmMcpRegistry
} = require('./mcpRuntime');

let staticToolExecutorsCache = null;
let staticToolSchemasCache = null;
let dynamicSchemaCache = [];
let dynamicExecutorCache = {};
let dynamicNameCache = [];
let lastDynamicGeneratedAt = -1;

function loadStaticToolExecutors() {
  if (!staticToolExecutorsCache) {
    const mod = require('./toolExecutors');
    staticToolExecutorsCache = mod.TOOL_EXECUTORS && typeof mod.TOOL_EXECUTORS === 'object'
      ? mod.TOOL_EXECUTORS
      : {};
  }
  return staticToolExecutorsCache;
}

function loadStaticToolSchemas() {
  if (!staticToolSchemasCache) {
    const mod = require('./toolSchemas');
    staticToolSchemasCache = Array.isArray(mod.TOOL_SCHEMAS) ? mod.TOOL_SCHEMAS : [];
  }
  return staticToolSchemasCache;
}

const TOOL_EXECUTORS = new Proxy({}, {
  get(_target, prop) {
    if (prop === '__isLazyToolExecutorsProxy') return true;
    const executors = loadStaticToolExecutors();
    return executors[prop];
  },
  set(_target, prop, value) {
    const executors = loadStaticToolExecutors();
    executors[prop] = value;
    return true;
  },
  deleteProperty(_target, prop) {
    const executors = loadStaticToolExecutors();
    delete executors[prop];
    return true;
  },
  ownKeys() {
    return Reflect.ownKeys(loadStaticToolExecutors());
  },
  getOwnPropertyDescriptor(_target, prop) {
    const executors = loadStaticToolExecutors();
    if (!Object.prototype.hasOwnProperty.call(executors, prop)) return undefined;
    return {
      configurable: true,
      enumerable: true,
      writable: true,
      value: executors[prop]
    };
  },
  has(_target, prop) {
    return prop in loadStaticToolExecutors();
  }
});

const TOOL_SCHEMAS = new Proxy([], {
  get(_target, prop) {
    const schemas = loadStaticToolSchemas();
    const value = schemas[prop];
    return typeof value === 'function' ? value.bind(schemas) : value;
  },
  ownKeys() {
    return Reflect.ownKeys(loadStaticToolSchemas());
  },
  getOwnPropertyDescriptor(_target, prop) {
    const descriptor = Object.getOwnPropertyDescriptor(loadStaticToolSchemas(), prop);
    if (!descriptor) return undefined;
    return {
      ...descriptor,
      configurable: true
    };
  },
  has(_target, prop) {
    return prop in loadStaticToolSchemas();
  }
});

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
  return loadStaticToolSchemas();
}

function getStaticToolExecutors() {
  return loadStaticToolExecutors();
}

function getToolSchemas() {
  refreshDynamicCachesFromRegistry();
  return filterCompanionToolSchemas([...getStaticToolSchemas(), ...dynamicSchemaCache], config);
}


function getToolSchemaByName(toolName = '') {
  const name = String(toolName || '').trim();
  if (!name) return null;
  return getStaticToolSchemas().find((schema) => String(schema?.function?.name || '').trim() === name)
    || getDynamicToolDescriptors().map((item) => item.schema).find((schema) => String(schema?.function?.name || '').trim() === name)
    || null;
}

function getToolSchemaNames() {
  refreshDynamicCachesFromRegistry();
  const names = getStaticToolSchemas()
    .map((schema) => String(schema?.function?.name || '').trim())
    .filter(Boolean);
  return Array.from(new Set([...names, ...dynamicNameCache]));
}

function getToolExecutors() {
  refreshDynamicCachesFromRegistry();
  return filterCompanionToolExecutors({
    ...getStaticToolExecutors(),
    ...dynamicExecutorCache
  }, config);
}

function getToolExecutor(toolName = '') {
  const name = String(toolName || '').trim();
  if (!name) return null;
  refreshDynamicCachesFromRegistry();
  const staticExecutor = getStaticToolExecutors()[name];
  const dynamicExecutor = dynamicExecutorCache[name];
  const filtered = filterCompanionToolExecutors({
    ...(staticExecutor ? { [name]: staticExecutor } : {}),
    ...(dynamicExecutor ? { [name]: dynamicExecutor } : {})
  }, config);
  return filtered[name] || null;
}

function getToolNames() {
  return getToolSchemaNames().filter((name) => Boolean(getToolExecutor(name)));
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

module.exports = {
  TOOL_SCHEMAS,
  TOOL_EXECUTORS,
  getDynamicToolDescriptors,
  getDynamicToolNames,
  getStaticToolExecutors,
  getStaticToolSchemas,
  getToolExecutor,
  getToolExecutors,
  getToolNames,
  getToolSchemaByName,
  getToolSchemaNames,
  getToolSchemas,
  refreshDynamicToolRegistry,
  warmMcpRegistry
};
