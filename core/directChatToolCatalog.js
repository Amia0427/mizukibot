const { getToolNames, getToolSchemas, getDynamicToolDescriptors } = require('../api/toolRegistry');
const { GLOBAL_TOOL_NAME_SET } = require('../api/globalToolRuntime');
const { normalizeToolNames } = require('../utils/localToolAccess');
const { getPolicy } = require('../utils/toolPolicy');
const { isAdminUser } = require('../api/qqActionService');
const EXCLUDED_DIRECT_CHAT_TOOL_NAMES = new Set([
  'assistant_task_breakdown'
]);

function isExcludedDirectChatTool(toolName = '') {
  const normalized = String(toolName || '').trim().toLowerCase();
  if (!normalized) return true;
  if (EXCLUDED_DIRECT_CHAT_TOOL_NAMES.has(normalized)) return true;
  return /subagent|openclaw|nanobot/i.test(normalized);
}

function resolveToolBucket(toolName = '') {
  const normalized = String(toolName || '').trim();
  if (!normalized) return 'local_tools';
  if (/^mcp_/i.test(normalized)) return 'mcp';
  if (/^skill_/i.test(normalized)) return 'skills';
  if (GLOBAL_TOOL_NAME_SET.has(normalized)) return 'global_tools';
  return 'local_tools';
}

function isWriteCapablePolicy(policy = {}) {
  const capability = String(policy?.capability || '').trim().toLowerCase();
  return capability.includes('write');
}

function buildSchemaDescriptionMap() {
  const map = new Map();
  for (const schema of getToolSchemas()) {
    const toolName = String(schema?.function?.name || '').trim();
    if (!toolName) continue;
    map.set(toolName, String(schema?.function?.description || '').trim());
  }
  return map;
}

function buildDynamicDescriptorMap() {
  const map = new Map();
  for (const descriptor of getDynamicToolDescriptors()) {
    const toolName = String(descriptor?.functionName || '').trim();
    if (!toolName) continue;
    map.set(toolName, {
      toolName,
      description: String(descriptor?.description || '').trim()
    });
  }
  return map;
}

function isToolVisibleInContext(toolName = '', context = {}) {
  const normalized = String(toolName || '').trim();
  if (!normalized) return false;
  if (new Set(['self_improvement_recent', 'self_improvement_search', 'self_improvement_patterns', 'self_improvement_rules', 'self_improvement_guides']).has(normalized)) {
    return false;
  }
  if (normalized === 'publish_qzone') {
    return isAdminUser(context.userId);
  }
  return true;
}

function buildDirectChatToolCatalog(context = {}) {
  const schemaDescriptions = buildSchemaDescriptionMap();
  const dynamicDescriptors = buildDynamicDescriptorMap();
  const toolNames = normalizeToolNames([
    ...getToolNames(),
    ...Array.from(dynamicDescriptors.keys())
  ]).filter((toolName) => !isExcludedDirectChatTool(toolName) && isToolVisibleInContext(toolName, context));

  return toolNames.map((toolName) => {
    const policy = getPolicy(toolName);
    const writeCapable = isWriteCapablePolicy(policy);
    const dynamicDescriptor = dynamicDescriptors.get(toolName);
    const description = String(
      dynamicDescriptor?.description
      || schemaDescriptions.get(toolName)
      || toolName
    ).trim();

    return {
      name: toolName,
      bucket: resolveToolBucket(toolName),
      description,
      readOnly: !writeCapable,
      writeCapable
    };
  });
}

function buildDirectChatToolCatalogSummary() {
  const input = arguments[0];
  const catalog = Array.isArray(input)
    ? input
    : buildDirectChatToolCatalog(input && typeof input === 'object' ? input : {});
  return catalog.map((descriptor) => ({
    name: descriptor.name,
    bucket: descriptor.bucket,
    description: descriptor.description,
    readOnly: descriptor.readOnly,
    writeCapable: descriptor.writeCapable
  }));
}

module.exports = {
  buildDirectChatToolCatalog,
  buildDirectChatToolCatalogSummary,
  isExcludedDirectChatTool,
  isToolVisibleInContext,
  resolveToolBucket
};
