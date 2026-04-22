const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const config = require('../config');
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

const sessionPool = new Map();
const initializePromisePool = new Map();
const discoveryFailureCooldowns = new Map();
let cachedDynamicRegistry = {
  generatedAt: 0,
  tools: [],
  byName: new Map()
};

const STATIC_MCP_REPLACEMENTS = [
  {
    serverName: 'fetch',
    toolName: 'fetch_url',
    functionName: 'mcp_fetch_fetch_url',
    description: 'Fetch and extract readable webpage content',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' }
      },
      required: ['url']
    },
    targetTool: 'web_fetch'
  },
  {
    serverName: 'bing-search',
    toolName: 'search_web',
    functionName: 'mcp_bing_search_search_web',
    description: 'Search the web',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' }
      },
      required: ['query']
    },
    targetTool: 'web_search'
  },
  {
    serverName: 'amap-maps',
    toolName: 'search_places',
    functionName: 'mcp_amap_maps_search_places',
    description: 'Search nearby places',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: { type: 'string' },
        city: { type: 'string' }
      },
      required: ['keywords']
    },
    targetTool: 'search_nearby_places'
  },
  {
    serverName: 'howtocook-mcp',
    toolName: 'recipe_search',
    functionName: 'mcp_howtocook_mcp_recipe_search',
    description: 'Search local recipe records from the cached howtocook dataset',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' }
      },
      required: ['query']
    },
    targetTool: 'local_howtocook_recipe_search'
  }
];

function getStaticReplacementDescriptors(configuredServers = []) {
  const configuredNames = new Set(
    (Array.isArray(configuredServers) ? configuredServers : [])
      .map((item) => String(item?.serverName || '').trim())
      .filter(Boolean)
  );

  return STATIC_MCP_REPLACEMENTS
    .filter((item) => configuredNames.size === 0 || configuredNames.has(item.serverName))
    .map((item) => ({
      serverName: item.serverName,
      toolName: item.toolName,
      functionName: item.functionName,
      description: item.description,
      inputSchema: item.inputSchema,
      targetTool: item.targetTool
    }));
}

function logMcp(event, payload = {}) {
  try {
    console.log(`[${event}]`, payload);
  } catch (_) {}
}

function getDiscoveryFailureTtlMs() {
  return Math.max(1000, Number(config.MCP_DISCOVERY_FAILURE_TTL_MS || 30000) || 30000);
}

function readDiscoveryFailure(serverName = '') {
  const key = String(serverName || '').trim();
  if (!key) return null;
  const entry = discoveryFailureCooldowns.get(key);
  if (!entry) return null;
  if (Number(entry.expiresAt || 0) <= Date.now()) {
    discoveryFailureCooldowns.delete(key);
    return null;
  }
  return entry;
}

function clearDiscoveryFailure(serverName = '') {
  const key = String(serverName || '').trim();
  if (!key) return;
  discoveryFailureCooldowns.delete(key);
}

function writeDiscoveryFailure(serverName = '', error = null, stage = 'discover') {
  const key = String(serverName || '').trim();
  if (!key) return;
  const normalized = normalizeMcpError(error, 'MCP_DISCOVERY_FAILED', {
    fallbackMessage: `mcp ${stage} failed for ${key}`
  });
  discoveryFailureCooldowns.set(key, {
    code: String(normalized.code || '').trim(),
    message: String(normalized.message || '').trim(),
    stage,
    expiresAt: Date.now() + getDiscoveryFailureTtlMs()
  });
}

function maybeThrowDiscoveryFailureCooldown(serverName = '', stage = 'discover') {
  const entry = readDiscoveryFailure(serverName);
  if (!entry) return;
  throw normalizeMcpError(new Error(entry.message || `mcp ${stage} cooldown active for ${serverName}`), entry.code || 'MCP_DISCOVERY_COOLDOWN', {
    fallbackMessage: `mcp ${stage} cooldown active for ${serverName}`
  });
}

