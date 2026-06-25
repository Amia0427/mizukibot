const assert = require('assert');
const axios = require('axios');

const nativeStockHot = require('../api/skills_native/stocks/hot');
const nativeStockRumor = require('../api/skills_native/stocks/rumor');
const nativeStockAnalyze = require('../api/skills_native/stocks/analyze');

module.exports = (async () => {
  const originalGet = axios.get;
  axios.get = async (url) => {
    const textUrl = String(url || '');
    if (textUrl.includes('coingecko')) {
      return {
        data: {
          coins: [
            { item: { symbol: 'btc', name: 'Bitcoin', market_cap_rank: 1 } }
          ]
        }
      };
    }
    if (textUrl.includes('companiesmarketcap')) {
      return {
        data: '<table><tbody><tr><td><a href="/apple/marketcap/">AAPL</a><a>Apple</a></td></tr></tbody></table>'
      };
    }
    if (textUrl.includes('alphavantage')) {
      return {
        data: {
          feed: [
            { title: 'Apple acquisition rumor lifts shares', url: 'https://example.com/aapl-rumor' }
          ],
          'Global Quote': {
            '01. symbol': 'AAPL',
            '05. price': '200',
            '10. change percent': '1.50%'
          }
        }
      };
    }
    if (textUrl.includes('query1.finance.yahoo.com/v7/finance/quote')) {
      return {
        data: {
          quoteResponse: {
            result: [
              {
                symbol: 'AAPL',
                shortName: 'Apple',
                regularMarketPrice: 200,
                regularMarketChangePercent: 1.5,
                fullExchangeName: 'Nasdaq',
                currency: 'USD'
              }
            ]
          }
        }
      };
    }
    if (textUrl.includes('query1.finance.yahoo.com/v8/finance/chart')) {
      return {
        data: {
          chart: {
            result: [
              {
                events: {
                  dividends: {
                    one: { date: 1767225600, amount: 0.25 }
                  }
                }
              }
            ]
          }
        }
      };
    }
    throw new Error(`unexpected stock test URL: ${textUrl}`);
  };

  try {
    const hotText = await nativeStockHot.scanHot({});
    assert.ok(typeof hotText === 'string');
    assert.ok(String(hotText).includes('scan_time:'));

    const rumorText = await nativeStockRumor.scanRumors();
    assert.ok(typeof rumorText === 'string');
    assert.ok(String(rumorText).includes('Apple acquisition rumor'));

    const analyzeText = await nativeStockAnalyze.analyzeStocks({ ticker: 'AAPL', fast: true });
    assert.ok(typeof analyzeText === 'string');
    assert.ok(String(analyzeText).includes('quotes:'));

    const analyzeJson = await nativeStockAnalyze.analyzeStocks({ ticker: 'AAPL', output: 'json' });
    assert.ok(typeof analyzeJson === 'string');
    assert.ok(String(analyzeJson).includes('"tickers"'));
  } finally {
    axios.get = originalGet;
  }

  console.log('nativeStocksAdvanced.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
