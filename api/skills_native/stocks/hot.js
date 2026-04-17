const axios = require('axios');

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

async function fetchStooqLeaders() {
  const response = await axios.get('https://stooq.com/t/?i=528', {
    timeout: 15000,
    proxy: false,
    headers: {
      'User-Agent': 'MizukiBot/1.0 (stocks hot native client)'
    }
  });
  const text = String(response.data || '');
  const matches = [...text.matchAll(/\b([A-Z]{1,5})\.US\b/g)].slice(0, 8);
  return matches.map((item) => ({
    symbol: item[1],
    shortName: '',
    regularMarketChangePercent: null
  }));
}

async function scanHot({ json = false } = {}) {
  const [coins, movers] = await Promise.allSettled([
    fetchCoinGeckoTrending(),
    fetchStooqLeaders()
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
        name: normalizeText(item?.shortName || item?.longName),
        price: item?.regularMarketPrice,
        change_pct: item?.regularMarketChangePercent,
        source: 'Stooq Leaders'
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
      lines.push(`  ${index + 1}. ${item.symbol} ${item.name} change=${Number(item.change_pct || 0).toFixed(2)}%`);
    });
  }
  return lines.join('\n');
}

module.exports = {
  scanHot
};