function resolveMcpConfigPath(explicitPath = '') {
  const candidate = String(explicitPath || process.env.MIZUKI_MCP_CONFIG || '').trim();
  if (candidate) return path.resolve(candidate);
  return path.resolve(__dirname, '..', '.mcp.json');
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

function shouldUseShellSpawn(command = '') {
  if (process.platform !== 'win32') return false;
  const ext = path.extname(String(command || '').trim()).toLowerCase();
  return ext === '.cmd' || ext === '.bat';
}

function quoteWindowsArg(value = '') {
  const text = String(value || '');
  if (!text) return '""';
  if (!/[\s"]/g.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function buildSpawnConfig(serverConfig = {}) {
  const resolvedCommand = String(serverConfig.command || '').trim();
  const resolvedArgs = Array.isArray(serverConfig.args) ? [...serverConfig.args] : [];
  if (!shouldUseShellSpawn(resolvedCommand)) {
    return {
      command: resolvedCommand,
      args: resolvedArgs,
      options: {
        shell: false
      }
    };
  }

  const cmdExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  const commandLine = [resolvedCommand, ...resolvedArgs].map((item) => quoteWindowsArg(item)).join(' ');
  return {
    command: cmdExe,
    args: ['/d', '/s', '/c', commandLine],
    options: {
      shell: false
    }
  };
}

function normalizeSpawnFailure(error, serverName = '') {
  const code = String(error?.code || '').trim().toUpperCase();
  if (code === 'EPERM') {
    return normalizeMcpError(new Error(
      `failed to start mcp server ${serverName}: child_process spawn is blocked by the current environment (${error.message || 'spawn EPERM'})`
    ), 'MCP_PROCESS_ERROR');
  }
  return normalizeMcpError(error, 'MCP_PROCESS_ERROR', {
    fallbackMessage: `failed to start mcp server ${serverName}`
  });
}

function listConfiguredMcpServers(options = {}) {
  const { config: parsed, configPath } = readMcpConfig(options);
  const servers = parsed && parsed.mcpServers && typeof parsed.mcpServers === 'object'
    ? parsed.mcpServers
    : {};

  return Object.entries(servers).map(([serverName, definition]) => {
    const serverEnv = definition?.env && typeof definition.env === 'object' ? { ...definition.env } : {};
    const mergedEnv = { ...process.env, ...serverEnv };
    const command = resolveCommandForSpawn(String(definition?.command || '').trim(), mergedEnv);
    return {
      serverName,
      configPath,
      command,
      args: Array.isArray(definition?.args) ? definition.args.map((item) => String(item)) : [],
      env: serverEnv
    };
  }).filter((item) => item.serverName && item.command);
}

function sanitizeMcpNamePart(value = '', fallback = 'tool') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  return normalized || fallback;
}

function buildDynamicMcpToolName(serverName = '', toolName = '') {
  return `mcp_${sanitizeMcpNamePart(serverName, 'server')}_${sanitizeMcpNamePart(toolName, 'tool')}`;
}

function normalizeMcpError(error, fallbackCode = 'MCP_ERROR', extra = {}) {
  const normalized = new Error(String(
    error?.message
    || error?.error?.message
    || extra.fallbackMessage
    || 'mcp runtime error'
  ).trim());
  normalized.code = String(
    error?.code
    || error?.error?.code
    || extra.code
    || fallbackCode
  ).trim();
  normalized.detail = extra.detail || null;
  return normalized;
}

function invalidateServerCache(serverName = '') {
  const entry = sessionPool.get(serverName);
  if (entry) {
    entry.toolsCache = null;
    entry.toolsFetchedAt = 0;
  }
  initializePromisePool.delete(serverName);
  cachedDynamicRegistry = {
    generatedAt: 0,
    tools: [],
    byName: new Map()
  };
}

function resetSessionEntry(serverName = '') {
  const entry = sessionPool.get(serverName);
  if (!entry) return;
  sessionPool.delete(serverName);
  initializePromisePool.delete(serverName);
  entry.exited = true;
  entry.initialized = false;
  const pendingErrors = Array.from(entry.pending.values());
  entry.pending.clear();
  for (const pending of pendingErrors) {
    pending.reject(normalizeMcpError(new Error(`mcp session reset: ${serverName}`), 'MCP_SESSION_RESET'));
  }
  try {
    entry.process?.kill();
  } catch (_) {}
}

function encodeJsonRpcPayload(message = {}, protocolMode = 'line') {
  const body = JSON.stringify(message);
  if (protocolMode === 'frame') {
    const bodyBuffer = Buffer.from(body, 'utf8');
    const header = Buffer.from(`Content-Length: ${bodyBuffer.length}\r\n\r\n`, 'utf8');
    return Buffer.concat([header, bodyBuffer]);
  }
  return Buffer.from(`${body}\n`, 'utf8');
}

function trimLeadingMessageWhitespace(buffer = Buffer.alloc(0)) {
  let offset = 0;
  while (offset < buffer.length && [0x0a, 0x0d, 0x20, 0x09].includes(buffer[offset])) {
    offset += 1;
  }
  return offset > 0 ? buffer.slice(offset) : buffer;
}

function tryParseLineDelimitedMessage(buffer = Buffer.alloc(0)) {
  const normalized = trimLeadingMessageWhitespace(buffer);
  if (!normalized.length) return { rest: normalized, skip: true };

  const newlineIndex = normalized.indexOf(0x0a);
  if (newlineIndex < 0) return null;

  let lineBuffer = normalized.slice(0, newlineIndex);
  if (lineBuffer.length && lineBuffer[lineBuffer.length - 1] === 0x0d) {
    lineBuffer = lineBuffer.slice(0, -1);
  }
  const raw = lineBuffer.toString('utf8').trim();
  return {
    raw,
    rest: normalized.slice(newlineIndex + 1),
    skip: !raw
  };
}

function tryParseFramedMessage(buffer = Buffer.alloc(0)) {
  const normalized = trimLeadingMessageWhitespace(buffer);
  if (!normalized.length) return { rest: normalized, skip: true };

  const headerEndCrLf = normalized.indexOf(Buffer.from('\r\n\r\n'));
  const headerEndLf = normalized.indexOf(Buffer.from('\n\n'));
  let headerEnd = -1;
  let separatorLength = 0;

  if (headerEndCrLf >= 0 && (headerEndLf < 0 || headerEndCrLf <= headerEndLf)) {
    headerEnd = headerEndCrLf;
    separatorLength = 4;
  } else if (headerEndLf >= 0) {
    headerEnd = headerEndLf;
    separatorLength = 2;
  } else {
    return null;
  }

  const headerText = normalized.slice(0, headerEnd).toString('utf8');
  const contentLengthMatch = headerText.match(/content-length\s*:\s*(\d+)/i);
  if (!contentLengthMatch) {
    return {
      error: normalizeMcpError(new Error('missing content-length header'), 'MCP_INVALID_FRAME'),
      rest: Buffer.alloc(0)
    };
  }

  const contentLength = Number(contentLengthMatch[1]);
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    return {
      error: normalizeMcpError(new Error('invalid content-length header'), 'MCP_INVALID_FRAME'),
      rest: Buffer.alloc(0)
    };
  }

  const bodyStart = headerEnd + separatorLength;
  const bodyEnd = bodyStart + contentLength;
  if (normalized.length < bodyEnd) return null;

  return {
    raw: normalized.slice(bodyStart, bodyEnd).toString('utf8').trim(),
    rest: normalized.slice(bodyEnd),
    skip: false
  };
}

function consumeStdoutBuffer(entry) {
  let safety = 0;
  while (safety < 1000) {
    safety += 1;
    let parsed = null;
    if (entry.protocolMode === 'frame') {
      parsed = tryParseFramedMessage(entry.buffer);
    } else if (entry.protocolMode === 'line') {
      parsed = tryParseLineDelimitedMessage(entry.buffer);
    } else {
      const trimmed = trimLeadingMessageWhitespace(entry.buffer);
      const leading = trimmed.slice(0, Math.min(32, trimmed.length)).toString('utf8').toLowerCase();
      parsed = leading.startsWith('content-length:')
        ? tryParseFramedMessage(entry.buffer)
        : tryParseLineDelimitedMessage(entry.buffer);
    }

    if (!parsed) break;
    entry.buffer = parsed.rest;

    if (parsed.error) {
      const pendingErrors = Array.from(entry.pending.values());
      entry.pending.clear();
      for (const pending of pendingErrors) {
        pending.reject(parsed.error);
      }
      invalidateServerCache(entry.serverName);
      logMcp('mcp_tool_error', {
        serverName: entry.serverName,
        stage: 'parse',
        error: parsed.error?.message || 'invalid_frame'
      });
      break;
    }

    if (parsed.skip) continue;

    let message = null;
    try {
      message = JSON.parse(String(parsed.raw || '').trim());
    } catch (error) {
      const pendingErrors = Array.from(entry.pending.values());
      entry.pending.clear();
      for (const pending of pendingErrors) {
        pending.reject(normalizeMcpError(error, 'MCP_INVALID_JSON', {
          fallbackMessage: `invalid json from mcp server ${entry.serverName}`,
          detail: String(parsed.raw || '').slice(0, 400)
        }));
      }
      invalidateServerCache(entry.serverName);
      logMcp('mcp_tool_error', {
        serverName: entry.serverName,
        stage: 'parse',
        error: 'invalid_json'
      });
      break;
    }

    const id = message && message.id !== undefined && message.id !== null
      ? String(message.id)
      : '';
    if (!id || !entry.pending.has(id)) continue;
    const pending = entry.pending.get(id);
    entry.pending.delete(id);
    if (message.error) {
      pending.reject(normalizeMcpError(message.error, 'MCP_PROTOCOL_ERROR', {
        fallbackMessage: `mcp error from ${entry.serverName}`
      }));
    } else {
      pending.resolve(message.result);
    }
  }
}

function ensureSessionEntry(serverConfig = {}) {
  const existing = sessionPool.get(serverConfig.serverName);
  if (existing && existing.process && !existing.process.killed && !existing.exited) {
    return existing;
  }

  const spawnConfig = buildSpawnConfig(serverConfig);
  let child = null;
  try {
    child = childProcess.spawn(spawnConfig.command, spawnConfig.args, {
      cwd: path.dirname(serverConfig.configPath || resolveMcpConfigPath()),
      env: { ...process.env, ...(serverConfig.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...spawnConfig.options
    });
  } catch (error) {
    throw normalizeSpawnFailure(error, serverConfig.serverName);
  }

  const entry = {
    serverName: serverConfig.serverName,
    command: serverConfig.command,
    args: Array.isArray(serverConfig.args) ? [...serverConfig.args] : [],
    env: serverConfig.env && typeof serverConfig.env === 'object' ? { ...serverConfig.env } : {},
    configPath: serverConfig.configPath || resolveMcpConfigPath(),
    process: child,
    nextId: 1,
    buffer: Buffer.alloc(0),
    stderr: '',
    pending: new Map(),
    initialized: false,
    initializePromise: null,
    toolsCache: null,
    toolsFetchedAt: 0,
    exited: false,
    protocolMode: String(serverConfig.protocolMode || '').trim() || 'auto'
  };

  child.stderr.setEncoding('utf8');

  child.stdout.on('data', (chunk) => {
    const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ''), 'utf8');
    entry.buffer = entry.buffer.length > 0
      ? Buffer.concat([entry.buffer, nextChunk])
      : nextChunk;
    consumeStdoutBuffer(entry);
  });

  child.stderr.on('data', (chunk) => {
    const text = String(chunk || '').trim();
    if (!text) return;
    entry.stderr = `${entry.stderr}\n${text}`.trim();
  });

  child.on('error', (error) => {
    entry.exited = true;
    const pendingErrors = Array.from(entry.pending.values());
    entry.pending.clear();
    for (const pending of pendingErrors) {
      pending.reject(normalizeSpawnFailure(error, entry.serverName));
    }
    invalidateServerCache(entry.serverName);
  });

  child.on('exit', (code, signal) => {
    entry.exited = true;
    entry.initialized = false;
    entry.initializePromise = null;
    entry.toolsCache = null;
    entry.toolsFetchedAt = 0;
    const pendingErrors = Array.from(entry.pending.values());
    entry.pending.clear();
    for (const pending of pendingErrors) {
      pending.reject(normalizeMcpError(new Error(`mcp server exited (${code ?? 'null'}${signal ? `/${signal}` : ''})`), 'MCP_PROCESS_EXIT', {
        detail: entry.stderr.slice(-500)
      }));
    }
    invalidateServerCache(entry.serverName);
  });

  sessionPool.set(serverConfig.serverName, entry);
  return entry;
}

function sendJsonRpc(entry, method, params = {}, options = {}) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs || DEFAULT_MCP_CALL_TIMEOUT_MS) || DEFAULT_MCP_CALL_TIMEOUT_MS);
  if (!entry || !entry.process || entry.exited) {
    return Promise.reject(normalizeMcpError(new Error(`mcp server unavailable: ${entry?.serverName || 'unknown'}`), 'MCP_SERVER_UNAVAILABLE'));
  }

  const id = String(entry.nextId++);
  const payload = {
    jsonrpc: '2.0',
    id,
    method,
    params
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      entry.pending.delete(id);
      reject(normalizeMcpError(new Error(`mcp request timeout: ${entry.serverName}/${method}`), 'MCP_TIMEOUT'));
    }, timeoutMs);

    entry.pending.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      }
    });

    try {
      entry.process.stdin.write(encodeJsonRpcPayload(payload, entry.protocolMode));
    } catch (error) {
      clearTimeout(timer);
      entry.pending.delete(id);
      reject(normalizeMcpError(error, 'MCP_WRITE_ERROR', {
        fallbackMessage: `failed to write request to ${entry.serverName}`
      }));
    }
  });
}

