const crypto = require('crypto');
const { canonicalizeKnownShareUrl } = require('../../../core/continuousMessage/contentExtraction');

const PLATFORM_HOSTS = Object.freeze({
  bilibili: new Set(['bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'b23.tv', 'bili2233.cn']),
  xiaohongshu: new Set(['xiaohongshu.com', 'www.xiaohongshu.com', 'm.xiaohongshu.com', 'xhslink.com', 'xhschlink.com']),
  netease_music: new Set(['music.163.com', 'y.music.163.com', '163cn.tv'])
});

const SHORT_LINK_HOSTS = new Set(['b23.tv', 'bili2233.cn', 'xhslink.com', 'xhschlink.com', '163cn.tv']);

function normalizeText(value = '') {
  return String(value || '').trim();
}

function isHostOrSubdomain(hostname = '', root = '') {
  const host = normalizeText(hostname).toLowerCase();
  const suffix = normalizeText(root).toLowerCase();
  return Boolean(host && suffix && (host === suffix || host.endsWith(`.${suffix}`)));
}

function identifySharedLinkPlatform(url = '') {
  let parsed;
  try {
    parsed = new URL(normalizeText(url));
  } catch (_) {
    return '';
  }
  if (!/^https?:$/.test(parsed.protocol)) return '';
  const host = parsed.hostname.toLowerCase();
  if (PLATFORM_HOSTS.bilibili.has(host)) return 'bilibili';
  if (PLATFORM_HOSTS.xiaohongshu.has(host)) return 'xiaohongshu';
  if (PLATFORM_HOSTS.netease_music.has(host)) return 'netease_music';
  return '';
}

function parseSharedLinkUrl(url = '') {
  const rawUrl = normalizeText(url);
  const platform = identifySharedLinkPlatform(rawUrl);
  if (!platform) return null;
  const parsed = new URL(rawUrl);
  return {
    platform,
    url: parsed.href,
    canonicalUrl: canonicalizeKnownShareUrl(parsed.href),
    isShortLink: SHORT_LINK_HOSTS.has(parsed.hostname.toLowerCase())
  };
}

function summarizeSharedLinkUrl(url = '') {
  const parsed = parseSharedLinkUrl(url);
  const source = parsed?.canonicalUrl || parsed?.url || normalizeText(url);
  return {
    platform: parsed?.platform || 'unsupported',
    contentId: crypto.createHash('sha256').update(source).digest('hex').slice(0, 12)
  };
}

function extractFirstSupportedSharedLink(text = '') {
  const matches = normalizeText(text).match(/https?:\/\/[^\s<>"'\]\[）】]+/gi) || [];
  for (const candidate of matches) {
    const cleaned = candidate.replace(/[，。！？；、]+$/u, '').replace(/[),]+$/, '');
    if (identifySharedLinkPlatform(cleaned)) return cleaned;
  }
  return '';
}

function parseBilibiliReference(url = '') {
  const parsed = new URL(normalizeText(url));
  const matched = parsed.pathname.match(/\/(?:video\/)?(BV[0-9A-Za-z]{10}|av\d+)/i);
  if (!matched) return null;
  const id = matched[1];
  const page = Math.max(1, Number(parsed.searchParams.get('p')) || 1);
  return {
    id,
    bvid: /^BV/i.test(id) ? id : '',
    aid: /^av/i.test(id) ? id.slice(2) : '',
    page
  };
}

function parseNeteaseReference(url = '') {
  const parsed = new URL(normalizeText(url));
  let path = parsed.pathname;
  let searchParams = parsed.searchParams;
  if (parsed.hash.startsWith('#/')) {
    const hashUrl = new URL(parsed.hash.slice(1), 'https://music.163.com');
    path = hashUrl.pathname;
    searchParams = hashUrl.searchParams;
  }
  const matched = path.match(/^\/(?:m\/)?(song|playlist|album)\/?$/i);
  const id = normalizeText(searchParams.get('id'));
  if (!matched || !/^\d+$/.test(id)) return null;
  return {
    type: matched[1].toLowerCase(),
    id
  };
}

function parseXiaohongshuReference(url = '') {
  const parsed = new URL(normalizeText(url));
  const matched = parsed.pathname.match(/^\/(?:discovery\/item|explore)\/([0-9A-Za-z]+)/i);
  return matched ? { id: matched[1] } : null;
}

module.exports = {
  extractFirstSupportedSharedLink,
  identifySharedLinkPlatform,
  isHostOrSubdomain,
  parseBilibiliReference,
  parseNeteaseReference,
  parseSharedLinkUrl,
  parseXiaohongshuReference,
  summarizeSharedLinkUrl
};
