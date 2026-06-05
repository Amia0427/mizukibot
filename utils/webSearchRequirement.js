const WEB_LOOKUP_ALLOWED_TOOLS = Object.freeze(['web_search', 'web_fetch']);

function isExplicitWebSearchRequired(text = '') {
  const input = String(text || '').trim();
  if (!input) return false;
  if (/(联网搜索|网络搜索|网页搜索|网上搜索|web\s*search|internet\s*search|search\s+online|browse\s+the\s+web)/i.test(input)) {
    return true;
  }
  const hasSearchCue = /(联网|网络|网页|网上|web|internet|online|browse|google|搜索|搜一下|查询|查一下|查查|帮我查|检索|search|look up|find)/i.test(input);
  const hasMustCue = /(必须|务必|一定|先|再回答|后再回答|搜完|查完|搜索后|查过再|must|need to|before answering|after searching)/i.test(input);
  return hasSearchCue && hasMustCue;
}

function routeHasExplicitWebSearchRequirement(route = {}) {
  if (route?.meta?.explicitWebSearchRequired === true) return true;
  return isExplicitWebSearchRequired(route?.question || route?.cleanText || route?.rawText || '');
}

module.exports = {
  WEB_LOOKUP_ALLOWED_TOOLS,
  isExplicitWebSearchRequired,
  routeHasExplicitWebSearchRequirement
};