async function initializeServer(entry) {
  maybeThrowDiscoveryFailureCooldown(entry?.serverName, 'initialize');
  if (entry.initialized) return entry;
  if (initializePromisePool.has(entry.serverName)) return initializePromisePool.get(entry.serverName);

  const initializePromise = (async () => {
    let activeEntry = entry;
    logMcp('mcp_server_init', { serverName: activeEntry.serverName, status: 'start' });
    const protocolModes = activeEntry.protocolMode === 'auto'
      ? ['frame', 'line']
      : [activeEntry.protocolMode];

    let lastError = null;
    for (const protocolMode of protocolModes) {
      if (activeEntry.exited) break;
      activeEntry.protocolMode = protocolMode;
      try {
        await sendJsonRpc(activeEntry, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'mizukibot',
            version: '1.0.0'
          }
        }, {
          timeoutMs: DEFAULT_MCP_INIT_TIMEOUT_MS
        });
        try {
          activeEntry.process.stdin.write(encodeJsonRpcPayload({
            jsonrpc: '2.0',
            method: 'notifications/initialized'
          }, activeEntry.protocolMode));
        } catch (_) {}
        activeEntry.initialized = true;
        logMcp('mcp_server_init', {
          serverName: activeEntry.serverName,
          status: 'ok',
          protocolMode
        });
        clearDiscoveryFailure(activeEntry.serverName);
        return activeEntry;
      } catch (error) {
        lastError = error;
        if (protocolModes.length > 1 && protocolMode !== protocolModes[protocolModes.length - 1]) {
          resetSessionEntry(activeEntry.serverName);
          const nextProtocolMode = protocolModes[protocolModes.indexOf(protocolMode) + 1];
          const serverConfig = listConfiguredMcpServers({ configPath: activeEntry.configPath })
            .find((item) => item.serverName === activeEntry.serverName) || {
            serverName: activeEntry.serverName,
            command: activeEntry.command,
            args: activeEntry.args,
            env: activeEntry.env,
            configPath: activeEntry.configPath
          };
          activeEntry = ensureSessionEntry({
            ...serverConfig,
            protocolMode: nextProtocolMode
          });
          continue;
        }
      }
    }

    activeEntry.initialized = false;
    logMcp('mcp_tool_error', {
      serverName: activeEntry.serverName,
      stage: 'initialize',
      error: lastError?.message || String(lastError || '')
    });
    writeDiscoveryFailure(activeEntry.serverName, lastError, 'initialize');
    throw normalizeMcpError(lastError, 'MCP_INIT_FAILED', {
      fallbackMessage: `failed to initialize mcp server ${activeEntry.serverName}`
    });
  })()
    .finally(() => {
      initializePromisePool.delete(entry.serverName);
    });

  initializePromisePool.set(entry.serverName, initializePromise);
  return initializePromise;
}

