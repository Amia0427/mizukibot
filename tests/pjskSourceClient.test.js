const assert = require('assert');
const {
  MASTER_FILES,
  buildMasterCatalog,
  createPjskSourceClient
} = require('../src/features/pjsk/source-client');

function masterFixture() {
  return {
    jpMusics: [{ id: 1, title: 'ロキ', pronunciation: 'ろき', lyricist: 'みきとP', composer: 'みきとP', arranger: 'みきとP', assetbundleName: 'jacket_s_001', publishedAt: 1000 }],
    jpDifficulties: [{ musicId: 1, musicDifficulty: 'master', playLevel: 28, totalNoteCount: 975 }],
    jpVocals: [{ id: 10, musicId: 1, musicVocalType: 'sekai', caption: 'セカイver.', assetbundleName: '0001_02', characters: [{ characterId: 1 }] }],
    jpTags: [{ musicId: 1, musicTag: 'vocaloid' }],
    jpCharacters: [{ id: 1, firstName: '星乃', givenName: '一歌', firstNameEnglish: 'HOSHINO', givenNameEnglish: 'ICHIKA', unit: 'light_sound' }],
    cnMusics: [{ id: 1, title: '洛基', infos: [{ title: 'ROKI' }] }]
  };
}

module.exports = (async () => {
  const catalog = buildMasterCatalog(masterFixture());
  assert.strictEqual(catalog.songs[0].title, 'ロキ');
  assert.ok(catalog.aliases.some((row) => row.locale === 'zh-CN' && row.alias === '洛基'));
  assert.ok(catalog.aliases.some((row) => row.locale === 'en' && row.alias === 'ROKI'));
  assert.strictEqual(catalog.charts[0].chartKey, 'jp:1:master');
  assert.strictEqual(catalog.singingVersions[0].characters[0].name, '星乃一歌');
  assert.throws(() => buildMasterCatalog({ ...masterFixture(), jpDifficulties: [{}] }), /invalid row/);

  const bodies = masterFixture();
  const calls = [];
  const client = createPjskSourceClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const name = MASTER_FILES.find(([, base, file]) => url === `${base}/${file}`)?.[0];
      if (options.headers['If-None-Match'] === `etag-${name}`) {
        return { status: 304, ok: false, headers: { get: () => `etag-${name}` } };
      }
      return {
        status: 200,
        ok: true,
        headers: { get: () => `etag-${name}` },
        text: async () => JSON.stringify(bodies[name])
      };
    }
  });
  const first = await client.fetchMaster();
  assert.strictEqual(first.unchanged, false);
  const second = await client.fetchMaster({ etags: first.etags });
  assert.strictEqual(second.unchanged, true);
  assert.ok(calls.some((call) => call.options.headers['If-None-Match']));
  console.log('pjskSourceClient.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
