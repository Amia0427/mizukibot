const axios = require('axios');
const cheerio = require('cheerio');

function normalizeText(value = '') {
  return String(value || '').trim();
}

async function fetchCoinGeckoTrending() {
  const response = await axios.get('https://api.coingecko.com/api/v3/search/trending', {
    timeout: 15000,
    proxy: false,
    headers: {
      'User-Agent': 'MizukiBot/1.0 (stocks hot native client)'
    }
  });
  return Array.isArray(response?.data?.coins) ? response.data.coins : [];
}

async function fetchCompaniesMarketCap() {
  const response = await axios.get('https://companiesmarketcap.com/', {
    timeout: 15000,
    proxy: false,
    headers: {
      'User-Agent': 'MizukiBot/1.0 (stocks hot native client)'
    }
  });
  const html = String(response.data || '');
  const $ = cheerio.load(html);
  return $('table tbody tr').toArray().slice(0, 8).map((row) => {
    const element = $(row);
    const links = element.find('a').toArray().map((item) => $(item));
    const href = normalizeText(links[0]?.attr('href'));
    const symbol = normalizeText(links[0]?.text()).split(/\s+/)[0];
    const name = normalizeText(links[1]?.text() || element.find('div').first().text());
    return {
      symbol: symbol.toUpperCase(),
      name,
      source: 'CompaniesMarketCap',
      link: href ? `https://companiesmarketcap.com${href}` : ''
    };
  }).filter((item) => item.symbol);
}

async function scanHot({ json = false } = {}) {
  const [coins, movers] = await Promise.allSettled([
    fetchCoinGeckoTrending(),
    fetchCompaniesMarketCap()
  ]);

  const result = {
    scan_time: new Date().toISOString(),
    top_trending: [],
    stock_highlights: []
  };

  if (coins.status === 'fulfilled') {
    result.top_trending = coins.value.slice(0, 8).map((item) => ({
      symbol: normalizeText(item?.item?.symbol).toUpperCase(),
      name: normalizeText(item?.item?.name),
      market_cap_rank: item?.item?.market_cap_rank || null,
      source: 'CoinGecko Trending'
    }));
  }

  if (movers.status === 'fulfilled') {
    result.stock_highlights = movers.value.slice(0, 8).map((item) => ({
      symbol: normalizeText(item?.symbol).toUpperCase(),
      name: normalizeText(item?.name),
      price: null,
      change_pct: null,
      source: item?.source || 'CompaniesMarketCap',
      link: normalizeText(item?.link)
    }));
  }

  if (json) {
    return JSON.stringify(result, null, 2);
  }

  const lines = [
    `scan_time: ${result.scan_time}`,
    'top_trending:'
  ];
  if (result.top_trending.length === 0) {
    lines.push('  none');
  } else {
    result.top_trending.forEach((item, index) => {
      lines.push(`  ${index + 1}. ${item.symbol} ${item.name} rank=${item.market_cap_rank ?? 'n/a'}`);
    });
  }
  lines.push('stock_highlights:');
  if (result.stock_highlights.length === 0) {
    lines.push('  none');
  } else {
    result.stock_highlights.forEach((item, index) => {
      lines.push(`  ${index + 1}. ${item.symbol} ${item.name || ''}`.trim());
    });
  }
  return lines.join('\n');
}

module.exports = {
  scanHot
};
