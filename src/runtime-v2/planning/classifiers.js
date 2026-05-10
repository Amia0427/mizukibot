function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function getPlannerRequestText(route = {}) {
  const routeMeta = normalizeObject(route?.meta, {});
  const quotePriority = normalizeObject(routeMeta.quotePriority, null);
  return normalizeText(
    routeMeta.effectiveIntentText
    || quotePriority?.quoteAnchoredText
    || route?.cleanText
    || route?.question
  );
}

function getPlannerSearchSeed(route = {}) {
  const directedContext = normalizeObject(route?.meta?.directedContext, {});
  const quotePriority = normalizeObject(route?.meta?.quotePriority, null);
  return normalizeText(
    quotePriority?.quoteAnchoredText
    || directedContext?.quote?.text
    || route?.cleanText
    || route?.question
    || 'recent context'
  );
}

function chooseTaskShape(route = {}) {
  const executionMode = normalizeText(route?.intent?.executionMode);
  if (executionMode === 'background' || executionMode === 'delegated') return 'background_tool_task';
  if (executionMode === 'staged') return 'tool_augmented_reply';
  return 'fast_reply';
}

function prefersMemoryRecall(cleanText = '') {
  const text = normalizeText(cleanText);
  if (!text) return false;
  return /(记得|记不记得|前几天|之前|刚才|聊过|说过|我们.*(事情|聊)|回忆|日志)/i.test(text);
}

function isNotebookListingRequest(cleanText = '') {
  const text = normalizeText(cleanText);
  if (!text) return false;
  return /(列出|列表|有哪些|都有什么|目录|文档列表|笔记列表|所有笔记|notebook list|list docs?|document list)/i.test(text);
}

function shouldKeepNotebookAnswerChatOnly(route = {}, options = {}) {
  if (options.allowPlannerCorrection === true) return false;
  const sourceScope = normalizeText(route?.facets?.sourceScope);
  if (sourceScope !== 'notebook') return false;
  const toolIntent = normalizeText(route?.meta?.toolIntent);
  if (toolIntent === 'force_tools') return false;
  const responseIntent = normalizeText(route?.meta?.responseIntent) || 'answer';
  if (responseIntent !== 'answer') return false;
  const cleanText = getPlannerRequestText(route);
  if (isNotebookListingRequest(cleanText)) return false;
  if (/(总结|摘要|概括|提炼|梳理|改写|润色|summary|summari[sz]e|recap|outline|rewrite|rephrase)/i.test(cleanText)) return false;
  return true;
}

function isWeatherRequest(cleanText = '', route = {}) {
  const text = normalizeText(cleanText);
  if (normalizeText(route?.facets?.domain) === 'weather') return true;
  return /(天气|气温|温度|下雨|降温|湿度|风力|weather|temperature|forecast)/i.test(text);
}

function isContextStatsRequest(cleanText = '') {
  const text = normalizeText(cleanText);
  if (!text) return false;
  return /(上下文|context|token|剩余上下文|context usage|remaining context|token usage|token count|context limit)/i.test(text);
}

function isArxivLatestRequest(cleanText = '') {
  const text = normalizeText(cleanText);
  return /(arxiv).*(最新|最近|latest|recent)|(?:最新|最近|latest|recent).*(arxiv)/i.test(text);
}

function isArxivIdRequest(cleanText = '') {
  const text = normalizeText(cleanText);
  return /\b\d{4}\.\d{4,5}(?:v\d+)?\b/i.test(text);
}

function isArxivRequest(cleanText = '', route = {}) {
  const text = normalizeText(cleanText);
  if (normalizeText(route?.facets?.domain) === 'research' && /\barxiv\b/i.test(text)) return true;
  return /\barxiv\b/i.test(text);
}

function isFinanceQuoteRequest(cleanText = '') {
  const text = normalizeText(cleanText);
  if (!text) return false;
  return /(实时股价|股价|报价|行情|价格|price|quote|ticker|盘前|盘后|现价)/i.test(text);
}

function isFinanceDividendRequest(cleanText = '') {
  const text = normalizeText(cleanText);
  return /(分红|股息|派息|dividend|yield)/i.test(text);
}

