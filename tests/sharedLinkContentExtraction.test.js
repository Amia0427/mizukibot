const assert = require('assert');

const {
  canonicalizeKnownShareUrl,
  extractUrlsFromJsonPayload,
  identifyCardPlatform
} = require('../core/continuousMessage/contentExtraction');

(() => {
  assert.strictEqual(identifyCardPlatform('https://xhslink.com/a/abc123'), 'xhs');
  assert.strictEqual(identifyCardPlatform('https://b23.tv/abc123'), 'bilibili');
  assert.strictEqual(identifyCardPlatform('https://www.bilibili.com/video/BV1xx411c7mD'), 'bilibili');
  assert.strictEqual(identifyCardPlatform('https://www.xiaohongshu.com/explore/abc123'), 'xhs');
  assert.strictEqual(identifyCardPlatform('https://music.163.com/#/album?id=34720827'), 'ncm');

  assert.strictEqual(
    canonicalizeKnownShareUrl('https://www.xiaohongshu.com/explore/abc123?xsec_token=secret-token&utm_source=qq'),
    'https://www.xiaohongshu.com/discovery/item/abc123?xsec_token=secret-token'
  );
  assert.strictEqual(
    canonicalizeKnownShareUrl('https://m.bilibili.com/video/BV1xx411c7mD?p=2&spm_id_from=333'),
    'https://www.bilibili.com/video/BV1xx411c7mD?p=2'
  );
  assert.strictEqual(
    canonicalizeKnownShareUrl('https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=333'),
    'https://www.bilibili.com/video/BV1xx411c7mD'
  );
  assert.strictEqual(
    canonicalizeKnownShareUrl('https://music.163.com/#/song?id=186016'),
    'https://music.163.com/#/song?id=186016'
  );
  assert.strictEqual(
    canonicalizeKnownShareUrl('https://music.163.com/m/playlist?id=3778678&userid=1'),
    'https://music.163.com/#/playlist?id=3778678'
  );
  assert.strictEqual(
    canonicalizeKnownShareUrl('https://y.music.163.com/m/album?id=34720827'),
    'https://music.163.com/#/album?id=34720827'
  );

  const cardUrls = extractUrlsFromJsonPayload(JSON.stringify({
    meta: {
      jumpUrl: 'https://xhslink.com/a/abc123',
      nested: { musicUrl: 'https://music.163.com/#/song?id=186016' }
    }
  }));
  assert.deepStrictEqual(cardUrls, [
    'https://xhslink.com/a/abc123',
    'https://music.163.com/#/song?id=186016'
  ]);

  console.log('sharedLinkContentExtraction.test.js passed');
})();
