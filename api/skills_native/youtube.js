const axios = require('axios');
const cheerio = require('cheerio');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function extractVideoId(url = '') {
  const text = normalizeText(url);
  if (!text) return '';
  const direct = text.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
  if (direct) return direct[1];
  const short = text.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  if (short) return short[1];
  return '';
}

async function fetchTranscriptViaProvider(videoId = '', providerUrl = '') {
  const endpoint = normalizeText(providerUrl);
  if (!endpoint) return '';
  const response = await axios.get(endpoint, {
    params: { videoId },
    timeout: 15000,
    proxy: false,
    headers: {
      'User-Agent': 'MizukiBot/1.0 (youtube native client)'
    }
  });
  const data = response?.data;
  if (typeof data === 'string') {
    if (data.includes('<transcript>')) {
      const $ = cheerio.load(data, { xmlMode: true });
      const texts = $('text').toArray().map((item) => normalizeText($(item).text())).filter(Boolean);
      const combined = texts.join('\n');
      if (/blocking us from fetching subtitles/i.test(combined)) return '';
      return combined;
    }
    if (/<html[\s>]/i.test(data) || /<!DOCTYPE html>/i.test(data)) {
      return '';
    }
    return normalizeText(data);
  }
  if (Array.isArray(data?.segments)) {
    return data.segments.map((item) => normalizeText(item?.text || item)).filter(Boolean).join('\n');
  }
  if (Array.isArray(data?.transcript)) {
    return data.transcript.map((item) => normalizeText(item?.text || item)).filter(Boolean).join('\n');
  }
  return normalizeText(data?.text || data?.transcript_text || '');
}

async function getYoutubeTranscript({ url = '', transcript_provider_url = '' } = {}) {
  const videoId = extractVideoId(url);
  if (!videoId) return '请提供 YouTube 视频链接，例如：url="https://www.youtube.com/watch?v=..."';

  const transcript = await fetchTranscriptViaProvider(
    videoId,
    transcript_provider_url
    || process.env.YOUTUBE_TRANSCRIPT_PROVIDER_URL
    || 'https://youtubetranscript.com/?server_vid2='
  );
  if (transcript) return transcript;

  return '未配置可用的 YouTube transcript HTTP provider；当前纯 JS/HTTP 版本只支持显式 transcript provider。';
}

module.exports = {
  getYoutubeTranscript
};
