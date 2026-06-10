const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../../../config');

function normalizeText(value = '') {
  return String(value || '').trim();
}

async function fetchAlphaVantageRumors() {
  const apiKey = normalizeText(process.env.ALPHAVANTAGE_API_KEY || 'demo') || 'demo';
  const response = await axios.get('https://www.alphavantage.co/query', {
    params: {
      function: 'NEWS_SENTIMENT',
      topics: 'mergers_and_acquisitions,financial_markets,economy_macro',
      sort: 'LATEST',
      limit: 15,
      apikey: apiKey
    },
    timeout: 12000,
    proxy: false,
    headers: {
      'User-Agent': config.HTTP_USER_AGENT
    }
  });
  return Array.isArray(response?.data?.feed) ? response.data.feed : [];
}

async function fetchFinanceHeadlines() {
  const feeds = [
    'https://feeds.marketwatch.com/marketwatch/topstories/',
    'https://www.cnbc.com/id/100003114/device/rss/rss.html',
    'https://seekingalpha.com/feed.xml'
  ];
  for (const url of feeds) {
    try {
      const response = await axios.get(url, {
        timeout: 8000,
        proxy: false,
        headers: {
          'User-Agent': config.HTTP_USER_AGENT
        }
      });
      return String(response.data || '');
    } catch (_) {}
  }
  return '';
}

async function scanRumors() {
  try {
    const avItems = await fetchAlphaVantageRumors();
    const avFiltered = avItems
      .map((item) => ({
        title: normalizeText(item?.title),
        link: normalizeText(item?.url)
      }))
      .filter((item) => /(rumor|takeover|acquisition|upgrade|downgrade|insider|probe|investigation|deal|merger)/i.test(item.title))
      .slice(0, 8);
    if (avFiltered.length > 0) {
      return avFiltered.map((item, index) => `${index + 1}. ${item.title}\n   ${item.link}`).join('\n');
    }

    const xml = await fetchFinanceHeadlines();
    if (!xml) return 'No rumor signals found.';
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
