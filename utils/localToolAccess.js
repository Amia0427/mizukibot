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

module.exports = {
  filterAllowedToolNames,
  normalizeToolNames
};
