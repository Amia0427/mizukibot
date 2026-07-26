const cheerio = require('cheerio');
const { SharedLinkError } = require('./errors');
const { isAllowedPlatformResourceHost } = require('./http');
const { parseXiaohongshuReference } = require('./url');

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : (value ? [value] : []);
}

function collectJsonLdNodes(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectJsonLdNodes(item, output));
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  output.push(value);
  if (Array.isArray(value['@graph'])) collectJsonLdNodes(value['@graph'], output);
  return output;
}

function parseJsonLd($) {
  const nodes = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    const text = $(element).text().trim();
    if (!text) return;
    try {
      collectJsonLdNodes(JSON.parse(text), nodes);
    } catch (_) {}
  });
  return nodes.find((node) => (
    normalizeText(node?.headline || node?.name || node?.description)
  )) || {};
}

function normalizeAuthor(value) {
  if (typeof value === 'string') return normalizeText(value);
  if (Array.isArray(value)) return value.map(normalizeAuthor).filter(Boolean).join(' / ');
  return normalizeText(value?.name);
}

function normalizeKeywords(value) {
  if (Array.isArray(value)) return value.map(normalizeText).filter(Boolean);
  return normalizeText(value).split(/[,，、]/).map(normalizeText).filter(Boolean);
}

function safeImageUrl(value = '') {
  const url = normalizeText(value);
  if (!url) return '';
  try {
    const parsed = new URL(url.startsWith('//') ? `https:${url}` : url);
    return isAllowedPlatformResourceHost('xiaohongshu', parsed.hostname) ? parsed.href : '';
  } catch (_) {
    return '';
  }
}

function parseXiaohongshuHtml(html = '') {
  const $ = cheerio.load(String(html || ''));
  const jsonLd = parseJsonLd($);
  const title = normalizeText(
    $('meta[property="og:title"]').attr('content')
      || jsonLd.headline
      || jsonLd.name
      || $('title').text()
  );
  const body = normalizeText(
    $('meta[property="og:description"]').attr('content')
      || jsonLd.description
      || $('meta[name="description"]').attr('content')
  );
  const author = normalizeText(
    $('meta[name="author"]').attr('content')
      || $('meta[property="article:author"]').attr('content')
      || normalizeAuthor(jsonLd.author)
  );
  const imageUrls = [];
  $('meta[property="og:image"]').each((_, element) => imageUrls.push($(element).attr('content')));
  imageUrls.push(...asArray(jsonLd.image).map((item) => (typeof item === 'string' ? item : item?.url)));
  const images = Array.from(new Set(imageUrls.map(safeImageUrl).filter(Boolean)));
  const hashtagMatches = body.match(/#[^#\s，。！？；、]+/g) || [];
  const tags = Array.from(new Set([
    ...normalizeKeywords(jsonLd.keywords),
    ...hashtagMatches.map((tag) => tag.slice(1))
  ].map(normalizeText).filter(Boolean)));
  return { title, author, body, tags, images };
}

function detectUnavailableState(html = '') {
  const text = normalizeText(html).toLowerCase();
  if (/笔记已删除|内容已删除|页面不存在|note not found/.test(text)) return 'NOT_FOUND';
  if (/仅自己可见|私密笔记|无权限查看|private note/.test(text)) return 'PRIVATE_CONTENT';
  if (/访问频繁|安全验证|异常访问|风险验证|captcha/.test(text)) return 'RISK_CONTROLLED';
  return '';
}

async function buildImageUnderstanding(context, images) {
  if (!context.visionEnabled || images.length === 0) return [];
  const prepared = await Promise.allSettled(images.slice(0, 3).map(async (url, index) => ({
    url: await context.fetchImageDataUrl(url),
    source: 'current',
    label: `小红书公开图片 ${index + 1}`
  })));
  const visionImages = prepared.filter((item) => item.status === 'fulfilled').map((item) => item.value);
  if (!visionImages.length) return [];
  const result = await context.visionRunner({
    enabled: true,
    timeoutMs: context.visionTimeoutMs,
    images: visionImages,
    originalUserText: context.userText
  });
  if (!result?.ok) return [];
  const captions = result.visualContext?.captionJson?.images || [];
  return captions.slice(0, visionImages.length).map((caption, index) => ({
    imageIndex: index,
    summary: normalizeText(caption?.global_description || caption?.focus_subject)
  }));
}

const xiaohongshuParser = {
  supports(url) {
    return Boolean(parseXiaohongshuReference(url));
  },
  async read(context) {
    const reference = parseXiaohongshuReference(context.url);
    if (!reference) throw new SharedLinkError('UNSUPPORTED_URL', '不支持的小红书链接');
    const html = context.initialText !== undefined
      ? context.initialText
      : await context.fetchText(context.url);
    const unavailable = detectUnavailableState(html);
    if (unavailable) throw new SharedLinkError(unavailable, '小红书笔记不可公开访问');
    const parsed = parseXiaohongshuHtml(html);
    if (!parsed.title && !parsed.body) {
      throw new SharedLinkError('INVALID_RESPONSE', '小红书页面未包含可读取的公开内容');
    }
    const imageUnderstanding = await buildImageUnderstanding(context, parsed.images);
    const visionUnavailable = parsed.images.length > 0 && imageUnderstanding.length === 0;
    return {
      platform: 'xiaohongshu',
      contentType: 'note',
      canonicalUrl: context.canonicalUrl,
      title: parsed.title,
      author: parsed.author,
      body: parsed.body,
      tags: parsed.tags,
      media: {
        images: parsed.images.map((url) => ({ url }))
      },
      imageUnderstanding,
      completeness: visionUnavailable ? 'partial' : 'complete',
      failureCode: visionUnavailable ? 'VISION_UNAVAILABLE' : ''
    };
  }
};

module.exports = {
  detectUnavailableState,
  parseXiaohongshuHtml,
  xiaohongshuParser
};
