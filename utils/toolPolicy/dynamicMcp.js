function createDynamicMcpArgNormalizer(deps = {}) {
  const {
    getToolRegistry
  } = deps;

  function normalizeDynamicMcpArgs(toolName, args = {}) {
    const descriptor = getToolRegistry().getDynamicToolDescriptors().find((item) => item.functionName === String(toolName || '').trim());
    if (!descriptor) return {};

    const schema = descriptor.inputSchema && typeof descriptor.inputSchema === 'object'
      ? descriptor.inputSchema
      : {};
    const properties = schema.properties && typeof schema.properties === 'object'
      ? schema.properties
      : {};
    const source = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const next = {};

    for (const key of Object.keys(properties)) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const value = source[key];

      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(trimmed)) {
          throw new Error('mcp args contain unsafe characters');
        }
        next[key] = trimmed.slice(0, 500);
        continue;
      }

      if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('mcp args contain invalid number');
        next[key] = value;
        continue;
      }

      if (typeof value === 'boolean' || value === null) {
        next[key] = value;
        continue;
      }

      if (Array.isArray(value)) {
        if (value.length > 20) throw new Error('mcp args array too large');
        next[key] = value.slice(0, 20).map((item) => {
          if (typeof item === 'string') {
            const trimmed = item.trim();
            if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(trimmed)) {
              throw new Error('mcp args contain unsafe characters');
            }
            return trimmed.slice(0, 500);
          }
          if (typeof item === 'number') {
            if (!Number.isFinite(item)) throw new Error('mcp args contain invalid number');
            return item;
          }
          if (typeof item === 'boolean' || item === null) return item;
          throw new Error('mcp args array item type not allowed');
        });
        continue;
      }

      if (value && typeof value === 'object') {
        const entries = Object.entries(value);
        if (entries.length > 50) throw new Error('mcp args object too large');
        const nested = {};
        for (const [nestedKey, nestedValue] of entries) {
          const safeKey = String(nestedKey || '').trim();
          if (!safeKey) continue;
          if (typeof nestedValue === 'string') {
            const trimmed = nestedValue.trim();
            if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(trimmed)) {
              throw new Error('mcp args contain unsafe characters');
            }
            nested[safeKey] = trimmed.slice(0, 500);
            continue;
          }
          if (typeof nestedValue === 'number') {
            if (!Number.isFinite(nestedValue)) throw new Error('mcp args contain invalid number');
            nested[safeKey] = nestedValue;
            continue;
          }
          if (typeof nestedValue === 'boolean' || nestedValue === null) {
            nested[safeKey] = nestedValue;
            continue;
          }
          throw new Error('mcp args nested type not allowed');
        }
        next[key] = nested;
      }
    }

    return next;
  }

  return {
    normalizeDynamicMcpArgs
  };
}

module.exports = {
  createDynamicMcpArgNormalizer
};
