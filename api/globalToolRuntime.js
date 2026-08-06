const config = require('../config');
const { normalizeToolNames } = require('../utils/localToolAccess');
const { enforceToolPolicy } = require('../utils/toolPolicy');
const {
  createMemoryCliTurnState,
  decideMemoryCliTurnAction,
  updateMemoryCliTurnStateAfterError,
  updateMemoryCliTurnStateAfterResult
} = require('../utils/memoryCliTurnPolicy');

function getToolRegistry() {
  return require('./toolRegistry');
}

function getToolExecutors() {
  return getToolRegistry().getToolExecutors();
}

function getToolSchemas() {
  return getToolRegistry().getToolSchemas();
}

const GLOBAL_TOOL_REGISTRY = [
  {
    toolName: 'memory_cli',
    executorName: 'memory_cli',
    schemaName: 'memory_cli',
    maxCallsPerTurn: 2,
    allowedInRoutes: ['chat', 'lookup', 'transform', 'plan', 'act', 'admin', 'direct_chat'],
    resultFormatter: formatMemoryCliEvidence,
    readOnly: true
  },
  {
    toolName: 'web_search',
    executorName: 'web_search',
    schemaName: 'web_search',
    maxCallsPerTurn: 1,
    allowedInRoutes: ['chat', 'lookup', 'transform', 'plan', 'act', 'admin', 'direct_chat'],
    resultFormatter: formatPlainEvidence,
    readOnly: true
  },
  {
    toolName: 'web_fetch',
    executorName: 'web_fetch',
    schemaName: 'web_fetch',
    maxCallsPerTurn: 1,
    allowedInRoutes: ['chat', 'lookup', 'transform', 'plan', 'act', 'admin', 'direct_chat'],
    resultFormatter: formatPlainEvidence,
    readOnly: true
  },
  {
    toolName: 'read_shared_link',
    executorName: 'read_shared_link',
    schemaName: 'read_shared_link',
    maxCallsPerTurn: 1,
    timeoutMs: 30000,
    allowedInRoutes: ['chat', 'lookup', 'transform', 'plan', 'act', 'admin', 'direct_chat'],
    resultFormatter: formatPlainEvidence,
    readOnly: true
  },
  {
    toolName: 'get_current_time',
    executorName: 'get_current_time',
    schemaName: 'get_current_time',
    maxCallsPerTurn: 1,
    allowedInRoutes: ['chat', 'lookup', 'transform', 'plan', 'act', 'admin', 'direct_chat'],
    resultFormatter: formatPlainEvidence,
    readOnly: true
  },
  {
    toolName: 'skill_weather',
    executorName: 'skill_weather',
    schemaName: 'skill_weather',
    maxCallsPerTurn: 1,
    allowedInRoutes: ['chat', 'lookup', 'transform', 'plan', 'act', 'admin', 'direct_chat'],
    resultFormatter: formatPlainEvidence,
    readOnly: true
  },
  {
    toolName: 'skill_earthquake_latest',
    executorName: 'skill_earthquake_latest',
    schemaName: 'skill_earthquake_latest',
    maxCallsPerTurn: 1,
    allowedInRoutes: ['chat', 'lookup', 'transform', 'plan', 'act', 'admin', 'direct_chat'],
    resultFormatter: formatPlainEvidence,
    readOnly: true
  },
  {
    toolName: 'skill_arxiv_search',
    executorName: 'skill_arxiv_search',
    schemaName: 'skill_arxiv_search',
    maxCallsPerTurn: 1,
    allowedInRoutes: ['chat', 'lookup', 'transform', 'plan', 'act', 'admin', 'direct_chat'],
    resultFormatter: formatPlainEvidence,
    readOnly: true
  },
  {
    toolName: 'skill_arxiv_get',
    executorName: 'skill_arxiv_get',
    schemaName: 'skill_arxiv_get',
    maxCallsPerTurn: 1,
    allowedInRoutes: ['chat', 'lookup', 'transform', 'plan', 'act', 'admin', 'direct_chat'],
    resultFormatter: formatPlainEvidence,
    readOnly: true
  },
  {
    toolName: 'skill_arxiv_latest',
    executorName: 'skill_arxiv_latest',
    schemaName: 'skill_arxiv_latest',
    maxCallsPerTurn: 1,
    allowedInRoutes: ['chat', 'lookup', 'transform', 'plan', 'act', 'admin', 'direct_chat'],
    resultFormatter: formatPlainEvidence,
    readOnly: true
  }
];

