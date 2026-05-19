const fs = require('fs');
const path = require('path');

function resolveMcpConfigPath(explicitPath = '') {
  const candidate = String(explicitPath || process.env.MIZUKI_MCP_CONFIG || '').trim();
  if (candidate) return path.resolve(candidate);
  return path.resolve(__dirname, '..', '..', '.mcp.json');
}

function safeReadJson(absPath) {
  try {
    if (!fs.existsSync(absPath)) return null;
    const raw = fs.readFileSync(absPath, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function expandEnvValue(value = '', env = process.env) {
  return String(value || '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
    return String(env?.[name] || '');
  });
}

function expandEnvObject(source = {}, env = process.env) {
  const output = {};
  for (const [key, value] of Object.entries(source && typeof source === 'object' ? source : {})) {
    output[key] = expandEnvValue(value, env);
  }
  return output;
}

function readMcpConfig(options = {}) {
  const configPath = resolveMcpConfigPath(options.configPath);
  return {
    configPath,
    config: safeReadJson(configPath)
  };
}

function splitPathEntries(rawPath = '') {
  return String(rawPath || '')
    .split(path.delimiter)
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function resolveCommandForSpawn(command = '', env = process.env) {
  const normalized = String(command || '').trim();
  if (!normalized) return '';
  if (path.isAbsolute(normalized) && fs.existsSync(normalized)) return normalized;

  const ext = path.extname(normalized).toLowerCase();
  const candidates = [];
  if (process.platform === 'win32') {
    if (ext) {
      candidates.push(normalized);
    } else {
      candidates.push(`${normalized}.cmd`, `${normalized}.exe`, `${normalized}.bat`, normalized);
    }
  } else {
    candidates.push(normalized);
  }

  const pathEntries = splitPathEntries(env?.PATH || process.env.PATH || '');
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
    for (const dir of pathEntries) {
      const abs = path.join(dir, candidate);
      try {
        if (fs.existsSync(abs)) return abs;
      } catch (_) {}
    }
  }

  return normalized;
}

function listConfiguredMcpServers(options = {}) {
  const { config: parsed, configPath } = readMcpConfig(options);
  const servers = parsed && parsed.mcpServers && typeof parsed.mcpServers === 'object'
    ? parsed.mcpServers
    : {};

  return Object.entries(servers).map(([serverName, definition]) => {
    const serverEnv = definition?.env && typeof definition.env === 'object'
      ? expandEnvObject(definition.env)
      : {};
    const mergedEnv = { ...process.env, ...serverEnv };
    const command = resolveCommandForSpawn(String(definition?.command || '').trim(), mergedEnv);
    return {
      serverName,
      configPath,
      command,
      args: Array.isArray(definition?.args) ? definition.args.map((item) => String(item)) : [],
      env: serverEnv,
      protocolMode: String(definition?.protocolMode || definition?.protocol || '').trim()
    };
  }).filter((item) => item.serverName && item.command);
}

module.exports = {
  expandEnvObject,
  expandEnvValue,
  listConfiguredMcpServers,
  readMcpConfig,
  resolveCommandForSpawn,
  resolveMcpConfigPath,
  safeReadJson,
  splitPathEntries
};
