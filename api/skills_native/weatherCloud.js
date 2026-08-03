const axios = require('axios');
const cheerio = require('cheerio');
const sharp = require('sharp');
const config = require('../../config');
const { normalizeWeatherCloudArgs } = require('../../utils/toolPolicy/skillArgs');
const { sendImageMessageForContext } = require('../qqActionService');

const NSMC_IMAGE_BASE_URL = 'https://img.nsmc.org.cn';
const NSMC_PAGE_BASE_URL = 'https://www.nsmc.org.cn/nsmc/cn/image/index.html?id=';
const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_SEND_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_SEND_IMAGE_EDGE = 2048;
const PRODUCTS = Object.freeze({
  china: Object.freeze({
    label: '中国区域',
    channels: Object.freeze({
      infrared: Object.freeze({
        label: '红外',
        pageId: 'FY4B_AGRI_IMG_REGI_GRA_GLL_C13',
        feedUrl: `${NSMC_IMAGE_BASE_URL}/PORTAL/NSMC/XML/FY4B/FY4B_AGRI_IMG_REGI_GRA_GLL_C13.xml`
      }),
      visible: Object.freeze({
        label: '可见光真彩',
        pageId: 'FY4B_AGRI_IMG_REGI_GCLR_GLL',
        feedUrl: `${NSMC_IMAGE_BASE_URL}/CLOUDIMAGE/FY4B/AGRI/GCLR/SEC/xml/FY4B-china-72h.xml`,
        preferThumbnail: true
      }),
      water_vapor: Object.freeze({
        label: '水汽',
        pageId: 'FY4B_AGRI_IMG_REGI_GRA_GLL_C09',
        feedUrl: `${NSMC_IMAGE_BASE_URL}/PORTAL/NSMC/XML/FY4B/FY4B_AGRI_IMG_REGI_GRA_GLL_C09.xml`
      })
    })
  }),
  full_disk: Object.freeze({
    label: '全圆盘',
    channels: Object.freeze({
      infrared: Object.freeze({
        label: '红外增强',
        pageId: 'FY4B_AGRI_IMG_DISK_THEMG_C13',
        feedUrl: `${NSMC_IMAGE_BASE_URL}/PORTAL/NSMC/XML/FY4B/FY4B_AGRI_IMG_DISK_THEMG_C13.xml`
      }),
      visible: Object.freeze({
        label: '可见光真彩',
        pageId: 'FY4B_AGRI_IMG_DISK_GCLR_NOM',
        feedUrl: `${NSMC_IMAGE_BASE_URL}/PORTAL/NSMC/XML/FY4B/FY4B_AGRI_IMG_DISK_GCLR_NOM.xml`
      }),
      water_vapor: Object.freeze({
        label: '水汽增强',
        pageId: 'FY4B_AGRI_IMG_DISK_THEMG_C09',
        feedUrl: `${NSMC_IMAGE_BASE_URL}/PORTAL/NSMC/XML/FY4B/FY4B_AGRI_IMG_DISK_THEMG_C09.xml`
      })
    })
  })
});

function formatDateTime(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

function parseObservationTime(value = '') {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) \(UTC\)$/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5])));
}

function normalizeImageUrl(value = '') {
  const url = String(value || '').trim();
  if (url.startsWith('//')) return `https:${url}`;
  return url;
}

function extractObservationSlots(xml = '', preferThumbnail = false) {
  const $ = cheerio.load(String(xml || ''), { xmlMode: true });
  const byTime = new Map();
  $('image').each((_, element) => {
    const observedAt = parseObservationTime($(element).attr('time'));
    const imageUrl = normalizeImageUrl($(element).attr('url'));
    if (!observedAt || !imageUrl.startsWith(`${NSMC_IMAGE_BASE_URL}/`)) return;
    const key = observedAt.toISOString();
    const slot = byTime.get(key) || { observedAt, urls: [] };
    if (!slot.urls.includes(imageUrl)) slot.urls.push(imageUrl);
    byTime.set(key, slot);
  });

  return [...byTime.values()]
    .map((slot) => {
      const originalUrl = slot.urls.find((url) => !url.includes('-thumb.JPG')) || slot.urls[0];
      const thumbnailUrl = preferThumbnail ? slot.urls.find((url) => url.includes('-thumb.JPG')) : null;
      return {
        observedAt: slot.observedAt,
        originalUrl,
        downloadUrls: thumbnailUrl ? [thumbnailUrl, originalUrl] : [originalUrl]
      };
    })
    .sort((left, right) => right.observedAt.getTime() - left.observedAt.getTime());
}

function getContentType(headers = {}) {
  if (typeof headers?.get === 'function') return String(headers.get('content-type') || '').toLowerCase();
  return String(headers?.['content-type'] || headers?.['Content-Type'] || '').toLowerCase();
}

