const { callMcpTool } = require('../../mcpRuntime');
const { askSubagentByBridge } = require('../../subagentExecutor');
const { getStaticToolExecutors, getStaticToolSchemas, getDynamicToolDescriptors } = require('../toolRegistryFacade');
const { GLOBAL_TOOL_REGISTRY } = require('../globalToolRuntimeFacade');
const { createCapabilityDescriptor, normalizeArray, normalizeObject, normalizeText } = require('../contracts');

function buildStaticToolDescriptors() {
  const executors = normalizeObject(getStaticToolExecutors(), {});
  const schemas = normalizeArray(getStaticToolSchemas());
  const schemaByName = new Map(
    schemas
      .map((schema) => {
        const name = normalizeText(schema?.function?.name);
        return name ? [name, schema] : null;
      })
      .filter(Boolean)
  );

  return Object.entries(executors).map(([toolName, executor]) => createCapabilityDescriptor({
    name: toolName,
    kind: 'tool',
    schema: schemaByName.get(toolName) || null,
    executor,
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
  return [
    createCapabilityDescriptor({
      name: 'subagent_bridge',
      kind: 'subagent',
      executor: async (args = {}) => askSubagentByBridge(
        String(args.question || args.prompt || args.input || '').trim(),
        args.userInfo || null,
        String(args.userId || args.user_id || '').trim() || 'subagent',
        args.customPrompt || null,
        args.imageUrl || null,
        normalizeObject(args.options, {})
      ),
      readOnly: false,
      parallelSafe: false,
      resumable: false,
      metadata: {
        source: 'subagent'
      }
    })
  ];
}

function buildCapabilityRegistry() {
  const descriptors = [
    ...buildStaticToolDescriptors(),
    ...buildGlobalToolDescriptors(),
    ...buildDynamicMcpDescriptors(),
    ...buildSubagentDescriptors()
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
