const axios = require('axios');
const config = require('../config');
const { readUtf8StreamToString } = require('../utils/utf8Stream');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function buildBaseUrl() {
  return normalizeText(config.HAPI_BASE_URL).replace(/\/+$/, '');
}

function buildHeaders() {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream, */*'
  };
  const token = normalizeText(config.HAPI_AUTH_TOKEN);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function createHttpClient(timeoutMs = 180000) {
  return axios.create({
    baseURL: buildBaseUrl(),
    headers: buildHeaders(),
    timeout: Math.max(10000, Number(timeoutMs) || Number(config.HAPI_SYSTEM_TIMEOUT_MS) || 180000),
    proxy: false
  });
}

function isSystemProxyEnabled() {
  return normalizeText(config.SYSTEM_PROXY_BACKEND).toLowerCase() === 'hapi' && Boolean(buildBaseUrl());
}

function getSystemSessionPrefix() {
  return normalizeText(config.HAPI_SYSTEM_SESSION_PREFIX || 'mizuki-system') || 'mizuki-system';
}

function buildSystemSessionId(kind = '', key = '') {
  const prefix = getSystemSessionPrefix();
  const safeKind = normalizeText(kind).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  const safeKey = normalizeText(key).toLowerCase().replace(/[^a-z0-9._:-]+/g, '-');
  return [prefix, safeKind || 'task', safeKey || `job-${Date.now()}`].filter(Boolean).join(':');
}

function resolveSystemMachineId(kind = 'skills') {
  if (normalizeText(kind).toLowerCase() === 'mcp') {
    return normalizeText(config.HAPI_MCP_MACHINE || 'mcp-local') || 'mcp-local';
  }
  return normalizeText(config.HAPI_SKILLS_MACHINE || 'skills-local') || 'skills-local';
}

function normalizeProxyError(error) {
  const status = Number(error?.response?.status || 0);
  const data = error?.response?.data;
  const detail = typeof data === 'string'
    ? data
    : (data && typeof data === 'object' ? JSON.stringify(data) : '');
  if (status === 401 || status === 403) return new Error(`system proxy unauthorized (${status})`);
  if (status === 404) return new Error('system proxy endpoint or machine not found (404)');
  if (status >= 500) return new Error(`system proxy server error (${status})${detail ? `: ${detail}` : ''}`);
  return error instanceof Error ? error : new Error(String(error || 'system proxy request failed'));
}

async function ensureSystemSession(client, machineId, sessionId, cwd = '', metadata = {}) {
  try {
    await client.post(`/api/machines/${encodeURIComponent(machineId)}/spawn`, {
      sessionId,
      machineId,
      cwd: normalizeText(cwd || config.HAPI_WORKSPACE_ROOT),
      metadata
    });
  } catch (error) {
    const status = Number(error?.response?.status || 0);
    if (status !== 409 && status !== 422) throw error;
  }
}

async function readStreamToString(stream) {
  return readUtf8StreamToString(stream);
}

function parseSseEvents(raw = '') {
  const text = String(raw || '');
  const chunks = text.split(/\r?\n\r?\n/).map((item) => item.trim()).filter(Boolean);
  const events = [];
  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/);
    let type = 'message';
    const dataLines = [];
    for (const line of lines) {
      if (/^event:/i.test(line)) {
        type = line.replace(/^event:/i, '').trim() || 'message';
        continue;
      }
      if (/^data:/i.test(line)) {
        dataLines.push(line.replace(/^data:/i, '').trim());
      }
    }
    const payloadText = dataLines.join('\n').trim();
    let payload = payloadText;
    if (payloadText) {
      try {
        payload = JSON.parse(payloadText);
      } catch (_) {}
    }
    events.push({ type, payload });
  }
  return events;
}

function chooseFinalText(events = []) {
  const texts = [];
  for (const event of events) {
    const payload = event?.payload;
    if (typeof payload === 'string' && normalizeText(payload)) {
      texts.push(normalizeText(payload));
      continue;
    }
    if (payload && typeof payload === 'object') {
      const candidates = [payload.text, payload.message, payload.output, payload.summary, payload.resultText];
      for (const item of candidates) {
        const text = normalizeText(item);
        if (text) {
          texts.push(text);
          break;
        }
      }
    }
  }
  return texts.join('\n').trim();
}

async function runManagedCommand(spec = {}) {
  if (!isSystemProxyEnabled()) {
    throw new Error('system proxy disabled');
  }
  const client = createHttpClient(spec.timeoutMs);
  const machineId = resolveSystemMachineId('skills');
  const sessionId = buildSystemSessionId('skills', spec.sessionKey || spec.command || 'command');
  const cwd = normalizeText(spec.cwd || config.HAPI_WORKSPACE_ROOT);
  const metadata = {
    kind: 'managed_command',
    executorKind: normalizeText(spec.executorKind || ''),
    resultMode: normalizeText(spec.resultMode || '')
  };

  try {
    await ensureSystemSession(client, machineId, sessionId, cwd, metadata);
    const response = await client.post(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      machineId,
      stream: false,
      approvalMode: 'manual',
      metadata,
      message: JSON.stringify({
        task: 'run_managed_command',
        spec: {
          executorKind: normalizeText(spec.executorKind || ''),
          command: normalizeText(spec.command || ''),
          args: Array.isArray(spec.args) ? spec.args.map((item) => String(item)) : [],
          cwd,
          envPatch: spec.envPatch && typeof spec.envPatch === 'object' ? { ...spec.envPatch } : {},
          timeoutMs: Math.max(1000, Number(spec.timeoutMs) || Number(config.HAPI_SYSTEM_TIMEOUT_MS) || 180000),
          resultMode: normalizeText(spec.resultMode || 'text')
        }
      })
    }, {
      responseType: config.HAPI_STREAM !== false ? 'stream' : 'json'
    });

    let events = [];
    if (config.HAPI_STREAM !== false && response?.data && typeof response.data.on === 'function') {
      const raw = await readStreamToString(response.data);
      events = parseSseEvents(raw);
    } else {
      const payload = response?.data;
      events = Array.isArray(payload?.events)
        ? payload.events.map((item) => ({ type: item?.type || 'message', payload: item }))
        : [{ type: 'done', payload }];
    }

    const finalText = chooseFinalText(events);
    return {
      ok: true,
      stdout: finalText,
      stderr: '',
      exitCode: 0,
      resultText: finalText,
      errorType: '',
      diagnostics: { machineId, sessionId }
    };
  } catch (error) {
    throw normalizeProxyError(error);
  }
}

async function discoverManagedMcpTools(options = {}) {
  if (!isSystemProxyEnabled()) {
    throw new Error('system proxy disabled');
  }
  const client = createHttpClient(options.timeoutMs);
  const machineId = resolveSystemMachineId('mcp');
  const sessionId = buildSystemSessionId('mcp', 'discover');
  const cwd = normalizeText(config.HAPI_WORKSPACE_ROOT);
  const metadata = { kind: 'mcp_discover' };

  try {
    await ensureSystemSession(client, machineId, sessionId, cwd, metadata);
    const response = await client.post(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      machineId,
      stream: false,
      approvalMode: 'manual',
      metadata,
      message: JSON.stringify({
        task: 'discover_mcp_tools',
        configPath: normalizeText(options.configPath || '')
      })
    });
    const payload = response?.data;
    if (Array.isArray(payload?.tools)) return payload.tools;
    if (Array.isArray(payload?.result?.tools)) return payload.result.tools;
    return [];
  } catch (error) {
    throw normalizeProxyError(error);
  }
}

async function callManagedMcpTool(serverName = '', toolName = '', args = {}, options = {}) {
  if (!isSystemProxyEnabled()) {
    throw new Error('system proxy disabled');
  }
  const client = createHttpClient(options.timeoutMs);
  const machineId = resolveSystemMachineId('mcp');
  const sessionId = buildSystemSessionId('mcp', `${serverName}:${toolName}`);
  const cwd = normalizeText(config.HAPI_WORKSPACE_ROOT);
  const metadata = { kind: 'mcp_call', serverName, toolName };

  try {
    await ensureSystemSession(client, machineId, sessionId, cwd, metadata);
    const response = await client.post(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      machineId,
      stream: false,
      approvalMode: 'manual',
      metadata,
      message: JSON.stringify({
        task: 'call_mcp_tool',
        serverName,
        toolName,
        args,
        configPath: normalizeText(options.configPath || '')
      })
    });
    const payload = response?.data;
    const result = payload?.result || payload || {};
    return {
      ok: Boolean(result?.ok !== false),
      safeArgs: result?.safeArgs || args,
      result: result?.result || result
    };
  } catch (error) {
    throw normalizeProxyError(error);
  }
}

module.exports = {
  buildSystemSessionId,
  callManagedMcpTool,
  createHttpClient,
  discoverManagedMcpTools,
  isSystemProxyEnabled,
  resolveSystemMachineId,
  runManagedCommand
};