function isJpeg(buffer) {
  return buffer.length >= 4
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer[buffer.length - 2] === 0xff
    && buffer[buffer.length - 1] === 0xd9;
}

async function prepareImage(buffer) {
  const metadata = await sharp(buffer).metadata();
  if (metadata.format !== 'jpeg' || !metadata.width || !metadata.height) {
    throw new Error('NSMC cloud image content is not JPEG');
  }

  let output = buffer;
  if (Math.max(metadata.width, metadata.height) > 4096 || buffer.length > MAX_SEND_IMAGE_BYTES) {
    output = await sharp(buffer)
      .rotate()
      .resize({
        width: MAX_SEND_IMAGE_EDGE,
        height: MAX_SEND_IMAGE_EDGE,
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
  }
  if (output.length > MAX_SEND_IMAGE_BYTES) throw new Error('NSMC cloud image size is invalid');
  return output;
}

async function downloadSlotImage(httpClient, slot, requestOptions) {
  for (const imageUrl of slot.downloadUrls) {
    try {
      const response = await httpClient.get(imageUrl, requestOptions);
      const contentType = getContentType(response?.headers);
      if (!contentType.startsWith('image/jpeg')) throw new Error('NSMC cloud image response is not JPEG');
      const buffer = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data || []);
      if (buffer.length > MAX_SOURCE_IMAGE_BYTES || !isJpeg(buffer)) {
        throw new Error('NSMC cloud image content is not JPEG');
      }
      return await prepareImage(buffer);
    } catch (error) {
      const isLastUrl = imageUrl === slot.downloadUrls[slot.downloadUrls.length - 1];
      if (Number(error?.response?.status) === 404 && !isLastUrl) continue;
      throw error;
    }
  }
  throw new Error('NSMC cloud image is unavailable');
}

async function fetchLatestImage(httpClient, slots, requestOptions) {
  const candidates = slots.slice(0, 2);
  for (let index = 0; index < candidates.length; index += 1) {
    try {
      const buffer = await downloadSlotImage(httpClient, candidates[index], requestOptions);
      return { buffer, slot: candidates[index] };
    } catch (error) {
      if (index === 0 && Number(error?.response?.status) === 404 && candidates.length > 1) continue;
      throw error;
    }
  }
  throw new Error('NSMC cloud image is unavailable');
}

async function sendLatestWeatherCloud(rawArgs = {}, deps = {}) {
  const args = normalizeWeatherCloudArgs(rawArgs);
  const area = PRODUCTS[args.area];
  const channel = area.channels[args.channel];
  const httpClient = deps.httpClient || axios;
  const sendImage = deps.sendImageMessageForContext || sendImageMessageForContext;
  const headers = {
    Accept: 'image/jpeg, application/xml;q=0.9',
    Referer: `${NSMC_PAGE_BASE_URL}${channel.pageId}`,
    'User-Agent': config.HTTP_USER_AGENT
  };
  const feedResponse = await httpClient.get(channel.feedUrl, {
    timeout: 10000,
    proxy: false,
    headers
  });
  const slots = extractObservationSlots(feedResponse?.data, channel.preferThumbnail === true);
  if (slots.length === 0) throw new Error('NSMC cloud observation time is unavailable');

  const image = await fetchLatestImage(httpClient, slots, {
    responseType: 'arraybuffer',
    timeout: 30000,
    proxy: false,
    maxContentLength: MAX_SOURCE_IMAGE_BYTES,
    maxBodyLength: MAX_SOURCE_IMAGE_BYTES,
    headers
  });
  const context = rawArgs.__context && typeof rawArgs.__context === 'object' ? rawArgs.__context : {};
  const evidence = {
    status: 'sent',
    area: args.area,
    area_label: area.label,
    channel: args.channel,
    channel_label: channel.label,
    satellite: 'FY-4B',
    instrument: 'AGRI',
    observed_at_utc: image.slot.observedAt.toISOString(),
    observed_at_beijing: formatDateTime(image.slot.observedAt, 'Asia/Shanghai'),
    image_url: image.slot.originalUrl,
    source_url: `${NSMC_PAGE_BASE_URL}${channel.pageId}`,
    source: '国家卫星气象中心 FY-4B AGRI'
  };

  try {
    const sent = await sendImage(context, image.buffer, deps.sendOptions || {});
    return JSON.stringify({ ...evidence, message_id: sent?.messageId ?? null });
  } catch (_) {
    return JSON.stringify({ ...evidence, status: 'send_failed', message_id: null });
  }
}

module.exports = {
  MAX_SEND_IMAGE_BYTES,
  MAX_SOURCE_IMAGE_BYTES,
  PRODUCTS,
  extractObservationSlots,
  parseObservationTime,
  sendLatestWeatherCloud
};