function normalizeMcpToolDescriptor(serverName = '', rawTool = {}) {
  const name = String(rawTool?.name || '').trim();
  if (!name) return null;

  const inputSchema = rawTool?.inputSchema && typeof rawTool.inputSchema === 'object'
    ? { ...rawTool.inputSchema }
    : { type: 'object', properties: {} };

  const functionName = buildDynamicMcpToolName(serverName, name);
  return {
    serverName,
    toolName: name,
    functionName,
    description: String(rawTool?.description || `${serverName}/${name}`).trim(),
    inputSchema,
    rawTool
  };
}

async function discoverServerTools(serverConfig = {}, options = {}) {
  maybeThrowDiscoveryFailureCooldown(serverConfig?.serverName, 'discover');
  const entry = await initializeServer(ensureSessionEntry(serverConfig));

  const ttlMs = Math.max(1, Number(options.ttlMs || DEFAULT_MCP_DISCOVERY_TTL_MS) || DEFAULT_MCP_DISCOVERY_TTL_MS);
  const now = Date.now();
  if (entry.toolsCache && (now - Number(entry.toolsFetchedAt || 0)) < ttlMs) {
    return entry.toolsCache;
  }

  try {
    const result = await sendJsonRpc(entry, 'tools/list', {}, {
      timeoutMs: Math.max(DEFAULT_MCP_CALL_TIMEOUT_MS, ttlMs)
    });
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    entry.toolsCache = tools
      .map((tool) => normalizeMcpToolDescriptor(serverConfig.serverName, tool))
      .filter(Boolean);
    entry.toolsFetchedAt = now;
    clearDiscoveryFailure(serverConfig.serverName);
    logMcp('mcp_tools_discovered', {
      serverName: serverConfig.serverName,
      count: entry.toolsCache.length
    });
    return entry.toolsCache;
  } catch (error) {
    writeDiscoveryFailure(serverConfig.serverName, error, 'discover');
    throw error;
  }
}