function isFinanceRumorRequest(cleanText = '') {
  const text = normalizeText(cleanText);
  return /(传闻|谣言|消息面|rumor|sentiment|headline|新闻情绪)/i.test(text);
}

function isFinanceWatchlistRequest(cleanText = '') {
  const text = normalizeText(cleanText);
  return /(自选|观察列表|watchlist|提醒|alert)/i.test(text);
}

function isFinancePortfolioRequest(cleanText = '') {
  const text = normalizeText(cleanText);
  return /(持仓|组合|仓位|portfolio|holdings)/i.test(text);
}

function isFinanceAnalysisRequest(cleanText = '', route = {}) {
  const text = normalizeText(cleanText);
  const isFinanceDomain = normalizeText(route?.facets?.domain) === 'finance'
    || /(股票|美股|港股|a股|基金|加密|币圈|股价|分红|股息|观察列表|投资组合|行情|财报|stock|stocks|ticker|portfolio|watchlist|dividend|crypto)/i.test(text);
  if (!isFinanceDomain) return false;
  if (isFinanceQuoteRequest(text) || isFinanceDividendRequest(text) || isFinanceRumorRequest(text)
    || isFinanceWatchlistRequest(text) || isFinancePortfolioRequest(text)) {
    return false;
  }
  return /(分析|怎么看|看法|解读|分析一下|analyze|analysis|outlook|valuation|研判)/i.test(text);
}

function hasExplicitHttpUrl(text = '') {
  return /https?:\/\/\S+/i.test(normalizeText(text));
}

function isExplicitUrlLookup(cleanText = '') {
  return hasExplicitHttpUrl(cleanText);
}

function extractExplicitUrl(text = '') {
  const match = String(text || '').match(/https?:\/\/\S+/i);
  return String(match?.[0] || '').trim();
}

function extractTickerHint(text = '') {
  const raw = String(text || '');
  const normalized = raw.trim();
  if (!normalized) return '';
  const financeCue = /(股票|美股|港股|a股|基金|加密|币圈|股价|分红|股息|观察列表|投资组合|行情|财报|ticker|quote|stock|stocks|portfolio|watchlist|dividend|crypto|price)/i.test(normalized);
  if (!financeCue) return '';
  const tickerMatch = normalized.match(/\b[A-Z]{2,5}(?:\.[A-Z]{1,3})?\b/g);
  const blacklist = new Set(['AND', 'THE', 'USD', 'CNY', 'HK', 'ETF', 'STOCK', 'PRICE']);
  const candidate = Array.isArray(tickerMatch)
    ? tickerMatch.find((item) => !blacklist.has(String(item || '').trim().toUpperCase()))
    : '';
  return String(candidate || '').trim().toUpperCase();
}

function isSubjectiveOpinionQuestion(route = {}) {
  const cleanText = getPlannerRequestText(route);
  return /^(你觉得|你认为|你喜不喜欢|你喜歡|你怎么看|你觉得.*好听吗|你觉得.*怎么样|how do you feel|what do you think)/i.test(cleanText)
    && !Boolean(route?.intent?.needsMemory)
    && !/latest|最新|official|官网|文档|docs?|documentation|source|来源|时间|date|time/i.test(cleanText);
}

module.exports = {
  chooseTaskShape,
  extractExplicitUrl,
  extractTickerHint,
  getPlannerRequestText,
  getPlannerSearchSeed,
  hasExplicitHttpUrl,
  isArxivIdRequest,
  isArxivLatestRequest,
  isArxivRequest,
  isContextStatsRequest,
  isExplicitUrlLookup,
  isFinanceAnalysisRequest,
  isFinanceDividendRequest,
  isFinancePortfolioRequest,
  isFinanceQuoteRequest,
  isFinanceRumorRequest,
  isFinanceWatchlistRequest,
  isNotebookListingRequest,
  isSubjectiveOpinionQuestion,
  isWeatherRequest,
  prefersMemoryRecall,
  shouldKeepNotebookAnswerChatOnly
};
