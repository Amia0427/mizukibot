const { extractFirstSupportedSharedLink } = require('../../api/skills_native/sharedLink/url');

function normalizeToolNames(value) {
  return Array.from(new Set(
    (Array.isArray(value) ? value : [])
      .map((name) => String(name || '').trim())
      .filter(Boolean)
  ));
}

function getCardContexts(route = {}) {
  return (Array.isArray(route?.meta?.cardContexts) ? route.meta.cardContexts : [])
    .filter((card) => card && typeof card === 'object');
}

function getCardUrls(route = {}, cardContexts = getCardContexts(route)) {
  const primaryUrls = new Set(
    cardContexts.map((card) => String(card.primaryUrl || '').trim()).filter(Boolean)
  );
  const candidates = [
    ...(Array.isArray(route?.meta?.qqCardUrls)
      ? route.meta.qqCardUrls.filter((url) => primaryUrls.has(String(url || '').trim()))
      : []),
    ...cardContexts.map((card) => card.primaryUrl)
  ];
  return Array.from(new Set(candidates.map((url) => String(url || '').trim()).filter(Boolean)));
}

function hasExplicitCardReadRequest(text = '') {
  return /(查看|看看|读一下|读取|总结|摘要|概括|评价|点评|分析|比较|对比|区别|哪个好|怎么样|讲了什么|内容是什么)/i
    .test(String(text || ''));
}

function applyDeterministicToolRouting(route = {}) {
  if (!route || typeof route !== 'object' || route.topRouteType !== 'direct_chat') return route;
  const meta = route.meta && typeof route.meta === 'object' ? route.meta : {};
  const allowedTools = normalizeToolNames(meta.allowedTools);
  const nextAllowedTools = new Set(allowedTools);
  const text = String(route.question || route.cleanText || route.rawText || '');
  const sharedLink = extractFirstSupportedSharedLink(text);
  if (sharedLink) nextAllowedTools.add('read_shared_link');

  const cardContexts = getCardContexts(route);
  let cardReadPolicy = '';
  let cardUrls = [];
  if (cardContexts.length > 3) {
    cardReadPolicy = 'limit_exceeded';
  } else if (cardContexts.length > 0) {
    cardUrls = getCardUrls(route, cardContexts);
    const chatType = String(meta.chatType || '').trim().toLowerCase();
    const shouldRead = cardUrls.length > 1
      || hasExplicitCardReadRequest(text)
      || (chatType === 'private' && meta.cardOnly === true);
    if (shouldRead && cardUrls.length > 0) {
      nextAllowedTools.add('web_fetch');
      cardReadPolicy = 'read';
    } else {
      cardReadPolicy = cardUrls.length > 0 ? 'metadata_only' : 'unreadable';
    }
  }

  return {
    ...route,
    meta: {
      ...meta,
      allowedTools: Array.from(nextAllowedTools),
      ...(sharedLink ? { sharedLinkUrl: sharedLink } : {}),
      ...(cardReadPolicy ? { cardReadPolicy } : {}),
      ...(cardUrls.length > 0 ? { qqCardUrls: cardUrls } : {})
    }
  };
}

module.exports = {
  applyDeterministicToolRouting,
  getCardContexts,
  getCardUrls,
  hasExplicitCardReadRequest
};
