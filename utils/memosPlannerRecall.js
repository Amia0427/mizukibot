const crypto = require('crypto');
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

const memosRecallRuntimeState = {
  cache: new Map(),
  circuit: new Map(),
  stats: {
    cacheHits: 0,
    cacheMisses: 0,
    cacheStores: 0,
    circuitShortCircuits: 0,
    circuitFailures: 0,
    circuitSuccesses: 0
  }
};

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

function uniqueStringList(values = []) {
  return Array.from(new Set(
    normalizeArray(values)
      .map((item) => normalizeText(item))
      .filter(Boolean)
  ));
}

function stableHash(value = '') {
  const text = normalizeText(value);
  if (!text) return '';
  return crypto
    .createHash('sha1')
    .update(text)
    .digest('hex')
    .slice(0, 16);
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
  return currentConfig.MEMOS_MCP_ENABLED === true
    && currentConfig.MEMOS_REMOTE_RECALL_ENABLED === true;
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

function normalizeConfigList(value) {
  return normalizeStringList(value)
    .map((item) => item.toLowerCase())
    .filter(Boolean);
}

function getRouteSignalValues(options = {}) {
  const routeMeta = normalizeObject(options.routeMeta || options.route?.meta, {});
  const intent = normalizeObject(options.intent || options.route?.intent || routeMeta.intent, {});
  const facets = normalizeObject(options.facets || options.route?.facets || routeMeta.facets, {});
  const directedContext = normalizeObject(options.directedContext || routeMeta.directedContext, {});
  return [
    options.topRouteType,
    options.route?.topRouteType,
    routeMeta.topRouteType,
    routeMeta.routePolicyKey,
    routeMeta.policyKey,
    routeMeta.routeDebugKey,
    routeMeta.chatMode,
    routeMeta.toolIntent,
    routeMeta.responseIntent,
    intent.type,
    intent.name,
    intent.intent,
    intent.category,
    facets.topic,
    facets.domain,
    facets.memoryDomain,
    directedContext.topic,
    directedContext.domain
  ]
    .map((item) => normalizeText(item).toLowerCase())
    .filter(Boolean);
}

function parseAliasMap(value) {
  const entries = Array.isArray(value) ? value : normalizeText(value).split(/[;\n]+/);
  const output = {};
  for (const entry of entries) {
    const raw = normalizeText(entry);
    if (!raw) continue;
    const match = raw.match(/^([^:=]+)[:=](.+)$/);
    if (!match) continue;
    const alias = normalizeText(match[1]).toLowerCase();
    const ids = normalizeText(match[2])
      .split(/[|,\s]+/)
      .map((item) => normalizeText(item))
      .filter(Boolean);
    if (alias && ids.length > 0) output[alias] = uniqueStringList([...(output[alias] || []), ...ids]);
  }
  return output;
}

function getMemosKbAliasMap(options = {}) {
  const currentConfig = {
    ...getConfig(),
    ...normalizeObject(options.config, {})
  };
  return parseAliasMap(
    options.kbAliasMap
    || options.knowledgebaseAliasMap
    || currentConfig.MEMOS_KB_ALIAS_MAP
    || currentConfig.MEMOS_RECALL_KB_ALIAS_MAP
    || process.env.MEMOS_KB_ALIAS_MAP
    || process.env.MEMOS_RECALL_KB_ALIAS_MAP
  );
}

function getMemosKbAliasBoostMap(options = {}) {
  const rawMap = getMemosKbAliasMap(options);
  const boostMap = {};
  for (const [alias, ids] of Object.entries(rawMap)) {
    for (const id of ids) boostMap[id] = Math.max(boostMap[id] || 0, 0.25);
  }
  return boostMap;
}

function resolveKnowledgebaseIds(options = {}) {
  const currentConfig = {
    ...getConfig(),
    ...normalizeObject(options.config, {})
  };
  const fallbackIds = normalizeStringList(
    options.knowledgebaseIds
    || options.kbIds
    || currentConfig.MEMOS_KB_IDS
  );
  const aliasMap = getMemosKbAliasMap({ ...options, config: currentConfig });
  const routeSignals = getRouteSignalValues(options);
  const queryClass = classifyRecallQuery(options.query || options.normalizedQuery || '');
  const haystack = [
    ...routeSignals,
    normalizeText(options.query || options.normalizedQuery).toLowerCase(),
    queryClass
  ].join(' ');
  const matchedAliases = Object.keys(aliasMap)
    .filter((alias) => alias && haystack.includes(alias));
  const aliasIds = uniqueStringList(matchedAliases.flatMap((alias) => aliasMap[alias] || []));
  const ids = aliasIds.length > 0 ? aliasIds : fallbackIds;
  return {
    ids,
    fallbackIds,
    aliasMap,
    matchedAliases,
    usedAliasPartition: aliasIds.length > 0
  };
}

function classifyRecallQuery(query = '') {
  const text = normalizeText(query).toLowerCase();
  if (!text) return 'empty';
  if (/(知识库|文档|资料|设定|世界观|角色设定|角色资料|规则|规范|项目知识|项目文档|外部文档|lore|worldbook|docs?|knowledge)/i.test(text)) {
    return 'external_kb';
  }
  if (/(刚才|刚刚|上次|之前|前面|昨天|今天|前天|还记得|记得|我是谁|你是谁|我们.*关系|关系称呼|叫我|称呼|我的|我喜欢|我不喜欢|用户画像|短期记忆|本地记忆|继续)/i.test(text)) {
    return 'local_memory';
  }
  return 'neutral';
}

function tokenizeRecallTerms(value = '') {
  const text = normalizeText(value).toLowerCase();
  const asciiTerms = (text.match(/[a-z0-9_/-]{2,}/g) || [])
    .map((item) => item.replace(/^[-_/]+|[-_/]+$/g, ''))
    .filter((item) => item.length >= 2);
  const cjkTerms = (text.match(/[\u4e00-\u9fa5]{2,}/g) || [])
    .flatMap((segment) => {
      const terms = [segment];
      for (let index = 0; index <= segment.length - 2; index += 1) {
        terms.push(segment.slice(index, index + 2));
      }
      return terms;
    });
  return Array.from(new Set([...asciiTerms, ...cjkTerms]))
    .filter((term) => !/^(the|and|for|with|this|that|是什么|怎么|请帮|继续|刚才|上次|之前)$/i.test(term))
    .slice(0, 80);
}

function evaluateMemosRouteGate(query = '', options = {}) {
  const currentConfig = {
    ...getConfig(),
    ...normalizeObject(options.config, {})
  };
  const queryClass = classifyRecallQuery(query);
  const allowlist = normalizeConfigList(
    options.routeAllowlist
    || currentConfig.MEMOS_RECALL_ROUTE_ALLOWLIST
    || process.env.MEMOS_RECALL_ROUTE_ALLOWLIST
  );
  const routeSignals = getRouteSignalValues(options);
  const localQueryGuardEnabled = currentConfig.MEMOS_RECALL_LOCAL_QUERY_GUARD_ENABLED !== false;
  if (allowlist.includes('*') || allowlist.includes('all')) {
    return {
      enabled: true,
      allowed: true,
      reason: 'allowlist_all',
      queryClass,
      allowlist,
      routeSignals
    };
  }
  if (allowlist.length > 0) {
    const haystack = [...routeSignals, queryClass, normalizeText(query).toLowerCase()].join(' ');
    const matched = allowlist.find((entry) => entry && haystack.includes(entry));
    if (localQueryGuardEnabled && queryClass === 'local_memory') {
      return {
        enabled: true,
        allowed: false,
        reason: 'local_memory_query',
        matched: matched || '',
        queryClass,
        allowlist,
        routeSignals
      };
    }
    return {
      enabled: true,
      allowed: Boolean(matched),
      reason: matched ? 'allowlist_match' : 'route_not_allowlisted',
      matched: matched || '',
      queryClass,
      allowlist,
      routeSignals
    };
  }
  if (localQueryGuardEnabled && queryClass === 'local_memory') {
    return {
      enabled: true,
      allowed: false,
      reason: 'local_memory_query',
      queryClass,
      allowlist,
      routeSignals
    };
  }
  return {
    enabled: localQueryGuardEnabled,
    allowed: true,
    reason: queryClass === 'external_kb' ? 'external_kb_query' : 'open',
    queryClass,
    allowlist,
    routeSignals
  };
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

function extractRecallItemKbId(item = {}) {
  const normalized = normalizeObject(item, {});
  const raw = normalizeObject(normalized.raw, {});
  return normalizeText(
    normalized.knowledgebaseId
    || normalized.knowledgebase_id
    || normalized.kbId
    || normalized.kb_id
    || raw.knowledgebase_id
    || raw.knowledgebaseId
    || raw.kb_id
    || raw.kbId
    || raw.knowledge_base_id
    || raw.knowledgeBaseId
  );
}

function stripQueryNoise(value = '') {
  return normalizeText(value)
    .replace(/\[CQ:[^\]]+\]/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/(?:继续刚才|接着刚才|上面说的|前面提到的|继续前面|接着前面)/gi, ' ')
    .replace(/(?:刚才|刚刚|上次|之前|前面|昨天|今天|前天|还记得|记得)/g, ' ')
    .replace(/^\s*(?:的|了|继续|接着|然后|请|帮我|帮忙)+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildMemosRecallQuery(query = '', options = {}) {
  const currentConfig = {
    ...getConfig(),
    ...normalizeObject(options.config, {})
  };
  const rawQuery = normalizeText(query);
  const mode = normalizeText(
    options.queryMode
    || currentConfig.MEMOS_RECALL_QUERY_MODE
    || process.env.MEMOS_RECALL_QUERY_MODE,
    'compact'
  ).toLowerCase();
  const maxChars = clampNumber(
    options.queryMaxChars
    ?? currentConfig.MEMOS_RECALL_QUERY_MAX_CHARS
    ?? process.env.MEMOS_RECALL_QUERY_MAX_CHARS,
    40,
    500,
    160
  );
  if (mode === 'raw' || mode === 'off') {
    return {
      query: truncateText(rawQuery, maxChars),
      mode: mode === 'off' ? 'off' : 'raw',
      rawQuery,
      changed: rawQuery.length > maxChars
    };
  }
  const routeSignals = getRouteSignalValues(options)
    .filter((item) => !/^(direct_chat|chat|none|answer|default|main|private|group)$/i.test(item))
    .slice(0, 4);
  const directedContext = normalizeObject(options.directedContext || options.routeMeta?.directedContext, {});
  const directedTerms = [
    directedContext.topic,
    directedContext.domain,
    directedContext.goal,
    directedContext.query
  ]
    .map((item) => stripQueryNoise(item))
    .filter(Boolean)
    .slice(0, 3);
  const compact = truncateText(
    [stripQueryNoise(rawQuery), ...directedTerms, ...routeSignals]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim() || rawQuery,
    maxChars
  );
  return {
    query: compact,
    mode: 'compact',
    rawQuery,
    changed: compact !== rawQuery
  };
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
      readOnly: true,
      queryMode: '',
      queryChanged: false,
      routeGate: null,
      quality: null
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
      queryMode: '',
      queryChanged: false,
      routeGate: null,
      quality: null,
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
      knowledgebaseId: normalizeText(
        value.knowledgebase_id
        || value.knowledgebaseId
        || value.kb_id
        || value.kbId
        || value.knowledge_base_id
        || value.knowledgeBaseId
      ),
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
      createdAt: normalizeText(item.createdAt),
      knowledgebaseId: extractRecallItemKbId(item)
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

function isGenericRemoteText(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return true;
  if (/^(ok|none|null|undefined|无|暂无|没有|empty)$/i.test(normalized)) return true;
  if (/^(用户|user|assistant|system)[:：]?\s*$/i.test(normalized)) return true;
  return false;
}

function filterRecallItemsByQuality(items = [], options = {}) {
  const currentConfig = {
    ...getConfig(),
    ...normalizeObject(options.config, {})
  };
  const minScoreRaw = options.minScore ?? currentConfig.MEMOS_RECALL_MIN_SCORE ?? process.env.MEMOS_RECALL_MIN_SCORE;
  const minScore = Number.isFinite(Number(minScoreRaw)) ? Number(minScoreRaw) : 0;
  const minChars = clampNumber(
    options.minChars ?? currentConfig.MEMOS_RECALL_MIN_CHARS ?? process.env.MEMOS_RECALL_MIN_CHARS,
    0,
    500,
    6
  );
  const requireTitle = (
    options.requireTitle
    ?? currentConfig.MEMOS_RECALL_REQUIRE_TITLE
    ?? process.env.MEMOS_RECALL_REQUIRE_TITLE
  ) === true || String(
    options.requireTitle
    ?? currentConfig.MEMOS_RECALL_REQUIRE_TITLE
    ?? process.env.MEMOS_RECALL_REQUIRE_TITLE
    ?? ''
  ).toLowerCase() === 'true';
  const filteredItems = [];
  const removedItems = [];
  for (const item of normalizeArray(items)) {
    const normalized = normalizeObject(item, {});
    const text = normalizeText(normalized.text);
    const score = Number.isFinite(Number(normalized.score)) ? Number(normalized.score) : null;
    let reason = '';
    if (!text || isGenericRemoteText(text)) reason = 'generic_or_empty';
    else if (text.length < minChars) reason = 'below_min_chars';
    else if (minScore > 0 && score !== null && score < minScore) reason = 'below_min_score';
    else if (requireTitle && !normalizeText(normalized.title)) reason = 'missing_title';
    if (reason) {
      removedItems.push({
        id: normalizeText(normalized.id),
        reason,
        score,
        text
      });
    } else {
      filteredItems.push(normalized);
    }
  }
  return {
    items: filteredItems,
    diagnostics: {
      enabled: minScore > 0 || minChars > 0 || requireTitle,
      minScore,
      minChars,
      requireTitle,
      kept: filteredItems.length,
      removed: removedItems.length,
      removedItems: removedItems.map((item) => ({
        id: item.id,
        reason: item.reason,
        score: item.score,
        text: truncateText(item.text, 160)
      }))
    }
  };
}

function scoreRecallItemForRerank(item = {}, context = {}) {
  const text = normalizeText(item.text).toLowerCase();
  const title = normalizeText(item.title).toLowerCase();
  const source = normalizeText(item.source).toLowerCase();
  const kbId = extractRecallItemKbId(item);
  const baseScore = Number.isFinite(Number(item.score)) ? Number(item.score) : 0.35;
  const terms = normalizeArray(context.terms);
  const titleHits = terms.filter((term) => title.includes(term)).length;
  const textHits = terms.filter((term) => text.includes(term)).length;
  const sourceHits = terms.filter((term) => source.includes(term)).length;
  const kbBoost = Number(context.kbBoostMap?.[kbId] || 0) || 0;
  const titleBoost = Math.min(0.3, titleHits * 0.08);
  const textBoost = Math.min(0.35, textHits * 0.035);
  const sourceBoost = Math.min(0.12, sourceHits * 0.04);
  const structuredBoost = (title ? 0.04 : 0) + (source ? 0.02 : 0);
  const finalScore = baseScore + titleBoost + textBoost + sourceBoost + kbBoost + structuredBoost;
  const reasons = [];
  if (titleHits > 0) reasons.push(`title:${titleHits}`);
  if (textHits > 0) reasons.push(`text:${textHits}`);
  if (sourceHits > 0) reasons.push(`source:${sourceHits}`);
  if (kbBoost > 0) reasons.push(`kb:${kbId}`);
  if (structuredBoost > 0) reasons.push('structured');
  return {
    ...item,
    rerankScore: Number(finalScore.toFixed(6)),
    rerankReasons: reasons
  };
}

function rerankRecallItems(items = [], options = {}) {
  const currentConfig = {
    ...getConfig(),
    ...normalizeObject(options.config, {})
  };
  const enabled = (
    options.rerankEnabled
    ?? currentConfig.MEMOS_RECALL_RERANK_ENABLED
    ?? process.env.MEMOS_RECALL_RERANK_ENABLED
  ) !== false && String(
    options.rerankEnabled
    ?? currentConfig.MEMOS_RECALL_RERANK_ENABLED
    ?? process.env.MEMOS_RECALL_RERANK_ENABLED
    ?? 'true'
  ).toLowerCase() !== 'false';
  const inputItems = normalizeArray(items);
  const topK = clampNumber(options.topK ?? currentConfig.MEMOS_RECALL_TOP_K, 1, 20, 5);
  const routeTerms = [
    options.query,
    options.rawQuery,
    ...getRouteSignalValues(options)
  ].flatMap((item) => tokenizeRecallTerms(item));
  const terms = Array.from(new Set(routeTerms)).slice(0, 80);
  const kbBoostMap = {
    ...getMemosKbAliasBoostMap({ ...options, config: currentConfig }),
    ...normalizeObject(options.kbBoostMap, {})
  };
  const scored = inputItems.map((item) => scoreRecallItemForRerank(item, { terms, kbBoostMap }));
  const ranked = enabled
    ? scored
      .map((item, index) => ({ item, index }))
      .sort((left, right) => {
        const delta = Number(right.item.rerankScore || 0) - Number(left.item.rerankScore || 0);
        if (Math.abs(delta) > 0.000001) return delta;
        return left.index - right.index;
      })
      .map((entry) => entry.item)
    : inputItems;
  return {
    items: ranked.slice(0, topK),
    diagnostics: {
      enabled,
      candidateCount: inputItems.length,
      kept: Math.min(topK, ranked.length),
      queryTermCount: terms.length,
      topReasons: ranked.slice(0, Math.min(topK, 5)).map((item) => ({
        id: normalizeText(item.id),
        score: Number.isFinite(Number(item.score)) ? Number(item.score) : null,
        rerankScore: Number.isFinite(Number(item.rerankScore)) ? Number(item.rerankScore) : null,
        reasons: normalizeArray(item.rerankReasons).slice(0, 6)
      }))
    }
  };
}

function formatMemosRecallPrompt(items = [], options = {}) {
  const maxChars = clampNumber(options.maxChars, 120, 8000, 900);
  const lines = normalizeArray(items)
    .map((item, index) => {
      const score = Number.isFinite(Number(item.score)) ? ` score=${Number(item.score).toFixed(3)}` : '';
      const createdAt = normalizeText(item.createdAt) ? ` time=${normalizeText(item.createdAt)}` : '';
      const source = normalizeText(item.source) ? ` source=${normalizeText(item.source)}` : ' source=memos';
      const title = normalizeText(item.title) ? ` title=${normalizeText(item.title)}` : '';
      const why = normalizeArray(item.rerankReasons).length > 0
        ? ` why=${normalizeArray(item.rerankReasons).slice(0, 3).join('|')}`
        : '';
      return `${index + 1}. ${normalizeText(item.text)}${source}${title}${score}${createdAt}${why}`;
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
  const kbPartition = resolveKnowledgebaseIds({ ...options, config: currentConfig, query });
  const knowledgebaseIds = kbPartition.ids;
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
  return resolveKnowledgebaseIds(options).ids;
}

function getMemosRecallCacheTtlMs(options = {}) {
  const currentConfig = {
    ...getConfig(),
    ...normalizeObject(options.config, {})
  };
  return clampNumber(
    options.cacheTtlMs ?? currentConfig.MEMOS_RECALL_CACHE_TTL_MS ?? process.env.MEMOS_RECALL_CACHE_TTL_MS,
    0,
    60 * 60 * 1000,
    5 * 60 * 1000
  );
}

function getMemosRecallCacheMaxSize(options = {}) {
  const currentConfig = {
    ...getConfig(),
    ...normalizeObject(options.config, {})
  };
  return clampNumber(
    options.cacheMaxSize ?? currentConfig.MEMOS_RECALL_CACHE_MAX_SIZE ?? process.env.MEMOS_RECALL_CACHE_MAX_SIZE,
    1,
    100000,
    500
  );
}

function pruneMemosRecallCache(options = {}) {
  const ttlMs = getMemosRecallCacheTtlMs(options);
  const maxSize = getMemosRecallCacheMaxSize(options);
  const now = Date.now();
  if (ttlMs > 0) {
    for (const [cacheKey, cached] of memosRecallRuntimeState.cache.entries()) {
      if (now - Number(cached?.storedAt || 0) > ttlMs) {
        memosRecallRuntimeState.cache.delete(cacheKey);
      }
    }
  }
  while (memosRecallRuntimeState.cache.size > maxSize) {
    const oldestKey = memosRecallRuntimeState.cache.keys().next().value;
    if (oldestKey === undefined) break;
    memosRecallRuntimeState.cache.delete(oldestKey);
  }
}

function getMemosCircuitOptions(options = {}) {
  const currentConfig = {
    ...getConfig(),
    ...normalizeObject(options.config, {})
  };
  return {
    failureThreshold: clampNumber(
      options.circuitFailureThreshold
        ?? currentConfig.MEMOS_RECALL_CIRCUIT_FAILURE_THRESHOLD
        ?? process.env.MEMOS_RECALL_CIRCUIT_FAILURE_THRESHOLD,
      1,
      20,
      3
    ),
    cooldownMs: clampNumber(
      options.circuitCooldownMs
        ?? currentConfig.MEMOS_RECALL_CIRCUIT_COOLDOWN_MS
        ?? process.env.MEMOS_RECALL_CIRCUIT_COOLDOWN_MS,
      0,
      60 * 60 * 1000,
      60 * 1000
    )
  };
}

function buildMemosRecallCacheKey(input = {}) {
  const keyObject = {
    serverName: normalizeText(input.serverName),
    recallSource: normalizeText(input.recallSource),
    query: normalizeText(input.normalizedQuery || input.query).toLowerCase(),
    kbIds: normalizeArray(input.kbIds).map((item) => normalizeText(item)).filter(Boolean).sort(),
    fileIds: normalizeArray(input.fileIds).map((item) => normalizeText(item)).filter(Boolean).sort(),
    routeSignals: normalizeArray(input.routeSignals).map((item) => normalizeText(item)).filter(Boolean).sort(),
    topK: Number(input.topK || 0) || 0,
    maxChars: Number(input.maxChars || 0) || 0
  };
  return stableHash(JSON.stringify(keyObject));
}

function getCachedMemosRecall(cacheKey = '', ttlMs = 0) {
  if (!cacheKey || ttlMs <= 0) return null;
  pruneMemosRecallCache({ cacheTtlMs: ttlMs });
  const cached = memosRecallRuntimeState.cache.get(cacheKey);
  if (!cached) {
    memosRecallRuntimeState.stats.cacheMisses += 1;
    return null;
  }
  if (Date.now() - Number(cached.storedAt || 0) > ttlMs) {
    memosRecallRuntimeState.cache.delete(cacheKey);
    memosRecallRuntimeState.stats.cacheMisses += 1;
    return null;
  }
  memosRecallRuntimeState.stats.cacheHits += 1;
  return {
    ...cached.value,
    diagnostics: {
      ...normalizeObject(cached.value?.diagnostics, {}),
      cache: {
        hit: true,
        key: cacheKey,
        ttlMs,
        ageMs: Math.max(0, Date.now() - Number(cached.storedAt || 0))
      }
    }
  };
}

function storeCachedMemosRecall(cacheKey = '', value = {}, ttlMs = 0, options = {}) {
  if (!cacheKey || ttlMs <= 0) return;
  memosRecallRuntimeState.cache.set(cacheKey, {
    storedAt: Date.now(),
    value
  });
  memosRecallRuntimeState.stats.cacheStores += 1;
  pruneMemosRecallCache({ ...options, cacheTtlMs: ttlMs });
}

function getCircuitKey(serverName = '', recallSource = '') {
  return `${normalizeText(serverName)}:${normalizeText(recallSource)}`;
}

function getMemosCircuitState(serverName = '', recallSource = '') {
  const key = getCircuitKey(serverName, recallSource);
  return memosRecallRuntimeState.circuit.get(key) || {
    key,
    failures: 0,
    openedAt: 0,
    openUntil: 0,
    lastError: ''
  };
}

function shouldShortCircuitMemosRecall(serverName = '', recallSource = '') {
  const state = getMemosCircuitState(serverName, recallSource);
  return Number(state.openUntil || 0) > Date.now();
}

function recordMemosCircuitSuccess(serverName = '', recallSource = '') {
  const key = getCircuitKey(serverName, recallSource);
  memosRecallRuntimeState.circuit.delete(key);
  memosRecallRuntimeState.stats.circuitSuccesses += 1;
}

function recordMemosCircuitFailure(serverName = '', recallSource = '', error = '', options = {}) {
  const { failureThreshold, cooldownMs } = getMemosCircuitOptions(options);
  const key = getCircuitKey(serverName, recallSource);
  const previous = getMemosCircuitState(serverName, recallSource);
  const failures = Number(previous.failures || 0) + 1;
  const opened = failures >= failureThreshold;
  const now = Date.now();
  const next = {
    key,
    failures,
    openedAt: opened ? now : Number(previous.openedAt || 0),
    openUntil: opened ? now + cooldownMs : Number(previous.openUntil || 0),
    lastError: truncateText(error, 160)
  };
  memosRecallRuntimeState.circuit.set(key, next);
  memosRecallRuntimeState.stats.circuitFailures += 1;
  return next;
}

function getMemosRecallRuntimeDiagnostics(options = {}) {
  const currentConfig = {
    ...getConfig(),
    ...normalizeObject(options.config, {})
  };
  const serverName = getMemosServerName({ ...options, config: currentConfig });
  const recallSource = getMemosRecallSource({ ...options, config: currentConfig });
  const circuitState = getMemosCircuitState(serverName, recallSource);
  return {
    cache: {
      size: memosRecallRuntimeState.cache.size,
      ttlMs: getMemosRecallCacheTtlMs({ ...options, config: currentConfig }),
      maxSize: getMemosRecallCacheMaxSize({ ...options, config: currentConfig }),
      hits: memosRecallRuntimeState.stats.cacheHits,
      misses: memosRecallRuntimeState.stats.cacheMisses,
      stores: memosRecallRuntimeState.stats.cacheStores
    },
    circuit: {
      ...circuitState,
      open: Number(circuitState.openUntil || 0) > Date.now(),
      failureThreshold: getMemosCircuitOptions({ ...options, config: currentConfig }).failureThreshold,
      cooldownMs: getMemosCircuitOptions({ ...options, config: currentConfig }).cooldownMs,
      shortCircuits: memosRecallRuntimeState.stats.circuitShortCircuits
    }
  };
}

function resetMemosRecallRuntimeState() {
  memosRecallRuntimeState.cache.clear();
  memosRecallRuntimeState.circuit.clear();
  memosRecallRuntimeState.stats.cacheHits = 0;
  memosRecallRuntimeState.stats.cacheMisses = 0;
  memosRecallRuntimeState.stats.cacheStores = 0;
  memosRecallRuntimeState.stats.circuitShortCircuits = 0;
  memosRecallRuntimeState.stats.circuitFailures = 0;
  memosRecallRuntimeState.stats.circuitSuccesses = 0;
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
  const rawItems = normalizeRecallItems(result, { topK: Math.min(20, topK * 2), maxChars, source: 'memos_kb' });
  const quality = filterRecallItemsByQuality(rawItems, { ...options, config: currentConfig });
  const rerank = rerankRecallItems(quality.items, {
    ...options,
    config: currentConfig,
    query: normalizedQuery,
    topK
  });
  const items = rerank.items;
  const promptText = formatMemosRecallPrompt(items, { maxChars });
  return {
    query: normalizedQuery,
    items,
    used: items.length > 0,
    rejectedReason: items.length > 0 ? '' : (rawItems.length > 0 ? 'quality_filtered' : 'empty_result'),
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
      readOnly: true,
      rawCandidateCount: rawItems.length,
      quality: quality.diagnostics,
      rerank: rerank.diagnostics
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
  const rawItems = normalizeRecallItems(result, { topK: Math.min(20, topK * 2), maxChars, source: 'memos_memory' });
  const quality = filterRecallItemsByQuality(rawItems, { ...options, config: currentConfig });
  const kbPartition = resolveKnowledgebaseIds({
    ...options,
    config: currentConfig,
    query: normalizedQuery,
    normalizedQuery
  });
  const rerank = rerankRecallItems(quality.items, {
    ...options,
    config: currentConfig,
    query: normalizedQuery,
    topK
  });
  const items = rerank.items;
  const promptText = formatMemosRecallPrompt(items, { maxChars });
  return {
    query: normalizedQuery,
    items,
    used: items.length > 0,
    rejectedReason: items.length > 0 ? '' : (rawItems.length > 0 ? 'quality_filtered' : 'empty_result'),
    promptText,
    diagnostics: {
      enabled: true,
      serverName,
      recallSource: 'search_memory',
      sourceToolName: searchToolName,
      kbToolName: discovery.kbToolName,
      searchToolName,
      knowledgebaseIdsCount: kbPartition.ids.length,
      kbPartition: {
        matchedAliases: kbPartition.matchedAliases,
        usedAliasPartition: kbPartition.usedAliasPartition,
        fallbackIdsCount: kbPartition.fallbackIds.length
      },
      availableTools: discovery.availableTools,
      durationMs: Math.max(0, Date.now() - startedAt),
      fallback: result?.fallback === true,
      error: normalizeText(discovery.error),
      readOnly: true,
      rawCandidateCount: rawItems.length,
      quality: quality.diagnostics,
      rerank: rerank.diagnostics
    }
  };
}

async function recallForPlanner(query = '', options = {}) {
  const startedAt = Date.now();
  const rawQuery = normalizeText(query);
  const currentConfig = {
    ...getConfig(),
    ...normalizeObject(options.config, {})
  };
  const serverName = getMemosServerName({ ...options, config: currentConfig });
  const recallSource = getMemosRecallSource({ ...options, config: currentConfig });
  const maxChars = clampNumber(options.maxChars ?? currentConfig.MEMOS_RECALL_MAX_CHARS, 120, 8000, 900);
  const topK = clampNumber(options.topK ?? currentConfig.MEMOS_RECALL_TOP_K, 1, 20, 5);
  const timeoutMs = clampNumber(options.timeoutMs ?? currentConfig.MEMOS_RECALL_TIMEOUT_MS, 100, 30000, 1200);
  const routeGate = evaluateMemosRouteGate(rawQuery, { ...options, config: currentConfig });
  const queryPlan = buildMemosRecallQuery(rawQuery, { ...options, config: currentConfig });
  const normalizedQuery = queryPlan.query;
  const kbPartition = resolveKnowledgebaseIds({
    ...options,
    config: currentConfig,
    query: normalizedQuery,
    normalizedQuery
  });
  const kbFileIds = normalizeStringList(
    options.fileIds
    || options.kbFileIds
    || currentConfig.MEMOS_KB_FILE_IDS
  );
  const cacheTtlMs = getMemosRecallCacheTtlMs({ ...options, config: currentConfig });
  const circuitOptions = getMemosCircuitOptions({ ...options, config: currentConfig });
  const cacheKey = buildMemosRecallCacheKey({
    serverName,
    recallSource,
    normalizedQuery,
    kbIds: kbPartition.ids,
    fileIds: kbFileIds,
    routeSignals: routeGate.routeSignals,
    topK,
    maxChars
  });
  const attachBoundaryDiagnostics = (recall = {}) => ({
    ...recall,
    rawQuery,
    query: normalizeText(recall.query || normalizedQuery),
    diagnostics: {
      ...normalizeObject(recall.diagnostics, {}),
      routeGate,
      queryMode: queryPlan.mode,
      queryChanged: queryPlan.changed,
      rawQueryPreview: truncateText(rawQuery, 160),
      timeoutMs,
      cache: {
        hit: false,
        key: cacheKey,
        ttlMs: cacheTtlMs,
        ...normalizeObject(recall.diagnostics?.cache, {})
      },
      circuit: {
        ...getMemosCircuitState(serverName, recallSource),
        open: shouldShortCircuitMemosRecall(serverName, recallSource),
        failureThreshold: circuitOptions.failureThreshold,
        cooldownMs: circuitOptions.cooldownMs,
        ...normalizeObject(recall.diagnostics?.circuit, {})
      },
      kbPartition: {
        matchedAliases: kbPartition.matchedAliases,
        usedAliasPartition: kbPartition.usedAliasPartition,
        fallbackIdsCount: kbPartition.fallbackIds.length,
        ...normalizeObject(recall.diagnostics?.kbPartition, {})
      }
    }
  });

  if (!currentConfig.MEMOS_MCP_ENABLED) {
    return attachBoundaryDiagnostics(buildEmptyRecall(normalizedQuery, {
      rejectedReason: 'disabled',
      diagnostics: {
        enabled: false,
        serverName,
        recallSource,
        durationMs: Math.max(0, Date.now() - startedAt)
      }
    }));
  }
  if (currentConfig.MEMOS_REMOTE_RECALL_ENABLED !== true) {
    return attachBoundaryDiagnostics(buildEmptyRecall(normalizedQuery, {
      rejectedReason: 'remote_recall_disabled',
      diagnostics: {
        enabled: false,
        remoteRecallEnabled: false,
        serverName,
        recallSource,
        durationMs: Math.max(0, Date.now() - startedAt)
      }
    }));
  }
  if (!routeGate.allowed) {
    return attachBoundaryDiagnostics(buildEmptyRecall(normalizedQuery, {
      rejectedReason: routeGate.reason || 'route_not_allowed',
      diagnostics: {
        enabled: true,
        serverName,
        recallSource,
        durationMs: Math.max(0, Date.now() - startedAt),
        readOnly: true
      }
    }));
  }
  if (!normalizedQuery) {
    return attachBoundaryDiagnostics(buildEmptyRecall(normalizedQuery, {
      rejectedReason: 'empty_query',
      diagnostics: {
        enabled: true,
        serverName,
        recallSource,
        durationMs: Math.max(0, Date.now() - startedAt)
      }
    }));
  }

  if (shouldShortCircuitMemosRecall(serverName, recallSource)) {
    memosRecallRuntimeState.stats.circuitShortCircuits += 1;
    return attachBoundaryDiagnostics(buildEmptyRecall(normalizedQuery, {
      rejectedReason: 'circuit_open',
      diagnostics: {
        enabled: true,
        serverName,
        recallSource,
        durationMs: Math.max(0, Date.now() - startedAt),
        error: getMemosCircuitState(serverName, recallSource).lastError,
        readOnly: true,
        circuit: {
          ...getMemosCircuitState(serverName, recallSource),
          open: true
        }
      }
    }));
  }

  const cachedRecall = getCachedMemosRecall(cacheKey, cacheTtlMs);
  if (cachedRecall) {
    return attachBoundaryDiagnostics({
      ...cachedRecall,
      diagnostics: {
        ...normalizeObject(cachedRecall.diagnostics, {}),
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
    let resultRecall;
    if (recallSource === 'search_memory') {
      resultRecall = await callSearchMemoryRecall(normalizedQuery, recallOptions);
      recordMemosCircuitSuccess(serverName, recallSource);
      if (resultRecall.used || resultRecall.rejectedReason) storeCachedMemosRecall(cacheKey, resultRecall, cacheTtlMs, { ...options, config: currentConfig });
      return attachBoundaryDiagnostics(resultRecall);
    }
    if (recallSource === 'auto') {
      const kbArgs = buildKnowledgeBaseArgs({ ...options, config: currentConfig, topK });
      if (kbPartition.ids.length > 0) {
        resultRecall = await callSearchMemoryRecall(normalizedQuery, recallOptions);
        recordMemosCircuitSuccess(serverName, recallSource);
        storeCachedMemosRecall(cacheKey, resultRecall, cacheTtlMs, { ...options, config: currentConfig });
        return attachBoundaryDiagnostics(resultRecall);
      }
      if (discovery.kbToolName && kbArgs.file_ids.length > 0) {
        const kbRecall = await callKnowledgeBaseRecall(normalizedQuery, recallOptions);
        if (kbRecall.used || currentConfig.MEMOS_KB_FALLBACK_SEARCH_ENABLED !== true) {
          recordMemosCircuitSuccess(serverName, recallSource);
          storeCachedMemosRecall(cacheKey, kbRecall, cacheTtlMs, { ...options, config: currentConfig });
          return attachBoundaryDiagnostics(kbRecall);
        }
      }
      resultRecall = await callSearchMemoryRecall(normalizedQuery, recallOptions);
      recordMemosCircuitSuccess(serverName, recallSource);
      storeCachedMemosRecall(cacheKey, resultRecall, cacheTtlMs, { ...options, config: currentConfig });
      return attachBoundaryDiagnostics(resultRecall);
    }
    if (kbPartition.ids.length > 0) {
      const kbSearchRecall = await callSearchMemoryRecall(normalizedQuery, recallOptions);
      resultRecall = {
        ...kbSearchRecall,
        diagnostics: {
          ...kbSearchRecall.diagnostics,
          recallSource: 'knowledge_base_search',
          sourceToolName: kbSearchRecall.diagnostics.searchToolName,
          kbMode: 'knowledgebase_ids'
        }
      };
      recordMemosCircuitSuccess(serverName, recallSource);
      storeCachedMemosRecall(cacheKey, resultRecall, cacheTtlMs, { ...options, config: currentConfig });
      return attachBoundaryDiagnostics(resultRecall);
    }
    const kbRecall = await callKnowledgeBaseRecall(normalizedQuery, recallOptions);
    if (
      kbRecall.used
      || currentConfig.MEMOS_KB_FALLBACK_SEARCH_ENABLED !== true
      || !discovery.searchToolName
    ) {
      recordMemosCircuitSuccess(serverName, recallSource);
      storeCachedMemosRecall(cacheKey, kbRecall, cacheTtlMs, { ...options, config: currentConfig });
      return attachBoundaryDiagnostics(kbRecall);
    }
    const searchRecall = await callSearchMemoryRecall(normalizedQuery, recallOptions);
    resultRecall = {
      ...searchRecall,
      diagnostics: {
        ...searchRecall.diagnostics,
        recallSource: 'knowledge_base_fallback_search',
        fallbackReason: kbRecall.rejectedReason || 'kb_empty'
      }
    };
    recordMemosCircuitSuccess(serverName, recallSource);
    storeCachedMemosRecall(cacheKey, resultRecall, cacheTtlMs, { ...options, config: currentConfig });
    return attachBoundaryDiagnostics(resultRecall);
  } catch (error) {
    const circuit = recordMemosCircuitFailure(
      serverName,
      recallSource,
      normalizeText(error?.message || error || discovery.error),
      { ...options, config: currentConfig }
    );
    return attachBoundaryDiagnostics(buildEmptyRecall(normalizedQuery, {
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
        readOnly: true,
        circuit
      }
    }));
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
      enabled: isMemosPlannerRecallEnabled({ ...options, config: currentConfig }),
      mcpEnabled: currentConfig.MEMOS_MCP_ENABLED === true,
      remoteRecallEnabled: currentConfig.MEMOS_REMOTE_RECALL_ENABLED === true,
      serverName,
      readOnly: true
    }
  };
}

async function diagnoseMemosPlannerRecall(options = {}) {
  const currentConfig = {
    ...getConfig(),
    ...normalizeObject(options.config, {})
  };
  const startedAt = Date.now();
  const serverName = getMemosServerName({ ...options, config: currentConfig });
  const recallSource = getMemosRecallSource({ ...options, config: currentConfig });
  const timeoutMs = clampNumber(options.timeoutMs ?? currentConfig.MEMOS_RECALL_TIMEOUT_MS, 100, 30000, 1200);
  const kbPartition = resolveKnowledgebaseIds({
    ...options,
    config: currentConfig,
    query: options.query || ''
  });
  const fileIds = normalizeStringList(
    options.fileIds
    || options.kbFileIds
    || currentConfig.MEMOS_KB_FILE_IDS
  );
  const routeGate = evaluateMemosRouteGate(options.query || '', { ...options, config: currentConfig });
  const queryPlan = buildMemosRecallQuery(options.query || '', { ...options, config: currentConfig });
  const enabled = isMemosPlannerRecallEnabled({ ...options, config: currentConfig });
  if (!enabled && options.forceDiscovery !== true) {
    const skippedReason = currentConfig.MEMOS_MCP_ENABLED === true
      ? 'remote_recall_disabled'
      : 'memos_disabled';
    return {
      ok: true,
      enabled: false,
      mcpEnabled: currentConfig.MEMOS_MCP_ENABLED === true,
      remoteRecallEnabled: currentConfig.MEMOS_REMOTE_RECALL_ENABLED === true,
      serverName,
      recallSource,
      readOnly: true,
      configured: {
        knowledgebaseIdsCount: kbPartition.ids.length,
        fallbackKnowledgebaseIdsCount: kbPartition.fallbackIds.length,
        kbFileIdsCount: fileIds.length,
        kbAliasCount: Object.keys(kbPartition.aliasMap).length,
        matchedAliases: kbPartition.matchedAliases,
        usedAliasPartition: kbPartition.usedAliasPartition,
        routeAllowlistCount: normalizeConfigList(currentConfig.MEMOS_RECALL_ROUTE_ALLOWLIST).length,
        localQueryGuardEnabled: currentConfig.MEMOS_RECALL_LOCAL_QUERY_GUARD_ENABLED !== false,
        queryMode: queryPlan.mode,
        queryChanged: queryPlan.changed,
        topK: clampNumber(options.topK ?? currentConfig.MEMOS_RECALL_TOP_K, 1, 20, 5),
        maxChars: clampNumber(options.maxChars ?? currentConfig.MEMOS_RECALL_MAX_CHARS, 120, 8000, 900),
        timeoutMs
      },
      routeGate,
      discovery: {
        availableTools: [],
        kbToolName: '',
        searchToolName: '',
        addToolName: '',
        mutatingToolNames: [],
        mutatingToolsDetected: false,
        error: '',
        skipped: true,
        skippedReason
      },
      runtime: getMemosRecallRuntimeDiagnostics({ ...options, config: currentConfig }),
      durationMs: Math.max(0, Date.now() - startedAt)
    };
  }
  const discovery = await discoverMemosTools({ ...options, config: currentConfig, timeoutMs });
  return {
    ok: discovery.error ? false : true,
    enabled,
    mcpEnabled: currentConfig.MEMOS_MCP_ENABLED === true,
    remoteRecallEnabled: currentConfig.MEMOS_REMOTE_RECALL_ENABLED === true,
    serverName,
    recallSource,
    readOnly: true,
    configured: {
      knowledgebaseIdsCount: kbPartition.ids.length,
      fallbackKnowledgebaseIdsCount: kbPartition.fallbackIds.length,
      kbFileIdsCount: fileIds.length,
      kbAliasCount: Object.keys(kbPartition.aliasMap).length,
      matchedAliases: kbPartition.matchedAliases,
      usedAliasPartition: kbPartition.usedAliasPartition,
      routeAllowlistCount: normalizeConfigList(currentConfig.MEMOS_RECALL_ROUTE_ALLOWLIST).length,
      localQueryGuardEnabled: currentConfig.MEMOS_RECALL_LOCAL_QUERY_GUARD_ENABLED !== false,
      queryMode: queryPlan.mode,
      queryChanged: queryPlan.changed,
      topK: clampNumber(options.topK ?? currentConfig.MEMOS_RECALL_TOP_K, 1, 20, 5),
      maxChars: clampNumber(options.maxChars ?? currentConfig.MEMOS_RECALL_MAX_CHARS, 120, 8000, 900),
      timeoutMs
    },
    routeGate,
    discovery: {
      availableTools: discovery.availableTools,
      kbToolName: discovery.kbToolName,
      searchToolName: discovery.searchToolName,
      addToolName: discovery.addToolName,
      mutatingToolNames: discovery.mutatingToolNames,
      mutatingToolsDetected: discovery.mutatingToolNames.length > 0,
      error: discovery.error
    },
    runtime: getMemosRecallRuntimeDiagnostics({ ...options, config: currentConfig })
  };
}

module.exports = {
  addMessageToMemos,
  buildKnowledgeBaseArgs,
  buildMemosRecallQuery,
  buildSearchArgs,
  diagnoseMemosPlannerRecall,
  discoverMemosTools,
  evaluateMemosRouteGate,
  filterRecallItemsByQuality,
  formatMemosRecallPrompt,
  getMemosRecallPromptText,
  getMemosRecallSource,
  getMemosServerName,
  getConfiguredKnowledgebaseIds,
  getMemosRecallRuntimeDiagnostics,
  isMemosPlannerRecallEnabled,
  normalizeRecallItems,
  rerankRecallItems,
  recallForPlanner,
  resetMemosRecallRuntimeState,
  truncateText
};
