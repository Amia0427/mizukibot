const axios = require('axios');
const cheerio = require('cheerio');

function normalizeText(value = '') {
  return String(value || '').trim();
}

async function fetchFinanceHeadlines() {
  const response = await axios.get('https://news.google.com/rss/search', {
    params: {
      q: 'stock market OR takeover OR insider buying OR analyst upgrade',
      hl: 'en-US',
      gl: 'US',
      ceid: 'US:en'
    },
    timeout: 8000,
    proxy: false,
    headers: {
      'User-Agent': 'MizukiBot/1.0 (stocks rumor native client)'
    }
  });
  return String(response.data || '');
}

async function scanRumors() {
  try {
    const xml = await fetchFinanceHeadlines();
    const $ = cheerio.load(xml, { xmlMode: true });
    const items = $('item').toArray().slice(0, 8).map((node) => {
      const element = $(node);
      return {
        title: normalizeText(element.find('title').first().text()),
        link: normalizeText(element.find('link').first().text())
      };
    });
    const filtered = items.filter((item) => /(rumor|takeover|acquisition|upgrade|downgrade|insider|probe|investigation|deal|merger)/i.test(item.title));
    if (filtered.length === 0) return items.length ? items.slice(0, 5).map((item, index) => `${index + 1}. ${item.title}\n   ${item.link}`).join('\n') : 'No rumor signals found.';
    return filtered.slice(0, 8).map((item, index) => `${index + 1}. ${item.title}\n   ${item.link}`).join('\n');
  } catch (error) {
    return `Rumor scan failed: ${error?.message || String(error)}`;
  }
}

module.exports = {
  scanRumors
};
