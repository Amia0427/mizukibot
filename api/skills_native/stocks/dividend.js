const axios = require('axios');
const config = require('../../../config');

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
      'User-Agent': config.HTTP_USER_AGENT
    }
  });
  return response?.data?.chart?.result?.[0] || null;
}

async function fetchTwelveDataDividends(symbol = '') {
  const normalized = normalizeText(symbol);
  if (!normalized) return [];
  const response = await axios.get('https://api.twelvedata.com/dividends', {
    params: {
      symbol: normalized,
      apikey: normalizeText(process.env.TWELVEDATA_API_KEY || 'demo') || 'demo'
    },
    timeout: 15000,
    proxy: false,
    headers: {
      'User-Agent': config.HTTP_USER_AGENT
    }
  });
  const payload = response?.data;
  if (payload?.status === 'error') {
    throw new Error(normalizeText(payload?.message || payload?.code) || 'TwelveData dividend query failed');
  }
  return Array.isArray(payload?.dividends) ? payload.dividends : [];
}

function normalizeDividendDate(value) {
  if (Number.isFinite(Number(value)) && Number(value) > 0) {
    const millis = Number(value) > 10_000_000_000 ? Number(value) : Number(value) * 1000;
    try {
      return new Date(millis).toISOString().slice(0, 10);
    } catch (_) {
      return String(value);
    }
  }
  const text = normalizeText(value);
  return text ? text.slice(0, 10) : '';
}

function extractYahooDividendItems(result = {}) {
  const events = result?.events?.dividends || {};
  return Object.values(events)
    .map((item) => ({
      date: normalizeDividendDate(item?.date),
      amount: Number(item?.amount)
    }))
    .filter((item) => item.date && Number.isFinite(item.amount))
    .slice(-5);
}

function extractTwelveDataDividendItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      date: normalizeDividendDate(item?.ex_date || item?.payment_date || item?.record_date),
      amount: Number(item?.amount)
    }))
    .filter((item) => item.date && Number.isFinite(item.amount))
    .slice(0, 5);
}

function formatDividendLine(symbol = '', items = [], source = '') {
  const sourceLabel = normalizeText(source) || 'unknown';
  if (!items.length) return `${symbol} | no dividend data`;
  return `${symbol} | recent dividends (${sourceLabel}): ${items.map((item) => `${item.date}:${item.amount}`).join(', ')}`;
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
    let yahooError = null;
    try {
      const result = await fetchYahooDividend(symbol);
      const items = extractYahooDividendItems(result);
      if (items.length === 0) {
        yahooError = new Error('Yahoo returned no dividend items');
      } else {
        lines.push(formatDividendLine(symbol, items, 'Yahoo'));
        continue;
      }
    } catch (error) {
      yahooError = error;
    }

    try {
      const items = extractTwelveDataDividendItems(await fetchTwelveDataDividends(symbol));
      if (items.length === 0) {
        lines.push(`${symbol} | no dividend data`);
        continue;
      }
      lines.push(formatDividendLine(symbol, items, 'TwelveData'));
    } catch (fallbackError) {
      const reasons = [
        yahooError?.message ? `yahoo=${yahooError.message}` : '',
        fallbackError?.message ? `twelvedata=${fallbackError.message}` : ''
      ].filter(Boolean);
      lines.push(`${symbol} | error: ${reasons.join('; ') || 'dividend query failed'}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  queryDividends
};
