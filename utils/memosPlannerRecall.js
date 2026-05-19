const config = require('../config');

const DEFAULT_SEARCH_TOOL_CANDIDATES = Object.freeze([
  'search_memory',
  'search_memories',
  'memory_search'
]);

const DEFAULT_KB_READ_TOOL_CANDIDATES = Object.freeze([
  'get_kb_documents',
  'get_knowledge_base_documents',
  'get_knowledgebase_documents'
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

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeText(item))
      .filter(Boolean);
  }
  return normalizeText(value)
    .split(',')
    .map((item) => normalizeText(item))
    .filter(Boolean);
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

function normalizeRecallSource(value = '') {
  const source = normalizeText(value, 'knowledge_base').toLowerCase().replace(/[-\s]+/g, '_');
  if (['kb', 'knowledgebase', 'knowledge_base', 'remote_kb', 'remote_knowledge_base'].includes(source)) {
    return 'knowledge_base';
  }
  if (['memory', 'memories', 'search', 'search_memory', 'remote_memory'].includes(source)) {
    return 'search_memory';
  }
  if (source === 'auto') return 'auto';
  return 'knowledge_base';
}

function getMemosRecallSource(options = {}) {
  const currentConfig = {
    ...getConfig(),
    ...normalizeObject(options.config, {})
  };
  return normalizeRecallSource(
    options.recallSource
    || currentConfig.MEMOS_RECALL_SOURCE
    || currentConfig.MEMOS_RECALL_MODE
    || 'knowledge_base'
  );
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
      recallSource: '',
      sourceToolName: '',
      kbToolName: '',
      searchToolName: '',
      availableTools: [],
      durationMs: 0,
      error: '',
      readOnly: true
    },
    ...patch,
    diagnostics: {
      enabled: false,
      serverName: '',
      recallSource: '',
      sourceToolName: '',
      kbToolName: '',
      searchToolName: '',
      availableTools: [],
      durationMs: 0,
      error: '',
      readOnly: true,
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

function extractStructuredMcpPayload(rawResult) {
  const resultObject = normalizeObject(rawResult, null);
  if (!resultObject) return rawResult;
  if (resultObject.result && typeof resultObject.result === 'object') {
    const structured = resultObject.result.structuredContent;
    if (structured && typeof structured === 'object') return structured;
    const contentItems = normalizeArray(resultObject.result.content);
    for (const item of contentItems) {
      const parsed = typeof item?.text === 'string' ? parsePossibleJsonText(item.text) : null;
      if (parsed && typeof parsed === 'object') return parsed;
    }
  }
  if (resultObject.structuredContent && typeof resultObject.structuredContent === 'object') {
    return resultObject.structuredContent;
  }
  const parsedText = typeof resultObject.text === 'string' ? parsePossibleJsonText(resultObject.text) : null;
  if (parsedText && typeof parsedText === 'object') return parsedText;
  if (resultObject.result) return resultObject.result;
  return rawResult;
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

  if (Object.prototype.hasOwnProperty.call(value, 'code') && value.data && typeof value.data === 'object') {
    flattenMemoryCandidates(value.data, output);
    return output;
  }

  const directTextCandidates = [
    value.text,
    value.content,
    value.memory,
    value.memory_text,
    value.memoryText,
    value.memory_value,
    value.memoryValue,
    value.preference,
    value.preference_text,
    value.preferenceText,
    value.preference_note,
    value.preferenceNote,
    value.skill,
    value.skill_text,
    value.skillText,
    value.tool_memory,
    value.toolMemory,
    value.message,
    value.summary,
    value.description,
    value.file_text,
    value.fileText,
    value.file_content,
    value.fileContent,
    value.document,
    value.document_text,
    value.documentText,
    value.document_content,
    value.documentContent,
    value.page_content,
    value.pageContent,
    value.chunk,
    value.chunk_text,
    value.chunkText,
    value.kb_content,
    value.kbContent,
    value.markdown
  ].filter((item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean');
  const directText = normalizeText(
    directTextCandidates.find((item) => normalizeText(item))
  );
  if (directText) {
    output.push({
      id: normalizeText(value.id || value.memory_id || value.message_id || value.file_id || value.document_id || value.ref),
      text: directText,
      title: normalizeText(value.title || value.file_name || value.filename || value.name || value.document_name),
      source: normalizeText(value.source || value.type),
      score: Number.isFinite(Number(value.score || value.similarity || value.relevance))
        ? Number(value.score || value.similarity || value.relevance)
        : null,
      createdAt: normalizeText(value.created_at || value.createdAt || value.time || value.timestamp),
      raw: value
    });
  }

  for (const key of [
    'items',
    'results',
    'memories',
    'messages',
    'data',
    'content',
    'memory_detail_list',
    'preference_detail_list',
    'tool_memory_detail_list',
    'skill_detail_list',
    'files',
    'file',
    'file_list',
    'documents',
    'document_list',
    'knowledgebase_files',
    'knowledgebase_file_list',
    'chunks',
    'pages'
  ]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      flattenMemoryCandidates(value[key], output);
    }
  }
  return output;
}

function normalizeRecallItems(rawResult, options = {}) {
  const maxItems = clampNumber(options.topK, 1, 20, 5);
  const maxChars = clampNumber(options.maxChars, 120, 8000, 900);
  const source = extractStructuredMcpPayload(rawResult);
  const seen = new Set();
  return flattenMemoryCandidates(source)
    .map((item) => ({
      id: normalizeText(item.id),
      text: truncateText(item.text, Math.max(120, Math.floor(maxChars / maxItems))),
      title: normalizeText(item.title),
      source: normalizeText(item.source || options.source),
      score: item.score === null || item.score === undefined || item.score === ''
        ? null
        : (Number.isFinite(Number(item.score)) ? Number(item.score) : null),
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
      const source = normalizeText(item.source) ? ` source=${normalizeText(item.source)}` : '';
      const title = normalizeText(item.title) ? `${normalizeText(item.title)}: ` : '';
      return `${index + 1}. ${title}${normalizeText(item.text)}${source}${score}${createdAt}`;
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
  const knowledgebaseIds = normalizeStringList(
    options.knowledgebaseIds
    || options.kbIds
    || currentConfig.MEMOS_KB_IDS
  );
  const args = {
    query: normalizeText(query),
    conversation_first_message: normalizeText(
      options.conversationFirstMessage
      || options.routeMeta?.conversationFirstMessage
      || options.routeMeta?.conversation_first_message
      || query
    ),
    include_preference: true,
    preference_limit_number: topK,
    memory_limit_number: topK,
    relativity: 0
  };
  if (knowledgebaseIds.length > 0) args.knowledgebase_ids = knowledgebaseIds;
  return args;
}

function buildKnowledgeBaseArgs(options = {}) {
  const currentConfig = {
    ...getConfig(),
    ...normalizeObject(options.config, {})
  };
  const topK = clampNumber(options.topK ?? currentConfig.MEMOS_RECALL_TOP_K, 1, 20, 5);
  const fileIds = normalizeStringList(
    options.fileIds
    || options.kbFileIds
    || currentConfig.MEMOS_KB_FILE_IDS
  );
  return {
    file_ids: fileIds.slice(0, topK)
  };
}

function getConfiguredKnowledgebaseIds(options = {}) {
  const currentConfig = {
    ...getConfig(),
    ...normalizeObject(options.config, {})
  };
  return normalizeStringList(
    options.knowledgebaseIds
    || options.kbIds
    || currentConfig.MEMOS_KB_IDS
  );
}

async function discoverMemosTools(options = {}) {
  const serverName = getMemosServerName(options);
  const diagnostics = {
    serverName,
    availableTools: [],
    kbToolName: '',
    searchToolName: '',
    addToolName: '',
    mutatingToolNames: [],
    error: ''
  };
  try {
    const runtime = getMcpRuntime();
    const discover = typeof runtime.discoverMcpServerTools === 'function'
      ? () => runtime.discoverMcpServerTools(serverName, {
        ...(options.mcpContext && typeof options.mcpContext === 'object' ? options.mcpContext : {}),
        timeoutMs: options.timeoutMs
      })
      : () => runtime.discoverMcpTools({
        ...(options.mcpContext && typeof options.mcpContext === 'object' ? options.mcpContext : {}),
        timeoutMs: options.timeoutMs
      });
    const tools = await discover();
    const serverTools = normalizeArray(tools).filter((item) => normalizeText(item.serverName) === serverName);
    diagnostics.availableTools = serverTools.map((item) => normalizeText(item.toolName)).filter(Boolean);
    diagnostics.kbToolName = DEFAULT_KB_READ_TOOL_CANDIDATES.find((tool) => diagnostics.availableTools.includes(tool))
      || diagnostics.availableTools.find((tool) => /get.*(?:kb|knowledge_?base).*documents?|documents?.*(?:kb|knowledge_?base)/i.test(tool))
      || '';
    diagnostics.searchToolName = DEFAULT_SEARCH_TOOL_CANDIDATES.find((tool) => diagnostics.availableTools.includes(tool))
      || diagnostics.availableTools.find((tool) => /search.*memory|memory.*search/i.test(tool))
      || '';
    diagnostics.addToolName = DEFAULT_ADD_TOOL_CANDIDATES.find((tool) => diagnostics.availableTools.includes(tool))
      || diagnostics.availableTools.find((tool) => /add.*(?:message|memory)|create.*memory/i.test(tool))
      || '';
    diagnostics.mutatingToolNames = diagnostics.availableTools
      .filter((tool) => /^(add_|create_|delete_|remove_)|delete|remove|create|add/i.test(tool));
  } catch (error) {
    diagnostics.error = normalizeText(error?.message || error);
  }
  return diagnostics;
}

async function callKnowledgeBaseRecall(normalizedQuery = '', options = {}) {
  const {
    currentConfig,
    discovery,
    maxChars,
    serverName,
    startedAt,
    timeoutMs,
    topK
  } = options;
  const kbToolName = discovery.kbToolName || 'get_kb_documents';
  const kbArgs = buildKnowledgeBaseArgs({ ...options, config: currentConfig, topK });
  if (!discovery.kbToolName) {
    return buildEmptyRecall(normalizedQuery, {
      rejectedReason: 'kb_tool_unavailable',
      diagnostics: {
        enabled: true,
        serverName,
        recallSource: 'knowledge_base',
        sourceToolName: '',
        kbToolName: '',
        searchToolName: discovery.searchToolName,
        availableTools: discovery.availableTools,
        durationMs: Math.max(0, Date.now() - startedAt),
        error: normalizeText(discovery.error),
        readOnly: true
      }
    });
  }
  if (kbArgs.file_ids.length === 0) {
    return buildEmptyRecall(normalizedQuery, {
      rejectedReason: 'kb_file_ids_missing',
      diagnostics: {
        enabled: true,
        serverName,
        recallSource: 'knowledge_base',
        sourceToolName: kbToolName,
        kbToolName,
        searchToolName: discovery.searchToolName,
        availableTools: discovery.availableTools,
        durationMs: Math.max(0, Date.now() - startedAt),
        error: normalizeText(discovery.error),
        readOnly: true
      }
    });
  }
  const result = await getMcpRuntime().callMcpTool(
    serverName,
    kbToolName,
    kbArgs,
    {
      ...(options.mcpContext && typeof options.mcpContext === 'object' ? options.mcpContext : {}),
      timeoutMs
    }
  );
  const items = normalizeRecallItems(result, { topK, maxChars, source: 'memos_kb' });
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
      recallSource: 'knowledge_base',
      sourceToolName: kbToolName,
      kbToolName,
      searchToolName: discovery.searchToolName,
      kbFileIdsCount: kbArgs.file_ids.length,
      availableTools: discovery.availableTools,
      durationMs: Math.max(0, Date.now() - startedAt),
      fallback: result?.fallback === true,
      error: normalizeText(discovery.error),
      readOnly: true
    }
  };
}

async function callSearchMemoryRecall(normalizedQuery = '', options = {}) {
  const {
    currentConfig,
    discovery,
    maxChars,
    serverName,
    startedAt,
    timeoutMs,
    topK
  } = options;
  const searchToolName = discovery.searchToolName || 'search_memory';
  const result = await getMcpRuntime().callMcpTool(
    serverName,
    searchToolName,
    buildSearchArgs(normalizedQuery, { ...options, config: currentConfig, topK }),
    {
      ...(options.mcpContext && typeof options.mcpContext === 'object' ? options.mcpContext : {}),
      timeoutMs
    }
  );
  const items = normalizeRecallItems(result, { topK, maxChars, source: 'memos_memory' });
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
      recallSource: 'search_memory',
      sourceToolName: searchToolName,
      kbToolName: discovery.kbToolName,
      searchToolName,
      knowledgebaseIdsCount: getConfiguredKnowledgebaseIds({ ...options, config: currentConfig }).length,
      availableTools: discovery.availableTools,
      durationMs: Math.max(0, Date.now() - startedAt),
      fallback: result?.fallback === true,
      error: normalizeText(discovery.error),
      readOnly: true
    }
  };
}

async function recallForPlanner(query = '', options = {}) {
  const startedAt = Date.now();
  const normalizedQuery = normalizeText(query);
  const currentConfig = {
    ...getConfig(),
    ...normalizeObject(options.config, {})
  };
  const serverName = getMemosServerName({ ...options, config: currentConfig });
  const recallSource = getMemosRecallSource({ ...options, config: currentConfig });
  const maxChars = clampNumber(options.maxChars ?? currentConfig.MEMOS_RECALL_MAX_CHARS, 120, 8000, 900);
  const topK = clampNumber(options.topK ?? currentConfig.MEMOS_RECALL_TOP_K, 1, 20, 5);
  const timeoutMs = clampNumber(options.timeoutMs ?? currentConfig.MEMOS_RECALL_TIMEOUT_MS, 100, 30000, 1200);

  if (!currentConfig.MEMOS_MCP_ENABLED) {
    return buildEmptyRecall(normalizedQuery, {
      rejectedReason: 'disabled',
      diagnostics: {
        enabled: false,
        serverName,
        recallSource,
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
        recallSource,
        durationMs: Math.max(0, Date.now() - startedAt)
      }
    });
  }

  const discovery = await discoverMemosTools({ ...options, config: currentConfig, timeoutMs });
  try {
    const recallOptions = {
      ...options,
      currentConfig,
      discovery,
      maxChars,
      serverName,
      startedAt,
      timeoutMs,
      topK
    };
    if (recallSource === 'search_memory') {
      return await callSearchMemoryRecall(normalizedQuery, recallOptions);
    }
    if (recallSource === 'auto') {
      const kbArgs = buildKnowledgeBaseArgs({ ...options, config: currentConfig, topK });
      if (getConfiguredKnowledgebaseIds({ ...options, config: currentConfig }).length > 0) {
        return await callSearchMemoryRecall(normalizedQuery, recallOptions);
      }
      if (discovery.kbToolName && kbArgs.file_ids.length > 0) {
        const kbRecall = await callKnowledgeBaseRecall(normalizedQuery, recallOptions);
        if (kbRecall.used || currentConfig.MEMOS_KB_FALLBACK_SEARCH_ENABLED !== true) return kbRecall;
      }
      return await callSearchMemoryRecall(normalizedQuery, recallOptions);
    }
    if (getConfiguredKnowledgebaseIds({ ...options, config: currentConfig }).length > 0) {
      const kbSearchRecall = await callSearchMemoryRecall(normalizedQuery, recallOptions);
      return {
        ...kbSearchRecall,
        diagnostics: {
          ...kbSearchRecall.diagnostics,
          recallSource: 'knowledge_base_search',
          sourceToolName: kbSearchRecall.diagnostics.searchToolName,
          kbMode: 'knowledgebase_ids'
        }
      };
    }
    const kbRecall = await callKnowledgeBaseRecall(normalizedQuery, recallOptions);
    if (
      kbRecall.used
      || currentConfig.MEMOS_KB_FALLBACK_SEARCH_ENABLED !== true
      || !discovery.searchToolName
    ) {
      return kbRecall;
    }
    const searchRecall = await callSearchMemoryRecall(normalizedQuery, recallOptions);
    return {
      ...searchRecall,
      diagnostics: {
        ...searchRecall.diagnostics,
        recallSource: 'knowledge_base_fallback_search',
        fallbackReason: kbRecall.rejectedReason || 'kb_empty'
      }
    };
  } catch (error) {
    return buildEmptyRecall(normalizedQuery, {
      rejectedReason: 'mcp_error',
      diagnostics: {
        enabled: true,
        serverName,
        recallSource,
        sourceToolName: recallSource === 'search_memory' ? (discovery.searchToolName || 'search_memory') : (discovery.kbToolName || 'get_kb_documents'),
        kbToolName: discovery.kbToolName,
        searchToolName: discovery.searchToolName,
        availableTools: discovery.availableTools,
        durationMs: Math.max(0, Date.now() - startedAt),
        error: normalizeText(error?.message || error || discovery.error),
        readOnly: true
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
  const serverName = getMemosServerName({ ...options, config: currentConfig });
  return {
    ok: false,
    skipped: true,
    reason: 'remote_write_disabled',
    diagnostics: {
      enabled: currentConfig.MEMOS_MCP_ENABLED === true,
      serverName,
      readOnly: true
    }
  };
}

module.exports = {
  addMessageToMemos,
  buildKnowledgeBaseArgs,
  buildSearchArgs,
  discoverMemosTools,
  formatMemosRecallPrompt,
  getMemosRecallPromptText,
  getMemosRecallSource,
  getMemosServerName,
  getConfiguredKnowledgebaseIds,
  isMemosPlannerRecallEnabled,
  normalizeRecallItems,
  recallForPlanner,
  truncateText
};
