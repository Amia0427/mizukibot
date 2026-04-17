const assert = require('assert');

const nativeStockHot = require('../api/skills_native/stocks/hot');
const nativeStockRumor = require('../api/skills_native/stocks/rumor');
const nativeStockAnalyze = require('../api/skills_native/stocks/analyze');

module.exports = (async () => {
  const hotText = await nativeStockHot.scanHot({});
  assert.ok(typeof hotText === 'string');
  assert.ok(String(hotText).includes('scan_time:'));

  const rumorText = await nativeStockRumor.scanRumors();
  assert.ok(typeof rumorText === 'string');

  const analyzeText = await nativeStockAnalyze.analyzeStocks({ ticker: 'AAPL', fast: true });
  assert.ok(typeof analyzeText === 'string');
  assert.ok(String(analyzeText).includes('quotes:'));

  const analyzeJson = await nativeStockAnalyze.analyzeStocks({ ticker: 'AAPL', output: 'json' });
  assert.ok(typeof analyzeJson === 'string');
  assert.ok(String(analyzeJson).includes('"tickers"'));

  console.log('nativeStocksAdvanced.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
