const axios = require('axios');
const config = require('../../../config');
const { requestSafeHttpUrl } = require('../../../utils/networkSafety');
const { SharedLinkError } = require('./errors');
const { isHostOrSubdomain } = require('./url');

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 12000;

function isAllowedPlatformResourceHost(platform = '', hostname = '') {
  const host = String(hostname || '').trim().toLowerCase();
  if (platform === 'xiaohongshu') {
    return isHostOrSubdomain(host, 'xiaohongshu.com')
      || isHostOrSubdomain(host, 'xhscdn.com')
      || host === 'xhslink.com'
      || host === 'xhschlink.com';
  }
  if (platform === 'bilibili') {
    return isHostOrSubdomain(host, 'bilibili.com')
      || isHostOrSubdomain(host, 'hdslb.com')
      || isHostOrSubdomain(host, 'bilivideo.com')
      || host === 'b23.tv'
      || host === 'bili2233.cn';
  }
  if (platform === 'netease_music') {
    return host === 'music.163.com' || host === 'y.music.163.com' || host === '163cn.tv';
  }
  return false;
}

function isXiaohongshuCookieHost(hostname = '') {
  return isHostOrSubdomain(hostname, 'xiaohongshu.com');
}

function getResponseByteLength(data) {
  if (Buffer.isBuffer(data)) return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  return Buffer.byteLength(JSON.stringify(data ?? null), 'utf8');
}

function assertResponseWithinLimit(response, maxBytes) {
  if (getResponseByteLength(response?.data) > maxBytes) {
    throw new SharedLinkError('RESPONSE_TOO_LARGE', `response exceeds ${maxBytes} byte limit`);
  }
}

async function requestPlatformResource(url, options = {}) {
  const platform = String(options.platform || '').trim();
  const request = options.request || axios.get;
  const maxBytes = Math.max(1, Number(options.maxBytes || DEFAULT_MAX_RESPONSE_BYTES) || DEFAULT_MAX_RESPONSE_BYTES);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS) || DEFAULT_REQUEST_TIMEOUT_MS);
  let finalUrl = String(url || '').trim();

  const response = await requestSafeHttpUrl(finalUrl, {
    lookup: options.lookup,
    maxRedirects: Math.max(0, Number(options.maxRedirects ?? 5) || 0),
    request: async (targetUrl, safeOptions) => {
      const parsed = new URL(targetUrl);
      if (!isAllowedPlatformResourceHost(platform, parsed.hostname)) {
        throw new SharedLinkError('DOMAIN_REDIRECT_BLOCKED', 'redirect target is outside the platform allowlist');
      }
      if (options.signal?.aborted) throw new SharedLinkError('TIMEOUT', 'shared link request aborted');
      finalUrl = parsed.href;
      const headers = {
        'User-Agent': String(config.HTTP_USER_AGENT || config.CODEX_USER_AGENT || '').trim() || config.CODEX_USER_AGENT,
        Accept: options.accept || 'application/json,text/html;q=0.9,*/*;q=0.8',
        ...safeOptions.headers,
        ...options.headers
      };
      if (platform === 'xiaohongshu' && options.xhsCookie && isXiaohongshuCookieHost(parsed.hostname)) {
        headers.Cookie = String(options.xhsCookie);
      } else {
        delete headers.Cookie;
        delete headers.cookie;
      }
      const received = await request(parsed.href, {
        ...safeOptions,
        headers,
        responseType: options.responseType,
        timeout: timeoutMs,
        signal: options.signal,
        maxContentLength: maxBytes,
        maxBodyLength: maxBytes,
        proxy: false
      });
      assertResponseWithinLimit(received, maxBytes);
      return received;
    }
  });
  assertResponseWithinLimit(response, maxBytes);
  return { response, finalUrl };
}

async function fetchJson(url, options = {}) {
  const result = await requestPlatformResource(url, {
    ...options,
    accept: 'application/json,text/plain;q=0.9,*/*;q=0.8'
  });
  return { data: result.response?.data, finalUrl: result.finalUrl };
}

async function fetchText(url, options = {}) {
  const result = await requestPlatformResource(url, {
    ...options,
    responseType: 'text',
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
  });
  return { text: String(result.response?.data || ''), response: result.response, finalUrl: result.finalUrl };
}

async function fetchImageDataUrl(url, options = {}) {
  const result = await requestPlatformResource(url, {
    ...options,
    responseType: 'arraybuffer',
    maxBytes: options.maxImageBytes || DEFAULT_MAX_IMAGE_BYTES,
    accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8'
  });
  const contentType = String(result.response?.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!contentType.startsWith('image/')) {
    throw new SharedLinkError('INVALID_IMAGE', 'image response has an invalid content type');
  }
  const buffer = Buffer.from(result.response?.data || []);
  if (!buffer.length) throw new SharedLinkError('INVALID_IMAGE', 'image response is empty');
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

module.exports = {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  fetchImageDataUrl,
  fetchJson,
  fetchText,
  isAllowedPlatformResourceHost,
  isXiaohongshuCookieHost,
  requestPlatformResource
};
