const axios = require('axios');
const config = require('../../../config');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : (value ? [value] : []);
}

async function fetchYahooQuote(symbol = '') {
  const normalized = normalizeText(symbol);
  if (!normalized) return null;
  const response = await axios.get('https://query1.finance.yahoo.com/v7/finance/quote', {
    params: { symbols: normalized },
    timeout: 15000,
    proxy: false,
    headers: {
      'User-Agent': config.HTTP_USER_AGENT
    }
  });
  return normalizeArray(response?.data?.quoteResponse?.result)[0] || null;
}

function toStooqSymbol(symbol = '') {
  const normalized = normalizeText(symbol).toLowerCase();
  if (!normalized) return '';
  if (normalized.endsWith('.us')) return normalized;
  return `${normalized}.us`;
}

async function fetchStooqQuote(symbol = '') {
  const stooqSymbol = toStooqSymbol(symbol);
  if (!stooqSymbol) return null;
  const response = await axios.get('https://stooq.com/q/l/', {
    params: {
      s: stooqSymbol,
      i: 'd'
    },
    timeout: 15000,
    proxy: false,
    headers: {
      'User-Agent': config.HTTP_USER_AGENT
    }
  });
  const line = String(response.data || '').trim().split(/\r?\n/).filter(Boolean)[0] || '';
  const [symbolRaw, date, time, open, high, low, close] = line.split(',');
  if (!symbolRaw) return null;
  return {
    symbol: String(symbolRaw || '').replace(/\.US$/i, '').toUpperCase(),
    shortName: '',
    regularMarketPrice: Number(close),
    regularMarketChangePercent: Number.isFinite(Number(open)) && Number(open) > 0
      ? ((Number(close) - Number(open)) / Number(open)) * 100
      : null,
    fullExchangeName: 'Stooq',
    currency: 'USD',
    regularMarketTime: `${date || ''} ${time || ''}`.trim()
  };
}

async function fetchAlphaVantageQuote(symbol = '') {
  const normalized = normalizeText(symbol).toUpperCase();
  if (!normalized) return null;
  const apiKey = normalizeText(process.env.ALPHAVANTAGE_API_KEY || 'demo') || 'demo';
  const response = await axios.get('https://www.alphavantage.co/query', {
    params: {
      function: 'GLOBAL_QUOTE',
      symbol: normalized,
      apikey: apiKey
    },
    timeout: 15000,
    proxy: false,
    headers: {
      'User-Agent': config.HTTP_USER_AGENT
    }
  });
  const quote = response?.data?.['Global Quote'];
  if (!quote || typeof quote !== 'object') return null;
  return {
    symbol: normalizeText(quote['01. symbol']),
    shortName: '',
    regularMarketPrice: Number(quote['05. price']),
    regularMarketChangePercent: Number(String(quote['10. change percent'] || '').replace('%', '')),
    fullExchangeName: 'Alpha Vantage',
    currency: 'USD'
  };
}

function formatQuoteRow(quote = {}) {
  const price = Number(quote.regularMarketPrice);
  const change = Number(quote.regularMarketChangePercent);
  return [
    `${normalizeText(quote.symbol)} ${normalizeText(quote.shortName || quote.longName)}`.trim(),
    Number.isFinite(price) ? `price: ${price}` : '',
    Number.isFinite(change) ? `change: ${change.toFixed(2)}%` : '',
    normalizeText(quote.fullExchangeName) ? `exchange: ${normalizeText(quote.fullExchangeName)}` : '',
    normalizeText(quote.currency) ? `currency: ${normalizeText(quote.currency)}` : ''
  ].filter(Boolean).join(' | ');
}

async function queryQuotes({ codes = [], code = '', tickers = [], ticker = '' } = {}) {
  const raw = normalizeArray(codes).concat(normalizeArray(tickers)).concat([code, ticker]);
  const symbols = raw
    .flatMap((item) => String(item || '').split(/[,\s]+/))
    .map((item) => normalizeText(item).toUpperCase())
    .filter(Boolean)
    .slice(0, 20);
  if (symbols.length === 0) return 'Missing code or codes.';

  const rows = [];
  for (const symbol of symbols) {
    try {
      let quote = null;
      try {
        quote = await fetchYahooQuote(symbol);
      } catch (_) {
        quote = await fetchStooqQuote(symbol);
      }
      if (!quote) {
        quote = await fetchAlphaVantageQuote(symbol);
      }
      if (!quote) {
        rows.push(`${symbol} | unavailable`);
      } else {
        rows.push(formatQuoteRow(quote));
      }
    } catch (error) {
      rows.push(`${symbol} | error: ${error?.message || String(error)}`);
    }
  }
  return rows.join('\n');
}

module.exports = {
  queryQuotes
};
