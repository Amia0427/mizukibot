const { z } = require('zod');
const { SharedLinkError, classifySharedLinkError } = require('./errors');
const { parseBilibiliReference } = require('./url');

const pageSchema = z.object({
  cid: z.number(),
  page: z.number(),
  part: z.string().optional(),
  duration: z.number().optional()
}).passthrough();
const statisticsSchema = z.object({
  view: z.number().optional(),
  danmaku: z.number().optional(),
  reply: z.number().optional(),
  favorite: z.number().optional(),
  coin: z.number().optional(),
  share: z.number().optional(),
  like: z.number().optional()
}).passthrough();
const viewResponseSchema = z.object({
  code: z.number(),
  message: z.string().optional(),
  data: z.object({
    aid: z.number().optional(),
    bvid: z.string().optional(),
    title: z.string().optional(),
    desc: z.string().optional(),
    duration: z.number().optional(),
    pic: z.string().optional(),
    owner: z.object({ mid: z.number().optional(), name: z.string().optional() }).passthrough().optional(),
    stat: statisticsSchema.optional(),
    pages: z.array(pageSchema).optional()
  }).passthrough().nullable().optional()
}).passthrough();
const tagsResponseSchema = z.object({
  code: z.number(),
  data: z.array(z.object({ tag_name: z.string().optional() }).passthrough()).optional()
}).passthrough();
const playerResponseSchema = z.object({
  code: z.number(),
  data: z.object({
    subtitle: z.object({
      subtitles: z.array(z.object({
        lan: z.string().optional(),
        lan_doc: z.string().optional(),
        subtitle_url: z.string().optional()
      }).passthrough()).optional()
    }).passthrough().optional()
  }).passthrough().nullable().optional()
}).passthrough();
const subtitleResponseSchema = z.object({
  body: z.array(z.object({ content: z.string() }).passthrough())
}).passthrough();

function normalizeText(value = '') {
  return String(value || '').trim();
}

function validateBilibiliCode(code, message = '') {
  const value = Number(code);
  if (value === 0) return;
  if (value === -404) throw new SharedLinkError('NOT_FOUND', 'B站视频不存在或已删除');
  if (value === -403 || value === 62002) throw new SharedLinkError('PRIVATE_CONTENT', 'B站视频不可公开访问');
  if (value === -412) throw new SharedLinkError('RISK_CONTROLLED', 'B站请求触发风控');
  if (value === -509 || value === 429) throw new SharedLinkError('RATE_LIMITED', 'B站请求过于频繁');
  throw new SharedLinkError('INVALID_RESPONSE', normalizeText(message) || `B站接口返回异常状态 ${value}`);
}

async function readOptional(task) {
  try {
    return { ok: true, value: await task() };
  } catch (error) {
    return { ok: false, error: classifySharedLinkError(error) };
  }
}

function buildViewEndpoint(reference) {
  const query = reference.bvid ? `bvid=${encodeURIComponent(reference.bvid)}` : `aid=${encodeURIComponent(reference.aid)}`;
  return `https://api.bilibili.com/x/web-interface/view?${query}`;
}

function normalizeSubtitleUrl(value = '') {
  const url = normalizeText(value);
  if (url.startsWith('//')) return `https:${url}`;
  return url;
}

function normalizeStatistics(statistics = {}) {
  return Object.fromEntries([
    'view',
    'danmaku',
    'reply',
    'favorite',
    'coin',
    'share',
    'like'
  ].map((key) => [key, Number(statistics[key] || 0) || 0]));
}

const bilibiliParser = {
  supports(url) {
    return Boolean(parseBilibiliReference(url));
  },
  async read(context) {
    const reference = parseBilibiliReference(context.url);
    if (!reference) throw new SharedLinkError('UNSUPPORTED_URL', '不支持的B站链接');
    const view = viewResponseSchema.parse(await context.fetchJson(buildViewEndpoint(reference)));
    validateBilibiliCode(view.code, view.message);
    if (!view.data) throw new SharedLinkError('NOT_FOUND', 'B站视频不存在');

    const pages = (view.data.pages || []).map((page) => ({
      cid: page.cid,
      page: page.page,
      title: normalizeText(page.part),
      durationSeconds: Math.max(0, Number(page.duration || 0) || 0)
    }));
    const selectedPart = pages.find((page) => page.page === reference.page) || pages[0] || null;
    const query = view.data.bvid
      ? `bvid=${encodeURIComponent(view.data.bvid)}`
      : `aid=${encodeURIComponent(view.data.aid || reference.aid)}`;
    const tagsResult = await readOptional(async () => {
      const parsed = tagsResponseSchema.parse(await context.fetchJson(`https://api.bilibili.com/x/tag/archive/tags?${query}`));
      validateBilibiliCode(parsed.code);
      return (parsed.data || []).map((item) => normalizeText(item.tag_name)).filter(Boolean);
    });
    const playerResult = selectedPart
      ? await readOptional(async () => {
        const parsed = playerResponseSchema.parse(await context.fetchJson(`https://api.bilibili.com/x/player/v2?${query}&cid=${selectedPart.cid}`));
        validateBilibiliCode(parsed.code);
        return parsed.data?.subtitle?.subtitles || [];
      })
      : { ok: true, value: [] };

    let subtitleText = '';
    if (playerResult.ok && playerResult.value.length > 0) {
      const subtitleUrl = normalizeSubtitleUrl(playerResult.value[0].subtitle_url);
      if (subtitleUrl) {
        const subtitleResult = await readOptional(async () => {
          const parsed = subtitleResponseSchema.parse(await context.fetchJson(subtitleUrl));
          return parsed.body.map((item) => normalizeText(item.content)).filter(Boolean).join('\n').slice(0, 8000);
        });
        if (subtitleResult.ok) subtitleText = subtitleResult.value;
      }
    }

    const bvid = normalizeText(view.data.bvid || reference.bvid);
    const canonical = `https://www.bilibili.com/video/${bvid || `av${view.data.aid || reference.aid}`}`;
    const canonicalUrl = reference.page > 1 ? `${canonical}?p=${reference.page}` : canonical;
    return {
      platform: 'bilibili',
      contentType: 'video',
      canonicalUrl,
      title: normalizeText(view.data.title),
      author: normalizeText(view.data.owner?.name),
      body: [normalizeText(view.data.desc), subtitleText ? `字幕摘录：\n${subtitleText}` : ''].filter(Boolean).join('\n\n'),
      tags: tagsResult.ok ? tagsResult.value : [],
      media: {
        coverUrl: normalizeText(view.data.pic),
        durationSeconds: Math.max(0, Number(view.data.duration || 0) || 0),
        parts: pages,
        selectedPart,
        statistics: normalizeStatistics(view.data.stat),
        subtitle: subtitleText,
        subtitleAvailable: Boolean(subtitleText)
      },
      imageUnderstanding: [],
      completeness: subtitleText ? 'complete' : 'partial',
      failureCode: subtitleText ? '' : 'SUBTITLE_UNAVAILABLE'
    };
  }
};

module.exports = {
  bilibiliParser,
  normalizeSubtitleUrl
};