const GLOBAL_TOOL_NAME_SET = new Set(GLOBAL_TOOL_REGISTRY.map((item) => item.toolName));
const GLOBAL_TOOL_REGISTRY_BY_NAME = new Map(GLOBAL_TOOL_REGISTRY.map((item) => [item.toolName, item]));
const DEFAULT_ALLOWED_TOP_ROUTE_TYPES = new Set(['chat', 'lookup', 'transform', 'plan', 'act', 'admin', 'direct_chat']);
const BLOCKED_TOP_ROUTE_TYPES = new Set(['refuse', 'clarify', 'ignore']);

function nowIso() {
  return new Date().toISOString();
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeTopRouteType(value = '') {
  return String(value || '').trim().toLowerCase();
}

function getGlobalToolConfigValue(...candidates) {
  for (const candidate of candidates) {
    const value = String(candidate?.value || '').trim();
    if (!value) continue;
    return {
      value,
      source: String(candidate?.source || '').trim() || 'unknown'
    };
  }
  return {
    value: '',
    source: 'unset'
  };
}

function summarizeApiBaseUrl(url = '') {
  const normalized = String(url || '').trim();
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch (_) {
    return normalized.replace(/\/\/([^/@]+)@/g, '//***@');
  }
}

function getGlobalToolModelConfig() {
  const apiBaseUrl = getGlobalToolConfigValue(
    { value: config.GLOBAL_TOOLS_API_BASE_URL, source: 'GLOBAL_TOOLS_API_BASE_URL' },
    { value: config.TOOLS_API_BASE_URL, source: 'TOOLS_API_BASE_URL' },
    { value: config.API_BASE_URL, source: 'API_BASE_URL' }
  );
  const apiKey = getGlobalToolConfigValue(
    { value: config.GLOBAL_TOOLS_API_KEY, source: 'GLOBAL_TOOLS_API_KEY' },
    { value: config.TOOLS_API_KEY, source: 'TOOLS_API_KEY' },
    { value: config.API_KEY, source: 'API_KEY' }
  );
  const model = getGlobalToolConfigValue(
    { value: config.GLOBAL_TOOLS_MODEL, source: 'GLOBAL_TOOLS_MODEL' },
    { value: config.TOOLS_MODEL, source: 'TOOLS_MODEL' },
    { value: config.AI_MODEL, source: 'AI_MODEL' },
    { value: 'gpt-5.4', source: 'default' }
  );
  return {
    enabled: Boolean(config.GLOBAL_TOOLS_ENABLED),
    apiBaseUrl: apiBaseUrl.value,
    apiBaseUrlSource: apiBaseUrl.source,
    apiBaseUrlSummary: summarizeApiBaseUrl(apiBaseUrl.value),
    apiKey: apiKey.value,
    apiKeySource: apiKey.source,
    model: model.value,
    modelSource: model.source,
    temperature: 0.1,
    topP: 0.9,
    maxCallsPerTurn: Math.max(1, Math.min(8, Number(config.GLOBAL_TOOLS_MAX_CALLS_PER_TURN) || 4)),
    maxPlannerTurns: 1,
    maxEvidenceChars: Math.max(800, Math.min(20000, Number(config.GLOBAL_TOOLS_MAX_EVIDENCE_CHARS) || 6000))
  };
}

function getGlobalToolSchemas(allowedToolNames = []) {
  const allowed = new Set(normalizeToolNames(allowedToolNames).filter((toolName) => GLOBAL_TOOL_NAME_SET.has(toolName)));
  return getToolSchemas().filter((schema) => allowed.has(String(schema?.function?.name || '').trim()));
}

function stripGlobalToolsFromAllowedTools(allowedTools = []) {
  return normalizeToolNames(allowedTools).filter((toolName) => !GLOBAL_TOOL_NAME_SET.has(toolName));
}

function formatArgsSummary(toolName, args = {}) {
  const normalizedArgs = normalizeObject(args, {});
  if (toolName === 'memory_cli') {
    return `command=${JSON.stringify(String(normalizedArgs.command || '').trim())}`;
  }
  if (toolName === 'web_search') {
    return `query=${JSON.stringify(String(normalizedArgs.query || '').trim())}`;
  }
  if (toolName === 'web_fetch') {
    return `url=${JSON.stringify(String(normalizedArgs.url || '').trim())}`;
  }
  if (toolName === 'read_shared_link') {
    const { summarizeSharedLinkUrl } = require('./skills_native/sharedLink/url');
    const summary = summarizeSharedLinkUrl(normalizedArgs.url);
    return `platform=${summary.platform}, contentId=${summary.contentId}`;
  }
  if (toolName === 'get_current_time') {
    return `timezone=${JSON.stringify(String(normalizedArgs.timezone || '').trim() || config.TIMEZONE)}`;
  }
  if (toolName === 'skill_weather') {
    const sections = Array.isArray(normalizedArgs.sections) ? normalizedArgs.sections : ['overview'];
    return `location=${JSON.stringify(String(normalizedArgs.location || normalizedArgs.city || normalizedArgs.text || '').trim())}, sections=${JSON.stringify(sections)}, days=${Number(normalizedArgs.days ?? 4)}, hours=${Number(normalizedArgs.hours ?? 24)}`;
  }
  if (toolName === 'skill_earthquake_latest') {
    return `scope=${JSON.stringify(String(normalizedArgs.scope || 'global').trim())}, time_window=${JSON.stringify(String(normalizedArgs.time_window || 'day').trim())}, min_magnitude=${Number(normalizedArgs.min_magnitude ?? 4.5)}, limit=${Number(normalizedArgs.limit ?? 5)}`;
  }
  if (toolName === 'skill_arxiv_search') {
    return `query=${JSON.stringify(String(normalizedArgs.query || '').trim())}`;
  }
  if (toolName === 'skill_arxiv_get') {
    return `arxiv_id=${JSON.stringify(String(normalizedArgs.arxiv_id || '').trim())}`;
  }
  if (toolName === 'skill_arxiv_latest') {
    return `categories=${JSON.stringify(normalizedArgs.categories || [])}`;
  }
  const pairs = Object.entries(normalizedArgs).slice(0, 4).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return pairs.join(', ');
}

function trimEvidence(text = '', maxChars = 1200) {
  const normalized = String(text || '').replace(/\s+\n/g, '\n').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 12)).trim()} [truncated]`;
}

function formatPlainEvidence(result) {
  return trimEvidence(result, 1600);
}

function formatMemoryCliEvidence(result) {
  const rawText = String(result || '').trim();
  if (!rawText) return '';

  let parsed = null;
  try {
    parsed = JSON.parse(rawText);
  } catch (_) {
    parsed = null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return trimEvidence(rawText, 1600);
  }

  if (parsed.command === 'search') {
    const results = normalizeArray(parsed.results).slice(0, 4).map((item, index) => {
      const ref = String(item?.ref || item?.id || `result_${index + 1}`).trim();
      const title = String(item?.title || item?.name || '').trim();
      const preview = String(item?.preview || item?.snippet || item?.digest || '').trim();
      return [`ref=${ref}`, title ? `title=${title}` : '', preview ? `preview=${preview}` : '']
        .filter(Boolean)
        .join(' | ');
    });
    return trimEvidence([
      `search_count=${Number(parsed.count || results.length || 0)}`,
      ...results
    ].filter(Boolean).join('\n'), 1800);
  }

  if (parsed.command === 'open') {
    const dataText = typeof parsed.data === 'string'
      ? parsed.data
      : JSON.stringify(parsed.data || {});
    return trimEvidence(dataText, 1800);
  }

  return trimEvidence(rawText, 1600);
}

function isMemorySearchHit(result) {
  const rawText = String(result || '').trim();
  if (!rawText) return false;
  try {
    const parsed = JSON.parse(rawText);
    if (String(parsed?.command || '').trim() !== 'search') return false;
    return Number(parsed?.count || normalizeArray(parsed?.results).length || 0) > 0;
  } catch (_) {
    return false;
  }
}

function shouldPreferMemoryOpenFollowup(result) {
  const rawText = String(result || '').trim();
  if (!rawText) return false;
  try {
    const parsed = JSON.parse(rawText);
    if (String(parsed?.command || '').trim() !== 'search') return false;
    const first = normalizeArray(parsed?.results)[0] || null;
    if (!first || !String(first.ref || '').trim()) return false;
    const source = String(first.source || '').trim().toLowerCase();
    if (!['recent', 'task', 'journal'].includes(source)) return false;
    const preview = String(first.preview || first.text || '').trim().toLowerCase();
    return /(open loop|commitment|carry:|topic:|recent|continue|pathology|truncated|\.\.\.)/.test(preview);
  } catch (_) {
    return false;
  }
}

function parseSearchResultRows(resultText = '') {
  const rows = [];
  const text = String(resultText || '').trim();
  if (!text) return rows;
  const blocks = text.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split('\n').map((item) => item.trim()).filter(Boolean);
    const urlLine = lines.find((line) => /^https?:\/\//i.test(line));
    if (!urlLine) continue;
    const titleLine = lines.find((line) => /^\d+\.\s+/.test(line)) || '';
    const title = titleLine.replace(/^\d+\.\s+/, '').trim();
    const desc = lines.find((line) => line !== titleLine && line !== urlLine) || '';
    rows.push({ title, url: urlLine, desc });
  }
  return rows;
}

function extractPreferredDomains(question = '') {
  const text = String(question || '').trim();
  const matches = text.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/ig) || [];
  return [...new Set(matches.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))];
}

function selectBestSearchUrl(question = '', resultText = '') {
  const rows = parseSearchResultRows(resultText);
  if (rows.length === 0) return '';
  const text = String(question || '').trim().toLowerCase();
  const preferredDomains = extractPreferredDomains(question);
  const ranked = rows
    .map((row, index) => {
      const url = String(row?.url || '').trim().toLowerCase();
      const title = String(row?.title || '').trim().toLowerCase();
      const desc = String(row?.desc || '').trim().toLowerCase();
      let score = 0;
      if (preferredDomains.some((domain) => url.includes(domain))) score += 100;
      if (/(官网|官方|official)/i.test(text) && /(official|docs|developer|help|support|api)/i.test(`${url} ${title}`)) score += 30;
      if (/(文档|docs?|documentation|api)/i.test(text) && /(docs|doc|developer|api)/i.test(`${url} ${title}`)) score += 25;
      if (/(latest|最新|news|新闻)/i.test(text) && /(news|blog|release|changelog|announc)/i.test(`${url} ${title} ${desc}`)) score += 10;
      if (/^https?:\/\//i.test(url)) score += 5;
      return { url: row.url, score, index };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index);
  return String(ranked[0]?.url || '').trim();
}

function shouldPreferWebFetchFollowup(question = '', results = []) {
  const text = String(question || '').trim();
  if (!text) return false;
  if (!/(官方|官网|official|文档|docs?|documentation|source|来源|依据|网页|page|article|文章|detail|详情|summary|总结|全文|正文|内容|latest|最新|news|新闻)/i.test(text)) {
    return false;
  }
  return normalizeArray(results).some((item) => {
    if (String(item?.tool || '').trim() !== 'web_search') return false;
    if (String(item?.status || '').trim() !== 'completed') return false;
    return Boolean(selectBestSearchUrl(question, item.rawResult));
  });
}

function logGlobalTools(message, context = {}, extra = {}) {
  console.log(`[global_tools] ${message}`, {
    userId: String(context.userId || '').trim(),
    topRouteType: String(context.topRouteType || '').trim(),
    routePolicyKey: String(context.routePolicyKey || '').trim(),
    allowedGlobalTools: normalizeToolNames(context.allowedGlobalTools),
    toolCount: Number(extra.toolCount || 0),
    durationMs: Number(extra.durationMs || 0),
    ...extra
  });
}

function buildToolContext(context = {}) {
  return {
    userId: String(context.userId || '').trim(),
    routePolicyKey: String(context.routePolicyKey || '').trim(),
    topRouteType: String(context.topRouteType || '').trim(),
    routeMeta: normalizeObject(context.routeMeta, {}),
    reviewMode: String(context.reviewMode || '').trim()
  };
}

async function executeGlobalToolBatch(toolCalls = [], context = {}) {
  const modelConfig = getGlobalToolModelConfig();
  const allowedTools = normalizeToolNames(context.allowedGlobalTools);
  const toolExecutors = normalizeObject(context.toolExecutors, getToolExecutors());
  const counters = new Map();
  const results = [];
  let nextMemoryCliTurn = createMemoryCliTurnState(context.memoryCliTurn);

  for (const toolCall of normalizeArray(toolCalls).slice(0, modelConfig.maxCallsPerTurn)) {
    const toolName = String(toolCall?.toolName || '').trim();
    const registryItem = GLOBAL_TOOL_REGISTRY_BY_NAME.get(toolName);
    if (!registryItem) continue;
    if (!allowedTools.includes(toolName)) continue;

    const usedCount = Number(counters.get(toolName) || 0);
    if (usedCount >= Number(registryItem.maxCallsPerTurn || 1)) continue;
    counters.set(toolName, usedCount + 1);

    const startedAt = Date.now();
    const toolResult = {
      tool: toolName,
      args: normalizeObject(toolCall.args, {}),
      argsSummary: '',
      status: 'failed',
      evidence: '',
      rawResult: '',
      timestamp: nowIso(),
      durationMs: 0
    };

    try {
      const normalizedArgs = enforceToolPolicy(toolName, toolCall.args || {}, {
        userId: context.userId
      });
      if (toolName === 'web_fetch' && !String(normalizedArgs.url || '').trim()) {
        const previousSearch = [...results].reverse().find((item) => String(item?.tool || '').trim() === 'web_search' && String(item?.status || '').trim() === 'completed');
        const resolvedUrl = selectBestSearchUrl(context.question, previousSearch?.rawResult || '');
        if (!resolvedUrl) {
          throw new Error('web_fetch could not resolve url from prior web_search evidence');
        }
        toolCall.args = {
          ...normalizedArgs,
          url: resolvedUrl
        };
      }
      const preparedArgs = enforceToolPolicy(toolName, toolCall.args || normalizedArgs, {
        userId: context.userId
      });
      toolResult.args = preparedArgs;
      toolResult.argsSummary = formatArgsSummary(toolName, preparedArgs);

      if (toolName === 'memory_cli') {
        const decision = decideMemoryCliTurnAction(preparedArgs.command, nextMemoryCliTurn);
        if (!decision.ok) {
          nextMemoryCliTurn = createMemoryCliTurnState(decision.nextState);
          toolResult.status = 'blocked';
          toolResult.rawResult = typeof decision.result === 'string' ? decision.result : JSON.stringify(decision.result);
          toolResult.evidence = formatMemoryCliEvidence(toolResult.rawResult);
        } else {
          const out = await toolExecutors[toolName]({
            ...preparedArgs,
            command: decision.preparedCommand || preparedArgs.command,
            __context: buildToolContext(context)
          });
          nextMemoryCliTurn = createMemoryCliTurnState(
            updateMemoryCliTurnStateAfterResult(nextMemoryCliTurn, decision.parsed, out)
          );
          toolResult.args = {
            ...preparedArgs,
            command: decision.preparedCommand || preparedArgs.command
          };
          toolResult.argsSummary = formatArgsSummary(toolName, toolResult.args);
          toolResult.status = 'completed';
          toolResult.rawResult = String(out || '').trim();
          toolResult.evidence = registryItem.resultFormatter(toolResult.rawResult);
        }
      } else {
        const out = await toolExecutors[toolName](preparedArgs);
        toolResult.status = 'completed';
        toolResult.rawResult = String(out || '').trim();
        toolResult.evidence = registryItem.resultFormatter(toolResult.rawResult);
      }
    } catch (error) {
      if (toolName === 'memory_cli') {
        nextMemoryCliTurn = createMemoryCliTurnState(
          updateMemoryCliTurnStateAfterError(nextMemoryCliTurn, 'tool_error')
        );
      }
      toolResult.status = 'failed';
      toolResult.rawResult = `Tool error: ${error.message}`;
      toolResult.evidence = trimEvidence(toolResult.rawResult, 600);
    }

    if (toolName === 'read_shared_link') {
      const { summarizeSharedLinkUrl } = require('./skills_native/sharedLink/url');
      toolResult.args = summarizeSharedLinkUrl(toolResult.args.url || toolCall.args?.url);
    }

    toolResult.durationMs = Date.now() - startedAt;
    results.push(toolResult);
    logGlobalTools('tool executed', context, {
      toolName,
      toolCount: 1,
      durationMs: toolResult.durationMs,
      status: toolResult.status
    });
  }

  return {
    results,
    memoryCliTurn: nextMemoryCliTurn
  };
}

function buildGlobalToolEvidenceMessage(results = [], context = {}) {
  const modelConfig = getGlobalToolModelConfig();
  const lines = [
    '[GlobalToolEvidence]',
    'Treat the following as external evidence gathered before the main answer.',
    'Use it when relevant. Do not repeat the same global tool request.'
  ];

  let remainingChars = modelConfig.maxEvidenceChars;
  for (const item of normalizeArray(results)) {
    if (remainingChars <= 0) break;
    const evidence = trimEvidence(item.evidence || item.rawResult || '', Math.min(1800, remainingChars));
    if (!evidence) continue;
    const block = [
      `tool: ${String(item.tool || '').trim()}`,
      `argsSummary: ${String(item.argsSummary || '').trim() || '(none)'}`,
      `status: ${String(item.status || '').trim() || 'unknown'}`,
      `evidence: ${evidence}`,
      `timestamp: ${String(item.timestamp || nowIso()).trim()}`
    ].join('\n');
    if (block.length > remainingChars) {
      lines.push(trimEvidence(block, remainingChars));
      remainingChars = 0;
      break;
    }
    lines.push(block);
    remainingChars -= block.length;
  }

  const text = lines.join('\n\n').trim();
  return text === '[GlobalToolEvidence]\n\nTreat the following as external evidence gathered before the main answer.\n\nUse it when relevant. Do not repeat the same global tool request.'
    ? ''
    : text;
}

async function maybeRunGlobalToolRuntime(_question = '', context = {}) {
  const policy = normalizeObject(context.policy, {});
  const reason = policy.allowGlobalTools ? 'agent-owned' : 'policy-disabled';
  logGlobalTools('skipped', context, { reason });
  return {
    skipped: true,
    reason,
    results: [],
    evidenceMessage: '',
    memoryCliTurn: createMemoryCliTurnState(context.memoryCliTurn)
  };
}

module.exports = {
  BLOCKED_TOP_ROUTE_TYPES,
  DEFAULT_ALLOWED_TOP_ROUTE_TYPES,
  GLOBAL_TOOL_NAME_SET,
  GLOBAL_TOOL_REGISTRY,
  summarizeApiBaseUrl,
  getGlobalToolModelConfig,
  getGlobalToolSchemas,
  maybeRunGlobalToolRuntime,
  buildGlobalToolEvidenceMessage,
  executeGlobalToolBatch,
  stripGlobalToolsFromAllowedTools
};
