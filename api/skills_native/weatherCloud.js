const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../../config');
const { normalizeWeatherCloudArgs } = require('../../utils/toolPolicy/skillArgs');
const { sendImageMessageForContext } = require('../qqActionService');

const JMA_PAGE_URL = 'https://www.data.jma.go.jp/mscweb/data/himawari/sat_img.php?area=fd_';
const JMA_IMAGE_BASE_URL = 'https://www.data.jma.go.jp/mscweb/data/himawari/img/fd_';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const CHANNELS = Object.freeze({
  infrared: Object.freeze({ code: 'b13', label: '红外' }),
  visible: Object.freeze({ code: 'b03', label: '可见光' }),
  water_vapor: Object.freeze({ code: 'b08', label: '水汽' })
});
const MONTHS = Object.freeze({
  January: 0,
  February: 1,
  March: 2,
  April: 3,
  May: 4,
  June: 5,
  July: 6,
  August: 7,
  September: 8,
  October: 9,
  November: 10,
  December: 11
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

function parseObservationTime(label = '') {
  const match = String(label || '').trim().match(/^(\d{2}):(\d{2}) UTC (\d{2}) ([A-Za-z]+) (\d{4})$/);
  if (!match || !Object.prototype.hasOwnProperty.call(MONTHS, match[4])) return null;
  return new Date(Date.UTC(Number(match[5]), MONTHS[match[4]], Number(match[3]), Number(match[1]), Number(match[2])));
}

function extractObservationSlots(html = '') {
  const $ = cheerio.load(String(html || ''));
  return $('select[name="slt_time"] option').toArray().map((option) => {
    const token = String($(option).attr('value') || '').trim();
    const label = $(option).text().trim();
    const observedAt = parseObservationTime(label);
    return /^\d{4}$/.test(token) && observedAt ? { token, label, observedAt } : null;
  }).filter(Boolean);
}

function buildImageUrl(channelCode, token) {
  return `${JMA_IMAGE_BASE_URL}/fd__${channelCode}_${token}.jpg`;
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

async function fetchLatestImage(httpClient, slots, channel) {
  const candidates = slots.slice(0, 2);
  for (let index = 0; index < candidates.length; index += 1) {
    const slot = candidates[index];
    const imageUrl = buildImageUrl(channel.code, slot.token);
    try {
      const response = await httpClient.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 10000,
        proxy: false,
        maxContentLength: MAX_IMAGE_BYTES,
        maxBodyLength: MAX_IMAGE_BYTES,
        headers: {
          Accept: 'image/jpeg',
          Referer: JMA_PAGE_URL,
          'User-Agent': config.HTTP_USER_AGENT
        }
      });
      const contentType = getContentType(response?.headers);
      if (!contentType.startsWith('image/jpeg')) throw new Error('JMA cloud image response is not JPEG');
      const buffer = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data || []);
      if (!isJpeg(buffer)) throw new Error('JMA cloud image content is not JPEG');
      if (buffer.length > MAX_IMAGE_BYTES) throw new Error('JMA cloud image size is invalid');
      return { buffer, imageUrl, slot };
    } catch (error) {
      if (index === 0 && Number(error?.response?.status) === 404 && candidates.length > 1) continue;
      throw error;
    }
  }
  throw new Error('JMA cloud image is unavailable');
}

async function sendLatestWeatherCloud(rawArgs = {}, deps = {}) {
  const args = normalizeWeatherCloudArgs(rawArgs);
  const channel = CHANNELS[args.channel];
  const httpClient = deps.httpClient || axios;
  const sendImage = deps.sendImageMessageForContext || sendImageMessageForContext;
  const pageResponse = await httpClient.get(JMA_PAGE_URL, {
    timeout: 10000,
    proxy: false,
    headers: {
      Accept: 'text/html',
      'User-Agent': config.HTTP_USER_AGENT
    }
  });
  const slots = extractObservationSlots(pageResponse?.data);
  if (slots.length === 0) throw new Error('JMA cloud observation time is unavailable');

  const image = await fetchLatestImage(httpClient, slots, channel);
  const context = rawArgs.__context && typeof rawArgs.__context === 'object' ? rawArgs.__context : {};
  const evidence = {
    status: 'sent',
    channel: args.channel,
    channel_label: channel.label,
    area: 'Himawari Full Disk',
    observed_at_utc: image.slot.observedAt.toISOString(),
    observed_at_beijing: formatDateTime(image.slot.observedAt, 'Asia/Shanghai'),
    image_url: image.imageUrl,
    source_url: JMA_PAGE_URL,
    source: 'JMA Himawari Real-Time Image'
  };

  try {
    const sent = await sendImage(context, image.buffer, deps.sendOptions || {});
    return JSON.stringify({ ...evidence, message_id: sent?.messageId ?? null });
  } catch (_) {
    return JSON.stringify({ ...evidence, status: 'send_failed', message_id: null });
  }
}

module.exports = {
  CHANNELS,
  JMA_PAGE_URL,
  buildImageUrl,
  extractObservationSlots,
  parseObservationTime,
  sendLatestWeatherCloud
};