async function discoverMcpTools(options = {}) {
  const configuredServers = listConfiguredMcpServers(options);
  const all = [];
  const discoveredKeys = new Set();
  for (const serverConfig of configuredServers) {
    try {
      const tools = await discoverServerTools(serverConfig, options);
      all.push(...tools);
      for (const descriptor of tools) {
        discoveredKeys.add(`${descriptor.serverName}:${descriptor.toolName}`);
      }
    } catch (error) {
      logMcp('mcp_tool_error', {
        serverName: serverConfig.serverName,
        stage: 'discover',
        error: error?.message || String(error || '')
      });
    }
  }

  const fallbacks = getStaticReplacementDescriptors(configuredServers)
    .filter((item) => !discoveredKeys.has(`${item.serverName}:${item.toolName}`));
  return [...all, ...fallbacks];
}

function sanitizeMcpArgumentValue(value, depth = 0) {
  if (depth > DEFAULT_MCP_MAX_DEPTH) {
    throw new Error('mcp args nested too deep');
  }

  if (value === null || value === undefined) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('mcp args contain invalid number');
    return value;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(trimmed)) {
      throw new Error('mcp args contain unsafe control characters');
    }
    return trimmed.length > DEFAULT_MCP_ARG_STRING_LIMIT
      ? trimmed.slice(0, DEFAULT_MCP_ARG_STRING_LIMIT)
      : trimmed;
  }
  if (Array.isArray(value)) {
    if (value.length > DEFAULT_MCP_MAX_ARRAY_ITEMS) {
      throw new Error('mcp args array too large');
    }
    return value.map((item) => sanitizeMcpArgumentValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length > DEFAULT_MCP_MAX_OBJECT_KEYS) {
      throw new Error('mcp args object too large');
    }
    const next = {};
    for (const [key, nested] of entries) {
      const safeKey = String(key || '').trim();
      if (!safeKey) continue;
      next[safeKey] = sanitizeMcpArgumentValue(nested, depth + 1);
    }
    return next;
  }
  return String(value);
}

