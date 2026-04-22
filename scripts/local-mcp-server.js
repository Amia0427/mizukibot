const fs = require('fs');
const path = require('path');
const { TOOL_EXECUTORS } = require('../api/toolExecutors');
const { searchRecipes } = require('../utils/howtocookLocalSearch');

const SERVER_NAME = String(process.argv[2] || '').trim();
const PROTOCOL_VERSION = '2024-11-05';

const SERVER_DEFINITIONS = {
  fetch: {
    title: 'local-mcp-fetch',
    version: '1.0.0',
    tools: [
      {
        name: 'fetch_url',
        description: 'Fetch and extract readable webpage content',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' }
          },
          required: ['url']
        }
      }
    ]
  },
  'bing-search': {
    title: 'local-mcp-bing-search',
    version: '1.0.0',
    tools: [
      {
        name: 'search_web',
        description: 'Search the web',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' }
          },
          required: ['query']
        }
      }
    ]
  },
  'amap-maps': {
    title: 'local-mcp-amap-maps',
    version: '1.0.0',
    tools: [
      {
        name: 'search_places',
        description: 'Search nearby places',
        inputSchema: {
          type: 'object',
          properties: {
            keywords: { type: 'string' },
            city: { type: 'string' }
          },
          required: ['keywords']
        }
      }
    ]
  },
  'howtocook-mcp': {
    title: 'local-mcp-howtocook',
    version: '1.0.0',
    tools: [
      {
        name: 'recipe_search',
        description: 'Search local recipe records from the cached howtocook dataset',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'number' }
          },
          required: ['query']
        }
      }
    ]
  }
};

const IS_CLI = require.main === module;

if (IS_CLI && !SERVER_DEFINITIONS[SERVER_NAME]) {
  process.stderr.write(`Unsupported local MCP server: ${SERVER_NAME}\n`);
  process.exit(1);
}

let stdinBuffer = Buffer.alloc(0);

function normalizeText(value = '') {
  return String(value || '').trim();
}

function safeWrite(payloadBuffer) {
  try {
    process.stdout.write(payloadBuffer);
  } catch (error) {
    process.stderr.write(`stdout write failed: ${error.message}\n`);
  }
}

function encodePayload(message = {}, protocolMode = 'line') {
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
    mode: 'line',
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
  const match = headerText.match(/content-length\s*:\s*(\d+)/i);
  if (!match) {
    return {
      error: new Error('missing content-length header'),
      rest: Buffer.alloc(0)
    };
  }

  const contentLength = Number(match[1]);
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    return {
      error: new Error('invalid content-length header'),
      rest: Buffer.alloc(0)
    };
  }

  const bodyStart = headerEnd + separatorLength;
  const bodyEnd = bodyStart + contentLength;
  if (normalized.length < bodyEnd) return null;

  return {
    mode: 'frame',
    raw: normalized.slice(bodyStart, bodyEnd).toString('utf8').trim(),
    rest: normalized.slice(bodyEnd),
    skip: false
  };
}

function buildJsonRpcError(id, code, message) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message
    }
  };
}

function sendResponse(id, result, protocolMode) {
  safeWrite(encodePayload({
    jsonrpc: '2.0',
    id,
    result
  }, protocolMode));
}

function sendError(id, code, message, protocolMode) {
  safeWrite(encodePayload(buildJsonRpcError(id, code, message), protocolMode));
}

async function runTool(toolName, args = {}) {
  if (SERVER_NAME === 'fetch' && toolName === 'fetch_url') {
    return TOOL_EXECUTORS.web_fetch(args);
  }
  if (SERVER_NAME === 'bing-search' && toolName === 'search_web') {
    return TOOL_EXECUTORS.web_search(args);
  }
  if (SERVER_NAME === 'amap-maps' && toolName === 'search_places') {
    return TOOL_EXECUTORS.search_nearby_places(args);
  }
  if (SERVER_NAME === 'howtocook-mcp' && toolName === 'recipe_search') {
    return searchRecipes(args);
  }
  throw new Error(`Unknown tool: ${SERVER_NAME}/${toolName}`);
}

async function handleRequest(message, protocolMode) {
  const id = message?.id ?? null;
  const method = normalizeText(message?.method);

  if (!method) {
    if (id !== null) sendError(id, -32600, 'Invalid Request', protocolMode);
    return;
  }

  if (method === 'notifications/initialized') return;

  if (method === 'initialize') {
    sendResponse(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: SERVER_DEFINITIONS[SERVER_NAME].title,
        version: SERVER_DEFINITIONS[SERVER_NAME].version
      }
    }, protocolMode);
    return;
  }

  if (method === 'tools/list') {
    sendResponse(id, {
      tools: SERVER_DEFINITIONS[SERVER_NAME].tools
    }, protocolMode);
    return;
  }

  if (method === 'tools/call') {
    const toolName = normalizeText(message?.params?.name);
    const args = message?.params?.arguments && typeof message.params.arguments === 'object'
      ? message.params.arguments
      : {};
    try {
      const resultText = normalizeText(await runTool(toolName, args)) || 'Tool returned no text output.';
      sendResponse(id, {
        content: [
          {
            type: 'text',
            text: resultText
          }
        ],
        isError: false
      }, protocolMode);
    } catch (error) {
      sendResponse(id, {
        content: [
          {
            type: 'text',
            text: normalizeText(error?.message || error) || 'Tool execution failed.'
          }
        ],
        isError: true
      }, protocolMode);
    }
    return;
  }

  if (id !== null) {
    sendError(id, -32601, `Method not found: ${method}`, protocolMode);
  }
}

async function consumeBuffer() {
  let safety = 0;
  while (safety < 1000) {
    safety += 1;
    const trimmed = trimLeadingMessageWhitespace(stdinBuffer);
    if (!trimmed.length) {
      stdinBuffer = trimmed;
      return;
    }

    const leading = trimmed.slice(0, Math.min(32, trimmed.length)).toString('utf8').toLowerCase();
    const parsed = leading.startsWith('content-length:')
      ? tryParseFramedMessage(stdinBuffer)
      : tryParseLineDelimitedMessage(stdinBuffer);
    if (!parsed) return;

    stdinBuffer = parsed.rest;
    if (parsed.error) {
      process.stderr.write(`local mcp parse error: ${parsed.error.message}\n`);
      return;
    }
    if (parsed.skip) continue;

    let message = null;
    try {
      message = JSON.parse(parsed.raw);
    } catch (error) {
      process.stderr.write(`local mcp invalid json: ${error.message}\n`);
      continue;
    }

    await handleRequest(message, parsed.mode || 'line');
  }
}

if (IS_CLI) {
  process.stdin.on('data', async (chunk) => {
    const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ''), 'utf8');
    stdinBuffer = stdinBuffer.length > 0 ? Buffer.concat([stdinBuffer, nextChunk]) : nextChunk;
    try {
      await consumeBuffer();
    } catch (error) {
      process.stderr.write(`local mcp fatal consume error: ${error.message}\n`);
    }
  });

  process.stdin.on('end', () => {
    process.exit(0);
  });

  process.on('uncaughtException', (error) => {
    process.stderr.write(`uncaughtException: ${error.stack || error.message}\n`);
    process.exit(1);
  });

  process.on('unhandledRejection', (error) => {
    process.stderr.write(`unhandledRejection: ${error && (error.stack || error.message) || error}\n`);
    process.exit(1);
  });
}

module.exports = {
  SERVER_DEFINITIONS,
  runTool,
  searchRecipes
};
