const axios = require('axios');

const DEFAULT_LUCKIN_MCP_ENDPOINT = 'https://gwmcp.lkcoffee.com/order/user/mcp';

const GLOBAL_ALLOWED_TOOLS = new Set([
  'queryShopList',
  'searchProductForMcp',
  'queryProductDetailInfo',
  'switchProduct',
  'previewOrder'
]);

const PERSONAL_ALLOWED_TOOLS = new Set([
  ...GLOBAL_ALLOWED_TOOLS,
  'createOrder',
  'queryOrderDetailInfo',
  'cancelOrder'
]);

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeCredentialScope(value = '') {
  const scope = normalizeText(value).toLowerCase();
  return scope === 'personal' ? 'personal' : 'global';
}

function assertLuckinToolAllowed(credentialScope = 'global', toolName = '') {
  const normalizedTool = normalizeText(toolName);
  if (!normalizedTool) throw new Error('Luckin MCP tool name is required');
  const allowed = normalizeCredentialScope(credentialScope) === 'personal'
    ? PERSONAL_ALLOWED_TOOLS
    : GLOBAL_ALLOWED_TOOLS;
  if (!allowed.has(normalizedTool)) {
    throw new Error(`Luckin MCP tool not allowed for ${normalizeCredentialScope(credentialScope)} token: ${normalizedTool}`);
  }
  return true;
}

function parseSsePayload(payload = '') {
  const events = [];
  let dataLines = [];
  const flush = () => {
    if (!dataLines.length) return;
    const raw = dataLines.join('\n').trim();
    dataLines = [];
    if (!raw || raw === '[DONE]') return;
    try {
      events.push(JSON.parse(raw));
    } catch (_) {}
  };

  for (const line of String(payload || '').split(/\r?\n/)) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
  flush();
  return events;
}

function parseLuckinMcpResponse(payload = null) {
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) throw new Error('empty Luckin MCP response');
    if (/^data:/m.test(trimmed) || /^event:/m.test(trimmed)) {
      const events = parseSsePayload(trimmed);
      const message = events.reverse().find((item) => item && (item.result || item.error));
      if (!message) throw new Error('Luckin MCP SSE response has no JSON-RPC result');
      return message;
    }
    return JSON.parse(trimmed);
  }
  if (payload && typeof payload === 'object') return payload;
  throw new Error('invalid Luckin MCP response');
}

function extractLuckinMcpText(message = {}) {
  if (message.error) {
    throw new Error(normalizeText(message.error.message) || 'Luckin MCP returned an error');
  }
  const result = message.result && typeof message.result === 'object' ? message.result : {};
  if (Array.isArray(result.content)) {
    return result.content
      .map((item) => normalizeText(item?.text))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent);
  }
  return normalizeText(result.text || '');
}

function createLuckinMcpClient(options = {}) {
  const endpoint = normalizeText(options.endpoint) || DEFAULT_LUCKIN_MCP_ENDPOINT;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 12000) || 12000);
  const transport = typeof options.transport === 'function'
    ? options.transport
    : async (request) => {
        const response = await axios.post(request.url, request.body, {
          headers: request.headers,
          timeout: request.timeoutMs,
          responseType: 'text',
          transformResponse: [(data) => data]
        });
        return response.data;
      };
  let nextId = 1;

  async function callTool(input = {}) {
    const token = normalizeText(input.token);
    const toolName = normalizeText(input.toolName);
    const credentialScope = normalizeCredentialScope(input.credentialScope);
    const toolArgs = input.arguments && typeof input.arguments === 'object' ? input.arguments : {};
    if (!token) throw new Error('Luckin MCP token is required');
    assertLuckinToolAllowed(credentialScope, toolName);

    const body = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: toolArgs
      },
      id: nextId++
    };
    const raw = await transport({
      url: endpoint,
      timeoutMs,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream'
      },
      body
    });
    const parsed = parseLuckinMcpResponse(raw);
    return {
      ok: true,
      text: extractLuckinMcpText(parsed),
      result: parsed.result || null
    };
  }

  return {
    callTool
  };
}

module.exports = {
  DEFAULT_LUCKIN_MCP_ENDPOINT,
  GLOBAL_ALLOWED_TOOLS,
  PERSONAL_ALLOWED_TOOLS,
  assertLuckinToolAllowed,
  createLuckinMcpClient,
  extractLuckinMcpText,
  parseLuckinMcpResponse
};
