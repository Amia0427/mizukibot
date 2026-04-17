const assert = require('assert');

const nativeSummarize = require('../api/skills_native/summarize');
const nativeStockQuote = require('../api/skills_native/stocks/quote');
const nativeStockDividend = require('../api/skills_native/stocks/dividend');
const nativeStockPortfolio = require('../api/skills_native/stocks/portfolio');

module.exports = (async () => {
  const summarized = await nativeSummarize.summarizeInput({
    input: 'README.md',
    length: 'short'
  }, 'D:\\waifu');
  assert.ok(typeof summarized === 'string');

  const missingSummary = await nativeSummarize.summarizeInput({ input: 'nope.txt' }, 'D:\\waifu');
  assert.ok(String(missingSummary).includes('未找到文件'));

  const portfolioCreate = nativeStockPortfolio.mutatePortfolio('D:\\waifu\\data', {
    action: 'create',
    name: 'test_portfolio'
  });
  assert.ok(String(portfolioCreate).includes('created'));

  const portfolioAdd = nativeStockPortfolio.mutatePortfolio('D:\\waifu\\data', {
    action: 'add',
    portfolio: 'test_portfolio',
    ticker: 'AAPL',
    quantity: 10,
    cost: 100
  });
  assert.ok(String(portfolioAdd).includes('AAPL'));

  const quoteText = await nativeStockQuote.queryQuotes({ code: 'AAPL' });
  assert.ok(typeof quoteText === 'string');

  const dividendText = await nativeStockDividend.queryDividends({ ticker: 'AAPL' });
  assert.ok(typeof dividendText === 'string');

  console.log('nativeSummarizeStock.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
