const config = require('../config');

const DEFAULT_SEARCH_TOOL_CANDIDATES = Object.freeze([
  'search_memory',
  'search_memories',
  'memory_search'
]);

const DEFAULT_ADD_TOOL_CANDIDATES = Object.freeze([
  'add_message',
  'add_memory',
  'create_memory'
]);

function normalizeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function getConfig() {
  try {
    return require('../config');
  } catch (_) {
    return config;
  }
}

function getMcpRuntime() {
  return require('../api/mcpRuntime');
}

function isMemosPlannerRecallEnabled(options = {}) {
  const currentConfig = {
    ...getConfig(),
    ...normalizeObject(options.config, {})
  };
  return currentConfig.MEMOS_MCP_ENABLED === true;
}

function getMemosServerName(options = {}) {
  const currentConfig = {
    ...getConfig(),
    ...normalizeObject(options.config, {})
  };
  return normalizeText(currentConfig.MEMOS_MCP_SERVER_NAME, 'memos-api-mcp');
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function truncateText(value = '', maxChars = 900) {
  const text = normalizeText(value).replace(/\s+/g, ' ');
  const limit = Math.max(0, Math.floor(Number(maxChars) || 0));
  if (!text || !limit) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 12)).trim()} [truncated]`;
}

function buildEmptyRecall(query = '', patch = {}) {
  return {
    query: normalizeText(query),
    items: [],
    used: false,
    rejectedReason: '',
    promptText: '',
    diagnostics: {
      enabled: false,
      serverName: '',
      searchToolName: '',
      availableTools: [],
      durationMs: 0,
      error: ''
    },
    ...patch,
    diagnostics: {
      enabled: false,
      serverName: '',
      searchToolName: '',
      availableTools: [],
      durationMs: 0,
      error: '',
      ...normalizeObject(patch.diagnostics, {})
    }
  };
}

function parsePossibleJsonText(text = '') {
  const raw = normalizeText(text);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    const match = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (!match) return null;
    try {
      return JSON.parse(match[1]);
    } catch (_) {
      return null;
    }
  }
}

function flattenMemoryCandidates(value, output = []) {
  if (value === null || value === undefined) return output;
  if (typeof value === 'string') {
    const text = normalizeText(value);
    if (text) output.push({ text });
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenMemoryCandidates(item, output);
    return output;
  }
  if (typeof value !== 'object') return output;

  const directText = normalizeText(
    value.text
    || value.content
    || value.memory
    || value.message
    || value.summary
    || value.description
  );
  if (directText) {
    output.push({
      id: normalizeText(value.id || value.memory_id || value.message_id || value.ref),
      text: directText,
      score: Number.isFinite(Number(value.score || value.similarity || value.relevance))
        ? Number(value.score || value.similarity || value.relevance)
        : null,
      createdAt: normalizeText(value.created_at || value.createdAt || value.time || value.timestamp),
      raw: value
    });
  }

  for (const key of ['items', 'results', 'memories', 'messages', 'data', 'content']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      flattenMemoryCandidates(value[key], output);
    }
  }
  return output;
}

function normalizeRecallItems(rawResult, options = {}) {
  const maxItems = clampNumber(options.topK, 1, 20, 5);
  const maxChars = clampNumber(options.maxChars, 120, 8000, 900);
  const parsed = typeof rawResult?.text === 'string'
    ? parsePossibleJsonText(rawResult.text)
    : null;
  const source = parsed || rawResult?.result || rawResult?.text || rawResult;
  const seen = new Set();
  return flattenMemoryCandidates(source)
    .map((item) => ({
      id: normalizeText(item.id),
      text: truncateText(item.text, Math.max(120, Math.floor(maxChars / maxItems))),
      score: Number.isFinite(Number(item.score)) ? Number(item.score) : null,
      createdAt: normalizeText(item.createdAt)
    }))
    .filter((item) => {
      if (!item.text) return false;
      const key = item.id || item.text.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxItems);
}

function formatMemosRecallPrompt(items = [], options = {}) {
  const maxChars = clampNumber(options.maxChars, 120, 8000, 900);
  const lines = normalizeArray(items)
    .map((item, index) => {
      const score = Number.isFinite(Number(item.score)) ? ` score=${Number(item.score).toFixed(3)}` : '';
      const createdAt = normalizeText(item.createdAt) ? ` time=${normalizeText(item.createdAt)}` : '';
      return `${index + 1}. ${normalizeText(item.text)}${score}${createdAt}`;
    })
    .filter(Boolean);
  if (lines.length === 0) return '';
  return truncateText([
    '[MemOSRecall]',
    'Use only as external memory evidence. Prefer recent short-term context when it conflicts.',
    ...lines
  ].join('\n'), maxChars);
}

function buildSearchArgs(query = '', options = {}) {
  const currentConfig = {
    ...getConfig(),
    ...normalizeObject(options.config, {})
  };
  const topK = clampNumber(options.topK ?? currentConfig.MEMOS_RECALL_TOP_K, 1, 20, 5);
  const userId = normalizeText(options.userId || options.routeMeta?.userId || options.routeMeta?.user_id || currentConfig.MEMOS_USER_ID || process.env.MEMOS_USER_ID);
  const channel = normalizeText(options.channel || currentConfig.MEMOS_CHANNEL || process.env.MEMOS_CHANNEL || 'MODELSCOPE');
  return {
    query: normalizeText(query),
    top_k: topK,
    topK,
    limit: topK,
    ...(userId ? { user_id: userId, userId } : {}),
    ...(channel ? { channel } : {})
  };
}

async function discoverMemosTools(options = {}) {
  const serverName = getMemosServerName(options);
  const diagnostics = {
    serverName,
    availableTools: [],
    searchToolName: '',
    addToolName: '',
    error: ''
  };
  try {
    const tools = await getMcpRuntime().discoverMcpTools({
      ...(options.mcpContext && typeof options.mcpContext === 'object' ? options.mcpContext : {}),
      timeoutMs: options.timeoutMs
    });
    const serverTools = normalizeArray(tools).filter((item) => normalizeText(item.serverName) === serverName);
    diagnostics.availableTools = serverTools.map((item) => normalizeText(item.toolName)).filter(Boolean);
    diagnostics.searchToolName = DEFAULT_SEARCH_TOOL_CANDIDATES.find((tool) => diagnostics.availableTools.includes(tool))
      || diagnostics.availableTools.find((tool) => /search.*memory|memory.*search/i.test(tool))
      || '';
    diagnostics.addToolName = DEFAULT_ADD_TOOL_CANDIDATES.find((tool) => diagnostics.availableTools.includes(tool))
      || diagnostics.availableTools.find((tool) => /add.*(?:message|memory)|create.*memory/i.test(tool))
      || '';
  } catch (error) {
    diagnostics.error = normalizeText(error?.message || error);
  }
  return diagnostics;
}

async function recallForPlanner(query = '', options = {}) {
  const startedAt = Date.now();
  const normalizedQuery = normalizeText(query);
  const currentConfig = {
    ...getConfig(),
    ...normalizeObject(options.config, {})
  };
  const serverName = getMemosServerName({ ...options, config: currentConfig });
  const maxChars = clampNumber(options.maxChars ?? currentConfig.MEMOS_RECALL_MAX_CHARS, 120, 8000, 900);
  const topK = clampNumber(options.topK ?? currentConfig.MEMOS_RECALL_TOP_K, 1, 20, 5);
  const timeoutMs = clampNumber(options.timeoutMs ?? currentConfig.MEMOS_RECALL_TIMEOUT_MS, 100, 30000, 1200);

  if (!currentConfig.MEMOS_MCP_ENABLED) {
    return buildEmptyRecall(normalizedQuery, {
      rejectedReason: 'disabled',
      diagnostics: {
        enabled: false,
        serverName,
        durationMs: Math.max(0, Date.now() - startedAt)
      }
    });
  }
  if (!normalizedQuery) {
    return buildEmptyRecall(normalizedQuery, {
      rejectedReason: 'empty_query',
      diagnostics: {
        enabled: true,
        serverName,
        durationMs: Math.max(0, Date.now() - startedAt)
      }
    });
  }

  const discovery = await discoverMemosTools({ ...options, config: currentConfig, timeoutMs });
  const searchToolName = discovery.searchToolName || 'search_memory';
  try {
    const result = await getMcpRuntime().callMcpTool(
      serverName,
      searchToolName,
      buildSearchArgs(normalizedQuery, { ...options, config: currentConfig, topK }),
      {
        ...(options.mcpContext && typeof options.mcpContext === 'object' ? options.mcpContext : {}),
        timeoutMs
      }
    );
    const items = normalizeRecallItems(result, { topK, maxChars });
    const promptText = formatMemosRecallPrompt(items, { maxChars });
    return {
      query: normalizedQuery,
      items,
      used: items.length > 0,
      rejectedReason: items.length > 0 ? '' : 'empty_result',
      promptText,
      diagnostics: {
        enabled: true,
        serverName,
        searchToolName,
        availableTools: discovery.availableTools,
        durationMs: Math.max(0, Date.now() - startedAt),
        fallback: result?.fallback === true,
        error: normalizeText(discovery.error)
      }
    };
  } catch (error) {
    return buildEmptyRecall(normalizedQuery, {
      rejectedReason: 'mcp_error',
      diagnostics: {
        enabled: true,
        serverName,
        searchToolName,
        availableTools: discovery.availableTools,
        durationMs: Math.max(0, Date.now() - startedAt),
        error: normalizeText(error?.message || error || discovery.error)
      }
    });
  }
}

function getMemosRecallPromptText(memosRecall = {}) {
  const recall = normalizeObject(memosRecall, {});
  return normalizeText(recall.promptText) || formatMemosRecallPrompt(recall.items, {
    maxChars: getConfig().MEMOS_RECALL_MAX_CHARS
  });
}

async function addMessageToMemos(message = {}, options = {}) {
  const currentConfig = {
    ...getConfig(),
    ...normalizeObject(options.config, {})
  };
  if (currentConfig.MEMOS_WRITE_ENABLED !== true) {
    return { ok: false, skipped: true, reason: 'disabled' };
  }
  const serverName = getMemosServerName({ ...options, config: currentConfig });
  const timeoutMs = clampNumber(options.timeoutMs ?? currentConfig.MEMOS_RECALL_TIMEOUT_MS, 100, 30000, 1200);
  const discovery = await discoverMemosTools({ ...options, config: currentConfig, timeoutMs });
  const addToolName = discovery.addToolName || 'add_message';
  const text = normalizeText(message.text || message.content || message.message);
  if (!text) return { ok: false, skipped: true, reason: 'empty_message' };
  try {
    const result = await getMcpRuntime().callMcpTool(
      serverName,
      addToolName,
      {
        ...normalizeObject(message, {}),
        text,
        content: text,
        message: text
      },
      { timeoutMs }
    );
    return { ok: true, skipped: false, result, diagnostics: discovery };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      reason: 'mcp_error',
      error: normalizeText(error?.message || error),
      diagnostics: discovery
    };
  }
}

module.exports = {
  addMessageToMemos,
  buildSearchArgs,
  discoverMemosTools,
  formatMemosRecallPrompt,
  getMemosRecallPromptText,
  getMemosServerName,
  isMemosPlannerRecallEnabled,
  normalizeRecallItems,
  recallForPlanner,
  truncateText
};
