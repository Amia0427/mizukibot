const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const axios = require('axios');
const config = require('../../config');
const { requestSafeHttpUrl } = require('../../utils/networkSafety');

const MAX_REMOTE_BYTES = 2 * 1024 * 1024;

function normalizeText(value = '') {
  return String(value || '').trim();
}

function summarizePlainText(text = '', length = 'short') {
  const normalized = normalizeText(text).replace(/\s+/g, ' ');
  if (!normalized) return '未提取到可总结内容。';
  const maxChars = String(length || 'short').trim() === 'long' ? 1200 : 400;
  return normalized.slice(0, maxChars) + (normalized.length > maxChars ? '...' : '');
}

async function summarizeInput({ input = '', length = 'short' } = {}, dataDir, options = {}) {
  const target = normalizeText(input);
  if (!target) return '请提供 input（URL 或文件路径）。';

  if (/^https?:\/\//i.test(target)) {
    try {
      const response = await requestSafeHttpUrl(target, {
        lookup: options.lookup,
        maxRedirects: 5,
        request: options.request || axios.get,
        requestOptions: {
          timeout: 15000,
          maxContentLength: MAX_REMOTE_BYTES,
          maxBodyLength: MAX_REMOTE_BYTES,
          responseType: 'text',
          proxy: false,
          headers: {
            'User-Agent': config.HTTP_USER_AGENT
          }
        }
      });
      const html = String(response.data || '');
      if (Buffer.byteLength(html, 'utf8') > MAX_REMOTE_BYTES) {
        throw new Error(`response exceeds ${MAX_REMOTE_BYTES} byte limit`);
      }
      const $ = cheerio.load(html);
      $('script,style,noscript,iframe,svg').remove();
      const title = normalizeText($('title').first().text());
      const text = normalizeText($('main').first().text() || $('article').first().text() || $('body').text());
      return [
        title ? `标题：${title}` : '',
        `摘要：${summarizePlainText(text, length)}`
      ].filter(Boolean).join('\n');
    } catch (error) {
      return `总结失败：${error?.message || String(error)}`;
    }
  }

  const abs = path.isAbsolute(target) ? target : path.join(dataDir, target);
  if (!fs.existsSync(abs)) {
    return `未找到文件：${abs}`;
  }
  const text = fs.readFileSync(abs, 'utf8');
  return summarizePlainText(text, length);
}

module.exports = {
  summarizeInput
};
