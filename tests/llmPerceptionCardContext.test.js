const assert = require('assert');

const { buildLlmPerception } = require('../core/llmPerception');

const inboundContext = {
  cardOnly: true,
  cardContexts: [{
    kind: 'music',
    title: '分享的歌',
    description: '歌手名',
    sourceLabel: '网易云音乐',
    previewImageUrl: 'https://img.example.com/song.jpg',
    primaryUrl: 'https://music.163.com/#/song?id=186016'
  }]
};

const active = buildLlmPerception(inboundContext, {
  enabled: false,
  passive: false
});
assert.match(active.text, /本轮分享卡片/);
assert.match(active.text, /分享的歌/);
assert.match(active.text, /未获得正文证据/);
assert.match(active.text, /简短自然回应/);

const passive = buildLlmPerception(inboundContext, {
  enabled: true,
  passive: true,
  now: new Date('2026-07-26T12:00:00+08:00')
});
assert.ok(!passive.text.includes('本轮分享卡片'));
assert.ok(!passive.text.includes('分享的歌'));

const tooMany = buildLlmPerception({
  cardOnly: true,
  cardContexts: Array.from({ length: 4 }, (_, index) => ({
    kind: 'news',
    title: `新闻 ${index + 1}`,
    description: '',
    sourceLabel: '',
    previewImageUrl: '',
    primaryUrl: `https://example.com/${index + 1}`
  }))
}, {
  enabled: false,
  passive: false
});
assert.match(tooMany.text, /最多 3 张/);

console.log('llmPerceptionCardContext.test.js passed');
