const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const nativeSummarize = require('../api/skills_native/summarize');
const nativeStockQuote = require('../api/skills_native/stocks/quote');
const nativeStockDividend = require('../api/skills_native/stocks/dividend');
const nativeStockPortfolio = require('../api/skills_native/stocks/portfolio');

module.exports = (async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-native-stock-'));
  try {
    const summarized = await nativeSummarize.summarizeInput({
      input: 'README.md',
      length: 'short'
    }, 'D:\\waifu');
    assert.ok(typeof summarized === 'string');

    const missingSummary = await nativeSummarize.summarizeInput({ input: 'nope.txt' }, 'D:\\waifu');
    assert.ok(String(missingSummary).includes('未找到文件'));

    const portfolioCreate = nativeStockPortfolio.mutatePortfolio(dataDir, {
      action: 'create',
      name: 'test_portfolio'
    });
    assert.ok(String(portfolioCreate).includes('created'));

    const portfolioAdd = nativeStockPortfolio.mutatePortfolio(dataDir, {
      action: 'add',
      portfolio: 'test_portfolio',
      ticker: 'AAPL',
      quantity: 10,
      cost: 100
    });
    assert.ok(String(portfolioAdd).includes('AAPL'));

    const quoteText = await nativeStockQuote.queryQuotes({ code: 'AAPL' }, {
      request: async () => ({
        data: {
          quoteResponse: {
            result: [{
              symbol: 'AAPL',
              shortName: 'Apple',
              regularMarketPrice: 201.5,
              regularMarketChangePercent: 1.25,
              fullExchangeName: 'Nasdaq',
              currency: 'USD'
            }]
          }
        }
      })
    });
    assert.ok(quoteText.includes('AAPL Apple'));
    assert.ok(quoteText.includes('price: 201.5'));

    const dividendText = await nativeStockDividend.queryDividends({ ticker: 'AAPL' }, {
      request: async () => ({
        data: {
          chart: {
            result: [{
              events: {
                dividends: {
                  latest: { date: 1778457600, amount: 0.26 }
                }
              }
            }]
          }
        }
      })
    });
    assert.ok(dividendText.includes('AAPL | recent dividends (Yahoo)'));
    assert.ok(dividendText.includes(':0.26'));

    console.log('nativeSummarizeStock.test.js passed');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
