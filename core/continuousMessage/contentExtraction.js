const config = require('../../config');

const URL_KEY_HINTS = new Set(['jumpurl', 'qqdocurl', 'url', 'musicurl']);
const KNOWN_CARD_PLATFORM_LABELS = Object.freeze({
  bilibili: 'B站',
  xhs: '小红书',
  xiaoheihe: '小黑盒',
  tieba: '百度贴吧',
  nga: 'NGA',
  ncm: '网易云音乐',
  zhihu: '知乎'
});

function normalizeText(value) {
  return String(value || '').trim();
}

function safeJsonParse(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return value;
  }
}

function normalizeUrl(value) {
  const raw = normalizeText(value);
  if (!raw) return '';
  if (raw.startsWith('//')) return `https:${raw}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(raw)) return `https://${raw}`;
  return '';
}

function identifyCardPlatform(url = '') {
  try {
    const parsed = new URL(url);
    const host = String(parsed.hostname || '').toLowerCase();
    const path = String(parsed.pathname || '');
    if (['www.bilibili.com', 'bilibili.com', 'm.bilibili.com', 'b23.tv', 'bili2233.cn'].includes(host)) return 'bilibili';
    if (['www.xiaohongshu.com', 'xiaohongshu.com', 'xhschlink.com'].includes(host)) return 'xhs';
    if (['api.xiaoheihe.cn', 'www.xiaoheihe.cn', 'xiaoheihe.cn'].includes(host)) return 'xiaoheihe';
    if (['tieba.baidu.com', 'www.tieba.baidu.com'].includes(host) && /^\/p\/\d+/i.test(path)) return 'tieba';
    if (['ngabbs.com', 'nga.178.com', 'bbs.nga.cn'].includes(host)) return 'nga';
    if (['music.163.com', 'y.music.163.com', '163cn.tv'].includes(host)) return 'ncm';
    if (['www.zhihu.com', 'zhihu.com', 'zhuanlan.zhihu.com'].includes(host)) return 'zhihu';
  } catch (_) {}
  return '';
}

