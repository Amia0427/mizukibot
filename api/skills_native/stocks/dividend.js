const axios = require('axios');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : (value ? [value] : []);
}

async function fetchYahooDividend(symbol = '') {
  const normalized = normalizeText(symbol);
  if (!normalized) return null;
  const response = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(normalized)}`, {
    params: {
      interval: '1mo',
      range: '5y',
      events: 'div'
    },
    timeout: 15000,
    proxy: false,
    headers: {
      'User-Agent': 'MizukiBot/1.0 (stocks native client)'
    }
  });
  return response?.data?.chart?.result?.[0] || null;
}

async function queryDividends({ tickers = [], ticker = '' } = {}) {
  const raw = normalizeArray(tickers).concat([ticker]);
  const symbols = raw
    .flatMap((item) => String(item || '').split(/[,\s]+/))
    .map((item) => normalizeText(item).toUpperCase())
    .filter(Boolean)
    .slice(0, 20);
  if (symbols.length === 0) return 'Missing ticker or tickers.';

  const lines = [];
  for (const symbol of symbols) {
    try {
      const result = await fetchYahooDividend(symbol);
      const events = result?.events?.dividends || {};
      const items = Object.values(events).slice(-5);
      if (items.length === 0) {
        lines.push(`${symbol} | no dividend data`);
        continue;
      }
      lines.push(`${symbol} | recent dividends: ${items.map((item) => `${item.date || ''}:${item.amount}`).join(', ')}`);
    } catch (error) {
      lines.push(`${symbol} | error: ${error?.message || String(error)}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  queryDividends
};
