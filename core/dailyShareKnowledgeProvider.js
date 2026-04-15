const axios = require('axios');

function getTimeoutMs() {
  return 10000;
}

async function fetchBaike({ keyword } = {}) {
  const word = String(keyword || '')
    .replace(/[【】「」]/g, '')
    .trim();
  if (!word) return null;

  let response = null;
  try {
    response = await axios.get('https://api.nycnm.cn/API/baike.php', {
      params: {
        word,
        format: 'json'
      },
      timeout: getTimeoutMs()
    });
  } catch (error) {
    const status = Number(error?.response?.status || 0) || 0;
    const reason = status > 0
      ? `status=${status}`
      : String(error?.message || error || 'unknown-error');
    console.warn('[daily-share] baike degraded', {
      keyword: word,
      reason
    });
    return null;
  }

  const data = response?.data;
  if (!data || typeof data !== 'object') return null;
  if (!(String(data.code || '') === '200' || data.success === true)) return null;

  const payload = data.data;
  if (payload && typeof payload === 'object') {
    const title = String(payload.title || word).trim() || word;
    const summary = String(payload.abstract || payload.description || '').replace(/\s+/g, ' ').trim();
    if (!summary) return null;
    return { title, summary };
  }
  if (typeof payload === 'string' && payload.trim()) {
    return { title: word, summary: payload.trim() };
  }
  return null;
}

module.exports = {
  fetchBaike
};