function canonicalizeKnownShareUrl(url = '') {
  try {
    const parsed = new URL(url);
    const host = String(parsed.hostname || '').toLowerCase();
    const path = String(parsed.pathname || '');
    const query = parsed.searchParams;

    if (host === 'api.xiaoheihe.cn' && path === '/v3/bbs/app/api/web/share') {
      const linkId = normalizeText(query.get('link_id'));
      if (linkId) return `https://www.xiaoheihe.cn/app/bbs/link/${linkId}`;
    }

    if (host === 'api.xiaoheihe.cn' && path === '/game/share_game_detail') {
      const appId = normalizeText(query.get('appid'));
      const gameType = normalizeText(query.get('game_type')).toLowerCase() || 'pc';
      if (appId) return `https://www.xiaoheihe.cn/app/topic/game/${gameType}/${appId}`;
    }

    if (['tieba.baidu.com', 'www.tieba.baidu.com'].includes(host)) {
      const matched = path.match(/^\/p\/(\d+)/i);
      if (matched) return `https://tieba.baidu.com/p/${matched[1]}`;
    }

    if (['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(host)) {
      const matched = path.match(/^\/(?:video\/)?(?<videoId>BV[0-9A-Za-z]{10}|av\d+)/i);
      if (matched?.groups?.videoId) {
        const pageNum = normalizeText(query.get('p'));
        const canonical = `https://www.bilibili.com/video/${matched.groups.videoId}`;
        return /^\d+$/.test(pageNum) && Number(pageNum) > 1 ? `${canonical}?p=${pageNum}` : canonical;
      }
    }

    if (['www.xiaohongshu.com', 'xiaohongshu.com'].includes(host)) {
      const matched = path.match(/^\/(?:discovery\/item|explore)\/([0-9A-Za-z]+)/i);
      if (matched?.[1]) {
        const queryText = parsed.searchParams.toString();
        return queryText
          ? `https://www.xiaohongshu.com/discovery/item/${matched[1]}?${queryText}`
          : `https://www.xiaohongshu.com/discovery/item/${matched[1]}`;
      }
    }

    if (['ngabbs.com', 'nga.178.com', 'bbs.nga.cn'].includes(host) && path === '/read.php') {
      const tid = normalizeText(query.get('tid'));
      if (/^\d+$/.test(tid)) return `https://ngabbs.com/read.php?tid=${tid}`;
    }

    if (host === 'y.music.163.com' && path === '/m/song') {
      const songId = normalizeText(query.get('id'));
      if (/^\d+$/.test(songId)) return `https://music.163.com/#/song?id=${songId}`;
    }

    if (host === 'zhuanlan.zhihu.com') {
      const matched = path.match(/^\/p\/(\d+)/i);
      if (matched?.[1]) return `https://zhuanlan.zhihu.com/p/${matched[1]}`;
    }

    if (['www.zhihu.com', 'zhihu.com'].includes(host)) {
      const answerMatched = path.match(/^\/question\/(\d+)\/answer\/(\d+)/i);
      if (answerMatched) return `https://www.zhihu.com/question/${answerMatched[1]}/answer/${answerMatched[2]}`;
      const questionMatched = path.match(/^\/question\/(\d+)/i);
      if (questionMatched) return `https://www.zhihu.com/question/${questionMatched[1]}`;
    }
  } catch (_) {
    return url;
  }
  return url;
}

function appendPromptLine(prompt, url) {
  const cleanPrompt = normalizeText(prompt);
  return cleanPrompt ? `${cleanPrompt} ${url}` : url;
}

function uniqueStrings(items = []) {
  const output = [];
  const seen = new Set();
  for (const item of items) {
    const text = normalizeText(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
  }
  return output;
}

function decodeCqValue(value = '') {
  return String(value || '')
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&');
}

function parseCqSegmentAttributes(segmentText = '') {
  const attrs = {};
  for (const chunk of String(segmentText || '').split(',')) {
    const eqIndex = chunk.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = normalizeText(chunk.slice(0, eqIndex)).toLowerCase();
    if (!key) continue;
    attrs[key] = decodeCqValue(chunk.slice(eqIndex + 1));
  }
  return attrs;
}

function logExtractedCardLinks(urls = []) {
  if (!Array.isArray(urls) || !urls.length) return;
  console.log('[continuous-message] qq card links extracted', {
    count: urls.length,
    platforms: urls
      .map((url) => identifyCardPlatform(url))
      .filter(Boolean)
      .map((key) => KNOWN_CARD_PLATFORM_LABELS[key] || key)
  });
}

function appendCardUrlsToText(text = '', urls = [], options = {}) {
  const qqCardLinksEnabled = options.qqCardLinksEnabled ?? config.CONTINUOUS_MESSAGE_QQ_CARD_LINKS_ENABLED;
  const baseText = normalizeText(text);
  const normalizedUrls = qqCardLinksEnabled ? uniqueStrings(urls) : [];
  if (!normalizedUrls.length) return baseText;
  logExtractedCardLinks(normalizedUrls);
  return [baseText, ...normalizedUrls.map((url) => appendPromptLine('[分享链接]', url))]
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractUrlsFromJsonPayload(payload) {
  const parsedPayload = safeJsonParse(payload);
  const extracted = [];

  function walk(node) {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      const keyLower = String(key || '').toLowerCase();
      if (URL_KEY_HINTS.has(keyLower) && typeof value === 'string') {
        const normalized = normalizeUrl(value);
        if (normalized) {
          const canonical = canonicalizeKnownShareUrl(normalized);
          extracted.push(canonical || normalized);
        }
      }
      walk(safeJsonParse(value));
    }
  }

  walk(parsedPayload);
  return uniqueStrings(extracted);
}

function extractUrlsFromRawJsonSegments(rawText = '') {
  const extracted = [];
  const source = String(rawText || '');
  const regex = /\[CQ:json,([^\]]+)\]/gi;
  let match = regex.exec(source);
  while (match) {
    const attrs = parseCqSegmentAttributes(match[1]);
    const payload = attrs.data || attrs.content || '';
    if (payload) {
      extracted.push(...extractUrlsFromJsonPayload(payload));
    }
    match = regex.exec(source);
  }
  return uniqueStrings(extracted);
}

function normalizeMessageArray(message) {
  if (Array.isArray(message)) return message;
  if (typeof message === 'string' && message.trim()) {
    return [{ type: 'text', data: { text: message } }];
  }
  return [];
}

function segmentTypeName(segment = {}) {
  if (!segment) return '';
  if (typeof segment.type === 'string') return segment.type;
  if (segment?.constructor?.name) return String(segment.constructor.name).toLowerCase();
  return '';
}

function segmentData(segment = {}) {
  if (!segment || typeof segment !== 'object') return {};
  if (segment.data && typeof segment.data === 'object') return segment.data;
  return segment;
}

function extractTextAndImagesFromMessage(message = []) {
  const textParts = [];
  const imageUrls = [];
  const forwardIds = [];
  let replyMessageId = '';

  for (const segment of normalizeMessageArray(message)) {
    const type = segmentTypeName(segment);
    const data = segmentData(segment);

    if (type === 'reply') {
      replyMessageId = normalizeText(data.id || data.message_id || replyMessageId);
      continue;
    }

    if (type === 'forward') {
      const forwardId = normalizeText(data.id);
      if (forwardId) forwardIds.push(forwardId);
      continue;
    }

    if (type === 'text') {
      const text = normalizeText(data.text || data.content || '');
      if (text) textParts.push(text);
      continue;
    }

    if (type === 'json') {
      const payload = data.data || data.content || '';
      const urls = extractUrlsFromJsonPayload(payload);
      if (urls.length) {
        logExtractedCardLinks(urls);
        for (const url of urls) {
          textParts.push(appendPromptLine('[分享链接]', url));
        }
      }
      continue;
    }

    if (type === 'image') {
      const url = normalizeText(data.url || data.file || '');
      if (url) {
        imageUrls.push(url);
        textParts.push('[图片]');
      }
      continue;
    }
  }

  return {
    text: textParts.join('\n').trim(),
    imageUrls,
    forwardIds,
    replyMessageId
  };
}

function collectMessageContent(message = [], options = {}) {
  const qqCardLinksEnabled = options.qqCardLinksEnabled ?? config.CONTINUOUS_MESSAGE_QQ_CARD_LINKS_ENABLED;
  const textParts = [];
  const imageUrls = [];
  const forwardIds = [];
  const qqCardUrls = [];
  const seenCardUrls = new Set();
  let replyMessageId = '';

  for (const segment of normalizeMessageArray(message)) {
    const type = segmentTypeName(segment);
    const data = segmentData(segment);

    if (type === 'reply') {
      replyMessageId = normalizeText(data.id || data.message_id || replyMessageId);
      continue;
    }

    if (type === 'forward') {
      const forwardId = normalizeText(data.id);
      if (forwardId) forwardIds.push(forwardId);
      continue;
    }

    if (type === 'text') {
      const text = normalizeText(data.text || data.content || '');
      if (text) textParts.push(text);
      continue;
    }

    if (type === 'json') {
      if (!qqCardLinksEnabled) continue;
      const payload = data.data || data.content || '';
      for (const url of extractUrlsFromJsonPayload(payload)) {
        if (!url || seenCardUrls.has(url)) continue;
        seenCardUrls.add(url);
        qqCardUrls.push(url);
      }
      continue;
    }

    if (type === 'image') {
      const url = normalizeText(data.url || data.file || '');
      if (url) {
        imageUrls.push(url);
        textParts.push('[图片]');
      }
    }
  }

  return {
    text: textParts.join('\n').trim(),
    imageUrls,
    forwardIds,
    qqCardUrls,
    replyMessageId
  };
}

function stripCqControlSegments(rawText = '') {
  return String(rawText || '')
    .replace(/\[CQ:reply,[^\]]*\]/gi, ' ')
    .replace(/\[CQ:at,[^\]]*\]/gi, ' ')
    .replace(/\[CQ:image,[^\]]*\]/gi, ' ')
    .replace(/\[CQ:json,[^\]]*\]/gi, ' ')
    .replace(/\[CQ:forward,[^\]]*\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRawReplyId(rawText = '') {
  const matched = String(rawText || '').match(/\[CQ:reply,[^\]]*id=([^,\]]+)/i);
  return normalizeText(matched?.[1] || '');
}

