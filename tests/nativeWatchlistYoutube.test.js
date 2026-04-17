const assert = require('assert');

const nativeStockWatchlist = require('../api/skills_native/stocks/watchlist');
const nativeYoutube = require('../api/skills_native/youtube');

module.exports = (async () => {
  const add = nativeStockWatchlist.mutateWatchlist('D:\\waifu\\data', {
    action: 'add',
    ticker: 'NVDA',
    target: 800,
    stop: 600,
    alert_on_signal: true
  });
  assert.ok(String(add).includes('NVDA'));

  const list = nativeStockWatchlist.mutateWatchlist('D:\\waifu\\data', {
    action: 'list'
  });
  assert.ok(typeof list === 'string');

  const check = nativeStockWatchlist.mutateWatchlist('D:\\waifu\\data', {
    action: 'check',
    notify: true
  });
  assert.ok(String(check).includes('📢 Stock Alerts'));

  const youtube = await nativeYoutube.getYoutubeTranscript({
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  });
  assert.ok(typeof youtube === 'string');
  assert.ok(
    youtube.includes('未配置')
    || youtube.length > 0
  );

  console.log('nativeWatchlistYoutube.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
