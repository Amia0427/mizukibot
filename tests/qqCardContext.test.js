const assert = require('assert');

const {
  MAX_CARD_CONTEXTS,
  collectMessageContent,
  extractCardContextsFromJsonPayload
} = require('../core/continuousMessage/contentExtraction');

function jsonSegment(payload) {
  return {
    type: 'json',
    data: { data: JSON.stringify(payload) }
  };
}

const newsPayload = {
  app: 'com.tencent.structmsg',
  view: 'news',
  meta: {
    news: {
      title: '一条值得看的新闻',
      desc: '新闻简介',
      tag: '示例新闻',
      preview: 'https://img.example.com/news.jpg',
      jumpUrl: 'https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=333',
      token: 'must-not-leak',
      uin: '10001'
    }
  }
};

const musicPayload = {
  app: 'com.tencent.structmsg',
  view: 'music',
  meta: {
    music: {
      title: '分享的歌',
      desc: '歌手名',
      tag: '网易云音乐',
      preview: 'https://img.example.com/song.jpg',
      musicUrl: 'https://music.163.com/m/song?id=186016&userid=1'
    }
  }
};

const miniappPayload = {
  app: 'com.tencent.miniapp_01',
  view: 'notification',
  meta: {
    notification: {
      title: '实用小程序',
      desc: '小程序简介',
      tag: 'QQ小程序',
      preview: '//img.example.com/miniapp.jpg',
      jumpUrl: 'https://example.com/miniapp?id=1'
    }
  }
};

const invitePayload = {
  app: 'com.tencent.qun.invite',
  view: 'contact',
  prompt: '[邀请你加入群聊]测试群',
  meta: {
    contact: {
      title: '测试群',
      desc: '群聊邀请',
      tag: 'QQ群邀请',
      avatar: 'https://img.example.com/private-avatar.jpg',
      token: 'must-not-leak',
      nick: 'private-nick'
    }
  }
};

assert.deepStrictEqual(extractCardContextsFromJsonPayload(JSON.stringify(newsPayload)), [{
  kind: 'news',
  title: '一条值得看的新闻',
  description: '新闻简介',
  sourceLabel: '示例新闻',
  previewImageUrl: 'https://img.example.com/news.jpg',
  primaryUrl: 'https://www.bilibili.com/video/BV1xx411c7mD'
}]);

assert.deepStrictEqual(extractCardContextsFromJsonPayload(musicPayload), [{
  kind: 'music',
  title: '分享的歌',
  description: '歌手名',
  sourceLabel: '网易云音乐',
  previewImageUrl: 'https://img.example.com/song.jpg',
  primaryUrl: 'https://music.163.com/#/song?id=186016'
}]);

assert.deepStrictEqual(extractCardContextsFromJsonPayload(miniappPayload), [{
  kind: 'miniapp',
  title: '实用小程序',
  description: '小程序简介',
  sourceLabel: 'QQ小程序',
  previewImageUrl: 'https://img.example.com/miniapp.jpg',
  primaryUrl: 'https://example.com/miniapp?id=1'
}]);

assert.deepStrictEqual(extractCardContextsFromJsonPayload(invitePayload), [{
  kind: 'invite',
  title: '测试群',
  description: '群聊邀请',
  sourceLabel: 'QQ群邀请',
  previewImageUrl: '',
  primaryUrl: ''
}]);

assert.deepStrictEqual(extractCardContextsFromJsonPayload('{bad json'), []);
assert.deepStrictEqual(extractCardContextsFromJsonPayload(null), []);

const repeatedCards = collectMessageContent([
  jsonSegment(newsPayload),
  jsonSegment(newsPayload),
  ...Array.from({ length: MAX_CARD_CONTEXTS + 3 }, (_, index) => jsonSegment({
    ...invitePayload,
    meta: {
      contact: {
        ...invitePayload.meta.contact,
        title: `测试群 ${index + 1}`
      }
    }
  }))
]);
assert.strictEqual(repeatedCards.cardContexts.length, MAX_CARD_CONTEXTS);
assert.strictEqual(repeatedCards.cardContexts.filter((card) => card.kind === 'news').length, 1);
assert.ok(!JSON.stringify(repeatedCards.cardContexts).includes('must-not-leak'));
assert.ok(!JSON.stringify(repeatedCards.cardContexts).includes('private-nick'));

console.log('qqCardContext.test.js passed');
