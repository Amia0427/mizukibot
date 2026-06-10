const axios = require('axios');
const config = require('../../config');

function normalizeText(value = '') {
  return String(value || '').trim();
}

async function getWeatherSummary({ location = '', format = '%l:+%c+%t+%h+%w' } = {}) {
  const normalizedLocation = normalizeText(location);
  if (!normalizedLocation) return '请提供 location，例如：location="Shanghai"';
  const encodedLocation = encodeURIComponent(normalizedLocation).replace(/%20/g, '+');
  const url = `https://wttr.in/${encodedLocation}?format=${encodeURIComponent(normalizeText(format) || '%l:+%c+%t+%h+%w')}`;
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      proxy: false,
      headers: {
        'User-Agent': config.HTTP_USER_AGENT
      }
    });
    return normalizeText(response.data) || '未获取到天气信息';
  } catch (error) {
    return `天气查询失败：${error?.message || String(error)}`;
  }
}

module.exports = {
  getWeatherSummary
};