function parseRawForwardIds(rawText = '') {
  const ids = [];
  const regex = /\[CQ:forward,[^\]]*id=([^,\]]+)/gi;
  let match = regex.exec(String(rawText || ''));
  while (match) {
    const value = normalizeText(match[1] || '');
    if (value) ids.push(value);
    match = regex.exec(String(rawText || ''));
  }
  return ids;
}

function parseRawImageUrls(rawText = '') {
  const urls = [];
  const regex = /\[CQ:image,[^\]]*(?:url|file)=([^,\]]+)/gi;
  let match = regex.exec(String(rawText || ''));
  while (match) {
    const value = normalizeText(String(match[1] || '').replace(/&amp;/g, '&'));
    if (value) urls.push(value);
    match = regex.exec(String(rawText || ''));
  }
  return urls;
}

function senderNameFromMessage(msg = {}) {
  return normalizeText(
    msg?.card
      || msg?.nickname
      || msg?.nick
      || msg?.name
      || msg?.sender?.card
      || msg?.sender?.nickname
      || msg?.sender?.nick
      || msg?.sender_name
      || msg?.user_id
      || 'unknown'
  );
}

function senderIdFromMessage(msg = {}) {
  return normalizeText(
    msg?.user_id
      || msg?.sender?.user_id
      || msg?.sender?.userId
      || msg?.sender_id
      || msg?.senderId
      || ''
  );
}

module.exports = {
  appendCardUrlsToText,
  appendPromptLine,
  canonicalizeKnownShareUrl,
  collectMessageContent,
  extractTextAndImagesFromMessage,
  extractUrlsFromJsonPayload,
  extractUrlsFromRawJsonSegments,
  identifyCardPlatform,
  normalizeText,
  safeJsonParse,
  segmentData,
  segmentTypeName,
  parseRawForwardIds,
  parseRawImageUrls,
  parseRawReplyId,
  senderIdFromMessage,
  senderNameFromMessage,
  stripCqControlSegments,
  uniqueStrings
};