function sanitizeMcpArgs(rawArgs = {}, inputSchema = {}) {
  const schema = inputSchema && typeof inputSchema === 'object' ? inputSchema : {};
  const properties = schema.properties && typeof schema.properties === 'object'
    ? schema.properties
    : {};
  const allowedKeys = Object.keys(properties);
  const source = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
  const next = {};

  for (const key of allowedKeys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    next[key] = sanitizeMcpArgumentValue(source[key], 0);
  }

  return next;
}

function truncateText(text = '', limit = DEFAULT_MCP_RESULT_CHAR_BUDGET) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 12)).trim()} [truncated]`;
}

function summarizeJson(value) {
  try {
    return truncateText(JSON.stringify(value), DEFAULT_MCP_RESULT_CHAR_BUDGET);
  } catch (_) {
    return truncateText(String(value || ''), DEFAULT_MCP_RESULT_CHAR_BUDGET);
  }
}

function extractTextFromMcpResult(result) {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return truncateText(result);

  if (Array.isArray(result?.content)) {
    const texts = result.content
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        if (typeof item.text === 'string') return item.text;
        if (typeof item.content === 'string') return item.content;
        return '';
      })
      .filter(Boolean);
    if (texts.length > 0) return truncateText(texts.join('\n\n'));
  }

  if (typeof result?.text === 'string') return truncateText(result.text);
  if (typeof result?.content === 'string') return truncateText(result.content);
  return summarizeJson(result);
}

async function callMcpTool(serverName = '', toolName = '', args = {}, context = {}) {
  maybeThrowDiscoveryFailureCooldown(serverName, 'call');
  const configuredServers = listConfiguredMcpServers(context);
  const serverConfig = configuredServers.find((item) => item.serverName === serverName);
  const replacement = STATIC_MCP_REPLACEMENTS.find((item) => item.serverName === serverName && item.toolName === toolName);

  let descriptor = null;
  let discoveryError = null;
  if (serverConfig) {
    try {
      const tools = await discoverServerTools(serverConfig, context);
      descriptor = tools.find((item) => item.toolName === toolName) || null;
    } catch (error) {
      discoveryError = normalizeMcpError(error, 'MCP_DISCOVERY_FAILED', {
        fallbackMessage: `failed to discover mcp tools from ${serverName}`
      });
      logMcp('mcp_tool_error', {
        serverName,
        toolName,
        stage: 'discover_for_call',
        error: discoveryError.message
      });
    }
  }

  if (!descriptor && replacement) {
    const { getToolExecutors } = require('./toolRegistry');
    const executors = getToolExecutors();
    const executor = executors[replacement.targetTool];
    if (typeof executor !== 'function') {
      throw normalizeMcpError(new Error(`replacement tool unavailable: ${replacement.targetTool}`), 'MCP_TOOL_CALL_FAILED');
    }
    const result = await executor(args);
    logMcp('mcp_tool_fallback', {
      serverName,
      toolName,
      targetTool: replacement.targetTool,
      reason: discoveryError?.message || (serverConfig ? 'tool_not_found' : 'server_not_found')
    });
    return {
      ok: true,
      text: String(result || '').trim(),
      safeArgs: args,
      result,
      fallback: true,
      diagnostic: {
        mode: 'static_replacement',
        serverName,
        toolName,
        targetTool: replacement.targetTool,
        reason: discoveryError?.message || (serverConfig ? 'tool_not_found' : 'server_not_found'),
        errorCode: discoveryError?.code || ''
      }
    };
  }

  if (!serverConfig) {
    throw normalizeMcpError(new Error(`mcp server not found: ${serverName}`), 'MCP_SERVER_NOT_FOUND');
  }

  if (!descriptor) {
    if (discoveryError) throw discoveryError;
    throw normalizeMcpError(new Error(`mcp tool not found: ${serverName}/${toolName}`), 'MCP_TOOL_NOT_FOUND');
  }

  const safeArgs = sanitizeMcpArgs(args, descriptor.inputSchema);
  logMcp('mcp_tool_call', {
    serverName,
    toolName,
    functionName: descriptor.functionName,
    argsKeys: Object.keys(safeArgs)
  });

  try {
    const entry = await initializeServer(ensureSessionEntry(serverConfig));
    const result = await sendJsonRpc(entry, 'tools/call', {
      name: descriptor.toolName,
      arguments: safeArgs
    }, {
      timeoutMs: Math.max(DEFAULT_MCP_CALL_TIMEOUT_MS, Number(context.timeoutMs || 0) || 0)
    });
    const text = extractTextFromMcpResult(result);
    clearDiscoveryFailure(serverName);
    logMcp('mcp_tool_result', {
      serverName,
      toolName,
      functionName: descriptor.functionName,
      preview: text.slice(0, 200)
    });
    return {
      ok: true,
      text,
      safeArgs,
      result,
      fallback: false,
      diagnostic: {
        mode: 'mcp_stdio',
        serverName,
        toolName,
        targetTool: '',
        reason: '',
        errorCode: ''
      }
    };
  } catch (error) {
    const normalized = normalizeMcpError(error, 'MCP_TOOL_CALL_FAILED', {
      fallbackMessage: `mcp tool call failed: ${serverName}/${toolName}`
    });
    writeDiscoveryFailure(serverName, normalized, 'call');
    logMcp('mcp_tool_error', {
      serverName,
      toolName,
      functionName: descriptor.functionName,
      error: normalized.message
    });
    throw normalized;
  }
}

function buildOpenAiFunctionSchema(descriptor = {}) {
  return {
    type: 'function',
    function: {
      name: descriptor.functionName,
      description: descriptor.description,
      parameters: descriptor.inputSchema && typeof descriptor.inputSchema === 'object'
        ? descriptor.inputSchema
        : { type: 'object', properties: {} }
    }
  };
}

async function getDynamicMcpToolRegistry(options = {}) {
  const forceRefresh = Boolean(options.forceRefresh);
  if (!forceRefresh && cachedDynamicRegistry.generatedAt > 0 && cachedDynamicRegistry.tools.length > 0) {
    return cachedDynamicRegistry;
  }

  const tools = await discoverMcpTools(options);
  const registryTools = tools.map((descriptor) => ({
    ...descriptor,
    schema: buildOpenAiFunctionSchema(descriptor),
    policy: {
      risk: 'medium',
      capability: 'network'
    }
  }));

  cachedDynamicRegistry = {
    generatedAt: Date.now(),
    tools: registryTools,
    byName: new Map(registryTools.map((item) => [item.functionName, item]))
  };
  return cachedDynamicRegistry;
}

async function warmMcpRegistry(options = {}) {
  try {
    return await getDynamicMcpToolRegistry({
      ...options,
      forceRefresh: true
    });
  } catch (error) {
    logMcp('mcp_tool_error', {
      stage: 'warmup',
      error: error?.message || String(error || '')
    });
    return {
      generatedAt: 0,
      tools: [],
      byName: new Map()
    };
  }
}

function getCachedDynamicMcpToolRegistry() {
  return cachedDynamicRegistry;
}

function clearMcpRuntimeCaches() {
  cachedDynamicRegistry = {
    generatedAt: 0,
    tools: [],
    byName: new Map()
  };
  initializePromisePool.clear();
  discoveryFailureCooldowns.clear();
  for (const entry of sessionPool.values()) {
    try {
      entry.process?.kill();
    } catch (_) {}
  }
  sessionPool.clear();
}

module.exports = {
  buildDynamicMcpToolName,
  callMcpTool,
  clearMcpRuntimeCaches,
  discoverMcpTools,
  getCachedDynamicMcpToolRegistry,
  getDynamicMcpToolRegistry,
  listConfiguredMcpServers,
  readMcpConfig,
  sanitizeMcpArgs,
  sanitizeMcpNamePart,
  summarizeJson,
  truncateText,
  warmMcpRegistry
};
