const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  clearSharedLinkCache,
  readSharedLink
} = require('../api/skills_native/sharedLink');

const fixtureDir = path.join(__dirname, 'fixtures', 'shared-link');

function readFixture(name, json = true) {
  const text = fs.readFileSync(path.join(fixtureDir, name), 'utf8');
  return json ? JSON.parse(text) : text;
}

const fixtures = {
  xhs: readFixture('xiaohongshu-note.html', false),
  song: readFixture('netease-song.json'),
  lyrics: readFixture('netease-lyrics.json'),
  playlist: readFixture('netease-playlist.json'),
  album: readFixture('netease-album.json'),
  biliView: readFixture('bilibili-view.json'),
  biliTags: readFixture('bilibili-tags.json'),
  biliPlayer: readFixture('bilibili-player.json'),
  biliSubtitle: readFixture('bilibili-subtitle.json')
};

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

function response(data, contentType = 'application/json') {
  return { status: 200, headers: { 'content-type': contentType }, data };
}

module.exports = (async () => {
  clearSharedLinkCache();
  const visionCalls = [];
  const xhs = await readSharedLink({
    url: 'https://www.xiaohongshu.com/explore/note123?xsec_token=abc',
    userText: '看看这个'
  }, {
    lookup: publicLookup,
    request: async (url) => {
      if (url.includes('xhscdn.com')) return response(Buffer.from('image'), 'image/jpeg');
      return response(fixtures.xhs, 'text/html; charset=utf-8');
    },
    visionEnabled: true,
    visionRunner: async (input) => {
      visionCalls.push(input);
      return {
        ok: true,
        visualContext: {
          captionJson: {
            images: input.images.map((_, index) => ({ global_description: `图片${index + 1}内容` })),
            recommended_prompt_context: '三张图展示了草莓蛋糕制作过程。'
          }
        }
      };
    }
  });
  assert.strictEqual(xhs.platform, 'xiaohongshu');
  assert.strictEqual(xhs.contentType, 'note');
  assert.strictEqual(xhs.title, '周末做了草莓蛋糕');
  assert.strictEqual(xhs.author, '小米糕');
  assert.deepStrictEqual(xhs.tags, ['烘焙', '周末']);
  assert.strictEqual(xhs.media.images.length, 4);
  assert.strictEqual(visionCalls.length, 1);
  assert.strictEqual(visionCalls[0].images.length, 3);
  assert.ok(visionCalls[0].images.every((item) => item.url.startsWith('data:image/jpeg;base64,')));
  assert.strictEqual(xhs.imageUnderstanding.length, 3);

  clearSharedLinkCache();
  const song = await readSharedLink({ url: 'https://music.163.com/#/song?id=186016' }, {
    lookup: publicLookup,
    request: async (url) => url.includes('/api/song/lyric')
      ? response(fixtures.lyrics)
      : response(fixtures.song)
  });
  assert.strictEqual(song.platform, 'netease_music');
  assert.strictEqual(song.contentType, 'song');
  assert.strictEqual(song.title, '雨下一整晚');
  assert.strictEqual(song.author, '周杰伦');
  assert.ok(song.body.includes('街灯下的橱窗'));
  assert.ok(!song.body.includes('[00:04.00]'));

  clearSharedLinkCache();
  const playlist = await readSharedLink({ url: 'https://music.163.com/#/playlist?id=3778678' }, {
    lookup: publicLookup,
    request: async () => response(fixtures.playlist)
  });
  assert.strictEqual(playlist.contentType, 'playlist');
  assert.strictEqual(playlist.media.tracks.length, 2);

  clearSharedLinkCache();
  const album = await readSharedLink({ url: 'https://music.163.com/#/album?id=34720827' }, {
    lookup: publicLookup,
    request: async () => response(fixtures.album)
  });
  assert.strictEqual(album.contentType, 'album');
  assert.strictEqual(album.author, '示例歌手');

  clearSharedLinkCache();
  const bilibili = await readSharedLink({ url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2' }, {
    lookup: publicLookup,
    request: async (url) => {
      if (url.includes('/x/web-interface/view')) return response(fixtures.biliView);
      if (url.includes('/x/tag/archive/tags')) return response(fixtures.biliTags);
      if (url.includes('/x/player/v2')) return response(fixtures.biliPlayer);
      if (url.includes('ai_subtitle')) return response(fixtures.biliSubtitle);
      throw new Error(`unexpected URL: ${url}`);
    }
  });
  assert.strictEqual(bilibili.platform, 'bilibili');
  assert.strictEqual(bilibili.title, '测试视频标题');
  assert.strictEqual(bilibili.media.selectedPart.page, 2);
  assert.deepStrictEqual(bilibili.tags, ['音乐', '现场']);
  assert.ok(bilibili.body.includes('今天来分享这段内容'));

  console.log('sharedLinkParsers.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
