const { queryQuotes } = require('./quote');
const { queryDividends } = require('./dividend');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeTickers(raw) {
  return (Array.isArray(raw) ? raw : [raw])
    .flatMap((item) => String(item || '').split(/[,\s]+/))
    .map((item) => normalizeText(item).toUpperCase())
    .filter(Boolean);
}

async function analyzeStocks({ tickers = [], ticker = '', fast = false, no_insider = false, output = 'text' } = {}) {
  const symbols = normalizeTickers(tickers).concat(normalizeTickers(ticker)).filter(Boolean);
  if (symbols.length === 0) return 'Missing ticker or tickers.';

  const quoteText = await queryQuotes({ codes: symbols });
  const dividendText = await queryDividends({ tickers: symbols });
  const summary = {
    tickers: symbols,
    mode: fast ? 'fast' : 'standard',
    insider: no_insider ? 'skipped' : 'not_supported_in_native_mode',
    quotes: quoteText,
    dividends: dividendText,
    notes: [
      'Native analysis currently focuses on quote/dividend snapshots.',
      'Portfolio scoring and rumor/hot aggregation are being migrated away from Python.'
    ]
  };

  if (String(output || '').trim().toLowerCase() === 'json') {
    return JSON.stringify(summary, null, 2);
  }

  return [
    `mode: ${summary.mode}`,
    `insider: ${summary.insider}`,
    'quotes:',
    summary.quotes,
    'dividends:',
    summary.dividends,
    'notes:',
    ...summary.notes.map((item) => `- ${item}`)
  ].join('\n');
}

module.exports = {
  analyzeStocks
};
