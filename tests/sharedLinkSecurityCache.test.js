const assert = require('assert');

const {
  clearSharedLinkCache,
  readSharedLink
} = require('../api/skills_native/sharedLink');

const publicAddress = [{ address: '93.184.216.34', family: 4 }];

function songResponse() {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    data: {
      code: 200,
      songs: [{ id: 186016, name: '测试歌曲', ar: [{ name: '测试歌手' }], al: { name: '测试专辑' }, dt: 1000 }]
    }
  };
}

module.exports = (async () => {
  clearSharedLinkCache();
  let unsafeRequestCalled = false;
  const unsafe = await readSharedLink({ url: 'http://127.0.0.1/song?id=1' }, {
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    request: async () => {
      unsafeRequestCalled = true;
      return songResponse();
    }
  });
  assert.strictEqual(unsafe.completeness, 'unavailable');
  assert.strictEqual(unsafe.failureCode, 'UNSUPPORTED_URL');
  assert.strictEqual(unsafeRequestCalled, false);

  clearSharedLinkCache();
  const redirectCalls = [];
  const redirected = await readSharedLink({ url: 'https://b23.tv/short' }, {
    lookup: async (hostname) => hostname === 'b23.tv'
      ? publicAddress
      : [{ address: '10.0.0.8', family: 4 }],
    request: async (url) => {
      redirectCalls.push(url);
      return { status: 302, headers: { location: 'http://internal.test/private' }, data: '' };
    }
  });
  assert.strictEqual(redirected.completeness, 'unavailable');
  assert.strictEqual(redirected.failureCode, 'NETWORK_BLOCKED');
  assert.deepStrictEqual(redirectCalls, ['https://b23.tv/short']);

  clearSharedLinkCache();
  const cookieHeaders = [];
  await readSharedLink({ url: 'https://xhslink.com/a/short' }, {
    lookup: async () => publicAddress,
    xhsCookie: 'a=b',
    request: async (url, options) => {
      cookieHeaders.push({ url, cookie: options.headers.Cookie || options.headers.cookie || '' });
      if (url.includes('xhslink.com')) {
        return {
          status: 302,
          headers: { location: 'https://www.xiaohongshu.com/explore/note123' },
          data: ''
        };
      }
      return {
        status: 200,
        headers: { 'content-type': 'text/html' },
        data: '<meta property="og:title" content="cookie test"><meta property="og:description" content="正文">'
      };
    },
    visionEnabled: false
  });
  assert.strictEqual(cookieHeaders[0].cookie, '');
  assert.strictEqual(cookieHeaders[1].cookie, 'a=b');

  clearSharedLinkCache();
  let requestCount = 0;
  const sharedOptions = {
    lookup: async () => publicAddress,
    request: async (url) => {
      requestCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (url.includes('/api/song/lyric')) {
        return { status: 200, headers: {}, data: { code: 200, lrc: { lyric: '' } } };
      }
      return songResponse();
    }
  };
  const [first, second] = await Promise.all([
    readSharedLink({ url: 'https://music.163.com/#/song?id=186016' }, sharedOptions),
    readSharedLink({ url: 'https://music.163.com/#/song?id=186016' }, sharedOptions)
  ]);
  assert.strictEqual(first.title, '测试歌曲');
  assert.strictEqual(second.title, '测试歌曲');
  assert.strictEqual(requestCount, 2, '同一链接的两个并发读取应共享同一组详情和歌词请求');
  await readSharedLink({ url: 'https://music.163.com/#/song?id=186016' }, sharedOptions);
  assert.strictEqual(requestCount, 2, '成功结果应命中进程内缓存');

  clearSharedLinkCache();
  const oversized = await readSharedLink({ url: 'https://music.163.com/#/song?id=186016' }, {
    lookup: async () => publicAddress,
    maxResponseBytes: 32,
    request: async () => songResponse()
  });
  assert.strictEqual(oversized.completeness, 'unavailable');
  assert.strictEqual(oversized.failureCode, 'RESPONSE_TOO_LARGE');

  clearSharedLinkCache();
  let clock = 0;
  let failureRequests = 0;
  const failureOptions = {
    now: () => clock,
    lookup: async () => publicAddress,
    request: async () => {
      failureRequests += 1;
      const error = new Error('not found');
      error.response = { status: 404 };
      throw error;
    }
  };
  await readSharedLink({ url: 'https://music.163.com/#/playlist?id=999999' }, failureOptions);
  clock = 29000;
  await readSharedLink({ url: 'https://music.163.com/#/playlist?id=999999' }, failureOptions);
  assert.strictEqual(failureRequests, 1, '失败结果应缓存30秒');
  clock = 31000;
  await readSharedLink({ url: 'https://music.163.com/#/playlist?id=999999' }, failureOptions);
  assert.strictEqual(failureRequests, 2, '失败缓存超过30秒后应重新请求');

  console.log('sharedLinkSecurityCache.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
