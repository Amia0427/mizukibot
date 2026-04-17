const axios = require('axios');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function buildMissingConfigMessage() {
  return 'Missing BAIDU_API_KEY. AI PPT skill is unavailable.';
}

async function listThemes() {
  if (!normalizeText(process.env.BAIDU_API_KEY || '')) {
    return buildMissingConfigMessage();
  }
  return 'AI PPT theme list HTTP provider is not configured yet.';
}

async function generatePpt({ query = '', topic = '', style_id = null, tpl_id = null, web_content = '' } = {}) {
  const finalQuery = normalizeText(query || topic);
  if (!finalQuery) return 'Missing query.';
  if (!normalizeText(process.env.BAIDU_API_KEY || '')) {
    return buildMissingConfigMessage();
  }

  const endpoint = normalizeText(process.env.BAIDU_PPT_API_URL || '');
  if (!endpoint) {
    return 'AI PPT HTTP provider is not configured yet.';
  }

  try {
    const response = await axios.post(endpoint, {
      query: finalQuery,
      style_id,
      tpl_id,
      web_content: normalizeText(web_content)
    }, {
      timeout: 60000,
      proxy: false,
      headers: {
        Authorization: `Bearer ${normalizeText(process.env.BAIDU_API_KEY)}`,
        'Content-Type': 'application/json'
      }
    });
    return JSON.stringify(response.data || {}, null, 2);
  } catch (error) {
    return `PPT generation failed: ${error?.message || String(error)}`;
  }
}

module.exports = {
  generatePpt,
  listThemes
};
