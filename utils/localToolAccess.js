function normalizeToolNames(toolNames = []) {
  return Array.isArray(toolNames)
    ? Array.from(new Set(
        toolNames
          .filter(Boolean)
          .map((item) => String(item).trim())
          .filter(Boolean)
      ))
    : [];
}

function filterAllowedToolNames(toolNames = [], allowedToolNames = []) {
  const allowedSet = new Set(normalizeToolNames(allowedToolNames));
  if (allowedSet.size === 0) return [];
  return normalizeToolNames(toolNames).filter((toolName) => allowedSet.has(toolName));
}

function isToolAllowedByRuntimeList(toolName = '', allowedToolNames = []) {
  const normalizedTool = String(toolName || '').trim();
  if (!normalizedTool) return false;
  const allowedSet = new Set(normalizeToolNames(allowedToolNames));
  return allowedSet.has(normalizedTool);
}

module.exports = {
  filterAllowedToolNames,
  isToolAllowedByRuntimeList,
  normalizeToolNames
};
