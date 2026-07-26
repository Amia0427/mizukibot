const assert = require('assert');
const http = require('http');
const axios = require('axios');

const {
  createPinnedLookup,
  requestSafeHttpUrl
} = require('../utils/networkSafety');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

(async () => {
  const requestedPaths = [];
  const server = http.createServer((request, response) => {
    requestedPaths.push(request.url);
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: 'http://internal.test/secret' });
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('pinned');
  });
  const port = await listen(server);

  try {
    const pinnedResponse = await axios.get(`http://pinned.test:${port}/pinned`, {
      lookup: createPinnedLookup([{ address: '127.0.0.1', family: 4 }]),
      maxRedirects: 0,
      proxy: false,
      responseType: 'text'
    });
    assert.strictEqual(pinnedResponse.data, 'pinned');
    assert.deepStrictEqual(requestedPaths, ['/pinned']);

    let requestCount = 0;
    await assert.rejects(
      () => requestSafeHttpUrl('http://public.test/redirect', {
        lookup: async (hostname) => hostname === 'public.test'
          ? [{ address: '93.184.216.34', family: 4 }]
          : [{ address: '127.0.0.1', family: 4 }],
        request: async (_url, requestOptions) => {
          requestCount += 1;
          return axios.get(`http://127.0.0.1:${port}/redirect`, {
            ...requestOptions,
            lookup: undefined
          });
        }
      }),
      /disallowed/
    );
    assert.strictEqual(requestCount, 1);
    assert.deepStrictEqual(requestedPaths, ['/pinned', '/redirect']);
  } finally {
    await close(server);
  }

  console.log('networkSafetyHttpIntegration.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
