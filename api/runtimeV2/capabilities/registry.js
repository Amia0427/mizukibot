const { callMcpTool } = require('../../mcpRuntime');
const {
  getStaticToolSchemas,
  getDynamicToolDescriptors,
  getRawToolExecutor,
  getToolExecutor,
  getToolSchemaNames
} = require('../toolRegistryFacade');
const { GLOBAL_TOOL_REGISTRY } = require('../globalToolRuntimeFacade');
const { createCapabilityDescriptor, normalizeArray, normalizeObject, normalizeText } = require('../contracts');
const { isAdminPrivateChatContext } = require('../../../utils/privilegedPrivateChat');
const {
  WEB_LOOKUP_ALLOWED_TOOLS,
  routeHasExplicitWebSearchRequirement
} = require('../../../utils/webSearchRequirement');

function resolveStaticToolExecutor(toolName = '', args = {}) {
  const context = normalizeObject(args?.__context, {});
  if (
    WEB_LOOKUP_ALLOWED_TOOLS.includes(normalizeText(toolName))
    && routeHasExplicitWebSearchRequirement({
      question: context.question || context.routeMeta?.effectiveIntentText || context.routeMeta?.cleanText,
      cleanText: context.cleanText || context.routeMeta?.cleanText || context.routeMeta?.effectiveIntentText,
      rawText: context.rawText || context.routeMeta?.rawText,
      meta: normalizeObject(context.routeMeta, {})
    })
  ) {
    return getRawToolExecutor(toolName);
  }
  return isAdminPrivateChatContext(context)
    ? getRawToolExecutor(toolName)
    : getToolExecutor(toolName);
}

function buildStaticToolDescriptors() {
  const schemas = normalizeArray(getStaticToolSchemas());
  const schemaByName = new Map(
    schemas
      .map((schema) => {
        const name = normalizeText(schema?.function?.name);
        return name ? [name, schema] : null;
      })
      .filter(Boolean)
  );
  const names = getToolSchemaNames().filter((name) => schemaByName.has(name));

  return names.map((toolName) => createCapabilityDescriptor({
    name: toolName,
    kind: 'tool',
    schema: schemaByName.get(toolName) || null,
    executor: async (args = {}) => {
      const executor = resolveStaticToolExecutor(toolName, args);
      if (typeof executor !== 'function') return `Unknown tool: ${toolName}`;
      return executor(args);
    },
    metadata: {
      source: 'static'
    }
  }));
}

function buildGlobalToolDescriptors() {
  return normalizeArray(GLOBAL_TOOL_REGISTRY).map((item) => createCapabilityDescriptor({
    name: item.toolName,
    kind: 'global_tool',
    schema: item.schema || null,
    executor: item.executor || null,
    readOnly: item.readOnly !== false,
    sideEffect: item.readOnly === false,
    parallelSafe: item.readOnly !== false,
    maxCallsPerTurn: item.maxCallsPerTurn,
    allowedRoutes: item.allowedInRoutes,
    resultFormatter: item.resultFormatter,
    supportsPreflight: true,
    metadata: {
      source: 'global',
      executorName: item.executorName,
      schemaName: item.schemaName
    }
  }));
}

function buildDynamicMcpDescriptors() {
  return normalizeArray(getDynamicToolDescriptors()).map((item) => createCapabilityDescriptor({
    name: item.functionName,
    kind: 'mcp',
    schema: item.schema || null,
    executor: async (args = {}) => {
      try {
        const out = await callMcpTool(item.serverName, item.toolName, args, args?.__context || {});
        return String(out?.text || '').trim() || 'MCP tool returned no text output.';
      } catch (error) {
        return `MCP tool failed: ${String(error?.message || 'unknown error').slice(0, 240)}`;
      }
    },
    readOnly: false,
    parallelSafe: false,
    resumable: false,
    metadata: {
      source: 'mcp',
      serverName: item.serverName,
      toolName: item.toolName
    }
  }));
}

function buildSubagentDescriptors() {
  return [];
}

function buildCapabilityRegistry() {
  const descriptors = [
    ...buildStaticToolDescriptors(),
    ...buildGlobalToolDescriptors(),
    ...buildDynamicMcpDescriptors()
  ];
  const byName = new Map();
  for (const descriptor of descriptors) {
    if (!descriptor.name) continue;
    if (!byName.has(descriptor.name)) {
      byName.set(descriptor.name, descriptor);
      continue;
    }
    const existing = byName.get(descriptor.name);
    byName.set(descriptor.name, {
      ...existing,
      ...descriptor,
      schema: existing.schema || descriptor.schema,
      executor: existing.executor || descriptor.executor,
      metadata: {
        ...normalizeObject(existing.metadata, {}),
        ...normalizeObject(descriptor.metadata, {})
      }
    });
  }

  return {
    descriptors: [...byName.values()],
    byName
  };
}

module.exports = {
  buildCapabilityRegistry,
  buildDynamicMcpDescriptors,
  buildGlobalToolDescriptors,
  buildStaticToolDescriptors,
  buildSubagentDescriptors
};
