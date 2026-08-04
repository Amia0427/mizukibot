const assert = require('assert');
const crypto = require('crypto');

const {
  buildMaidataCharts,
  createMaimaiSourceClient,
  parseMaidataFile
} = require('../src/features/maimai/source-client');

function response(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get(name) { return headers[String(name).toLowerCase()] || ''; } },
    async json() { return body; },
    async text() { return String(body); }
  };
}

module.exports = (async () => {
  const raw = `&title=Test\n&shortid=42\n&artist=Artist\n&wholebpm=180\n&cabinet=DX\n&lv_1=4\n&inote_1=\n(180){4}1,E\n&des_1=Charter\n&lv_2=7+\n&inote_2=\n(180){4}1,2,E`;
  const parsed = parseMaidataFile(raw, 'songs/42/maidata.txt');
  assert.strictEqual(parsed.musicId, '42');
  assert.strictEqual(parsed.chartType, 'DX');
  assert.strictEqual(parsed.charts.length, 2);
  assert.strictEqual(parsed.charts[0].difficultyIndex, 0);
  assert.strictEqual(parsed.charts[0].level, '4');
  assert.match(parsed.charts[0].rawChart, /\(180\)\{4\}1,E/);

  const officialRaw = `&title=Test[DX]\n&shortid=42\n&cabinet=DX\n&lv_2=4\n&inote_2=\n(180){4}1,E\n&lv_5=12\n&inote_5=\n(180){4}1,2,E`;
  const official = parseMaidataFile(officialRaw, 'songs/42/maidata.txt');
  assert.deepStrictEqual(official.charts.map((chart) => chart.difficultyIndex), [0, 3]);

  const built = buildMaidataCharts([{ path: 'songs/42/maidata.txt', sha: 'blob-1', content: raw }]);
  assert.strictEqual(built.songs.length, 1);
  assert.strictEqual(built.sourceCharts.length, 2);
  assert.strictEqual(built.sourceCharts[0].contentHash, crypto.createHash('sha256').update('(180){4}1,E').digest('hex'));

  const calls = [];
  const client = createMaimaiSourceClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/music_data')) return response(200, [{ id: '42' }], { etag: 'music-v1' });
      if (url.includes('/chart_stats')) return response(200, { charts: {} }, { etag: 'stats-v1' });
      if (url.includes('/commits/')) return response(200, {
        sha: 'commit-v1',
        commit: { tree: { sha: 'tree-v1' } }
      });
      if (url.includes('/git/trees/')) return response(200, {
        truncated: false,
        tree: [{ path: 'songs/42/maidata.txt', type: 'blob', sha: 'blob-1' }]
      });
      if (url === 'https://raw.githubusercontent.com/TowableSpace694/maidata/commit-v1/songs/42/maidata.txt') return response(200, raw);
      throw new Error(`unexpected url ${url}`);
    },
    githubRepo: 'TowableSpace694/maidata',
    githubBranch: 'main'
  });
  const snapshot = await client.fetchAll({ musicEtag: '', statsEtag: '', previousTree: {} });
  assert.strictEqual(snapshot.music.etag, 'music-v1');
  assert.strictEqual(snapshot.stats.etag, 'stats-v1');
  assert.strictEqual(snapshot.maidata.sourceRevision, 'commit-v1');
  assert.strictEqual(snapshot.maidata.changed.length, 1);
  assert.strictEqual(calls.filter((item) => item.url.includes('raw.githubusercontent.com')).length, 1);

  const unchangedDivingFish = await client.fetchDivingFish({
    musicEtag: 'music-v1',
    statsEtag: 'stats-v1'
  });
  assert.strictEqual(unchangedDivingFish.music.unchanged, true);
  assert.strictEqual(unchangedDivingFish.stats.unchanged, true);

  const noChange = await client.fetchMaidata({ previousTree: { 'songs/42/maidata.txt': 'blob-1' } });
  assert.strictEqual(noChange.changed.length, 0);
  assert.strictEqual(noChange.noop, true);

  const cdnClient = createMaimaiSourceClient({
    fetchImpl: async (url) => {
      if (url.includes('/commits/')) return response(200, { sha: 'commit-v1', commit: { tree: { sha: 'tree-v1' } } });
      if (url.includes('/git/trees/')) return response(200, { truncated: false, tree: [{ path: 'songs/42/maidata.txt', type: 'blob', sha: 'blob-1' }] });
      if (url.includes('raw.githubusercontent.com')) throw new TypeError('fetch failed');
      if (url.includes('cdn.jsdelivr.net')) return response(200, raw);
      throw new Error(`unexpected url ${url}`);
    }
  });
  const cdnSnapshot = await cdnClient.fetchMaidata({ previousTree: {} });
  assert.strictEqual(cdnSnapshot.changed[0].content, raw);

  console.log('maimaiSourceClient.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
