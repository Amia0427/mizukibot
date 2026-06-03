const CODEX_USER_AGENT = 'codex-cli/0.121.0 (external, cli)';
const BROWSER_CHROME_VERSION = '149.0.7827.54';
const BROWSER_CHROME_MAJOR = BROWSER_CHROME_VERSION.split('.')[0];
const BROWSER_USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${BROWSER_CHROME_VERSION} Safari/537.36`;
const BROWSER_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7';

function normalizeUserAgent(value, fallback = CODEX_USER_AGENT) {
  const text = String(value || '').trim();
  if (/codex/i.test(text)) return text;
  const fallbackText = String(fallback || '').trim();
  return /codex/i.test(fallbackText) ? fallbackText : CODEX_USER_AGENT;
}

function isBrowserUserAgent(value = '') {
  const text = String(value || '').trim();
  return /^Mozilla\/5\.0\b/i.test(text)
    && /(Chrome|CriOS|Edg|Firefox|Safari)\/[\d.]+/i.test(text);
}

function normalizeBrowserUserAgent(value, fallback = BROWSER_USER_AGENT) {
  const text = String(value || '').trim();
  if (isBrowserUserAgent(text)) return text;
  const fallbackText = String(fallback || '').trim();
  return isBrowserUserAgent(fallbackText) ? fallbackText : BROWSER_USER_AGENT;
}

function extractChromeMajorFromUserAgent(userAgent = '') {
  const match = String(userAgent || '').match(/\b(?:Chrome|CriOS|Edg)\/(\d+)/i);
  return match ? match[1] : BROWSER_CHROME_MAJOR;
}

function normalizeOrigin(value = '') {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  try {
    const url = new URL(text);
    return url.origin;
  } catch (_) {
    return '';
  }
}

function normalizeReferer(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    return new URL(text).href;
  } catch (_) {
    return '';
  }
}

function inferOriginFromUrl(value = '') {
  try {
    return new URL(String(value || '').trim()).origin;
  } catch (_) {
    return '';
  }
}

function normalizeFetchSite(value = '', hasOrigin = false) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['same-origin', 'same-site', 'cross-site', 'none'].includes(normalized)) return normalized;
  return hasOrigin ? 'same-origin' : 'cross-site';
}

function buildBrowserClientHints(userAgent = BROWSER_USER_AGENT) {
  const major = extractChromeMajorFromUserAgent(userAgent);
  return {
    'sec-ch-ua': `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not/A)Brand";v="24"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"'
  };
}

function buildBrowserLikeRequestHeaders(options = {}) {
  const userAgent = normalizeBrowserUserAgent(options.userAgent, BROWSER_USER_AGENT);
  const origin = normalizeOrigin(options.origin) || inferOriginFromUrl(options.apiBaseUrl);
  const referer = normalizeReferer(options.referer) || (origin ? `${origin}/` : '');
  const headers = {
    Accept: String(options.accept || '*/*').trim() || '*/*',
    'Accept-Language': String(options.acceptLanguage || BROWSER_ACCEPT_LANGUAGE).trim() || BROWSER_ACCEPT_LANGUAGE,
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'User-Agent': userAgent,
    ...buildBrowserClientHints(userAgent),
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': normalizeFetchSite(options.secFetchSite, Boolean(origin)),
    Priority: 'u=1, i'
  };
  if (origin) headers.Origin = origin;
  if (referer) headers.Referer = referer;
  return headers;
}

module.exports = {
  BROWSER_ACCEPT_LANGUAGE,
  BROWSER_CHROME_MAJOR,
  BROWSER_CHROME_VERSION,
  BROWSER_USER_AGENT,
  CODEX_USER_AGENT,
  buildBrowserLikeRequestHeaders,
  isBrowserUserAgent,
  normalizeBrowserUserAgent,
  normalizeUserAgent
};
