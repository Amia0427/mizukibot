const { TOOL_EXECUTORS } = require('../api/toolExecutors');
const config = require('../config');
const { saveResearchBrief } = require('../utils/sessionResearchCache');

const ALLOWED_RESEARCH_TOOLS = Object.freeze(['url_safety_check', 'web_search', 'web_fetch']);

function normalizeText(value = '') {
  return String(value || '').trim();
}

function trimText(value = '', maxLength = 1800) {
  const text = normalizeText(value).replace(/\s+/g, ' ');
  const limit = Math.max(200, Number(maxLength || 0) || 1800);
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function extractUrls(text = '') {
  const urls = [];
  const seen = new Set();
  const pattern = /https?:\/\/[^\s)\]}>"']+/gi;
  for (const match of String(text || '').matchAll(pattern)) {
    const url = normalizeText(match[0]).replace(/[.,;???]+$/g, '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length >= 5) break;
  }
  return urls;
}

function buildSourceFromFetch(url = '', fetchedText = '') {
  const text = normalizeText(fetchedText);
  const firstLine = text.split(/\r?\n/).map((line) => normalizeText(line)).find(Boolean) || url;
  return {
    url,
    title: trimText(firstLine, 120),
    snippet: trimText(text, 600)
  };
}

function buildSummary(query = '', searchText = '', sources = []) {
  const sourceLines = sources.slice(0, 3).map((source, index) => {
    const title = normalizeText(source.title) || normalizeText(source.url) || `source ${index + 1}`;
    const snippet = trimText(source.snippet, 360);
    return `${index + 1}. ${title}${snippet ? ` ? ${snippet}` : ''}`;
  });
  if (sourceLines.length > 0) {
    return trimText(`Background research for "${query}":\n${sourceLines.join('\n')}`, 1800);
  }
  return trimText(`Background research for "${query}":\n${searchText}`, 1800);
}

function assertAllowedTool(toolName = '') {
  const normalized = normalizeText(toolName);
  if (!ALLOWED_RESEARCH_TOOLS.includes(normalized)) {
    throw new Error(`research_subagent tool not allowed: ${normalized || 'unknown'}`);
  }
}

async function callResearchTool(toolName = '', args = {}) {
  assertAllowedTool(toolName);
  const executor = TOOL_EXECUTORS[toolName];
  if (typeof executor !== 'function') throw new Error(`research_subagent missing tool: ${toolName}`);
  return executor(args);
}

async function runResearchSubagent(task = {}, options = {}) {
  const query = normalizeText(task.query || task.question);
  const sessionKey = normalizeText(task.sessionKey);
  const userId = normalizeText(task.userId);
  const maxRounds = Math.max(1, Math.min(5, Number(options.maxToolRounds || config.RESEARCH_SUBAGENT_MAX_TOOL_ROUNDS || 3) || 3));
  const sources = [];
  const toolLog = [];
  if (!query) throw new Error('research_subagent query is empty');

  let rounds = 0;
  const explicitUrls = extractUrls(query);
  for (const url of explicitUrls.slice(0, 2)) {
    if (rounds >= maxRounds) break;
    rounds += 1;
    const safety = await callResearchTool('url_safety_check', { url });
    toolLog.push({ tool: 'url_safety_check', args: { url }, result: trimText(safety, 300) });
    if (/unsafe|blocked|danger|forbidden/i.test(String(safety || ''))) continue;
    if (rounds >= maxRounds) break;
    rounds += 1;
    const fetched = await callResearchTool('web_fetch', { url });
    toolLog.push({ tool: 'web_fetch', args: { url }, result: trimText(fetched, 500) });
    sources.push(buildSourceFromFetch(url, fetched));
  }

  let searchText = '';
  if (sources.length === 0 && rounds < maxRounds) {
    rounds += 1;
    searchText = String(await callResearchTool('web_search', { query })) || '';
    toolLog.push({ tool: 'web_search', args: { query }, result: trimText(searchText, 700) });
    const urls = extractUrls(searchText).slice(0, Math.max(1, maxRounds - rounds));
    for (const url of urls) {
      if (rounds >= maxRounds) break;
      rounds += 1;
      const fetched = await callResearchTool('web_fetch', { url });
      toolLog.push({ tool: 'web_fetch', args: { url }, result: trimText(fetched, 500) });
      sources.push(buildSourceFromFetch(url, fetched));
    }
  }

  const summary = buildSummary(query, searchText || toolLog.map((item) => item.result).join('\n'), sources);
  const brief = saveResearchBrief({
    sessionKey,
    userId,
    query,
    status: 'completed',
    summary,
    sources,
    ttlMs: options.cacheTtlMs
  });
  return {
    ...brief,
    toolLog,
    allowedTools: [...ALLOWED_RESEARCH_TOOLS]
  };
}

module.exports = {
  ALLOWED_RESEARCH_TOOLS,
  extractUrls,
  runResearchSubagent
};
