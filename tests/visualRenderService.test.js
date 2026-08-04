const assert = require('assert');
const sharp = require('sharp');

const {
  MAX_MARKUP_CHARS,
  MAX_OUTPUT_BYTES,
  renderVisual,
  validateMarkup
} = require('../api/visualRenderService');

const enabledConfig = {
  VISUAL_RENDER_ENABLED: true,
  VISUAL_RENDER_HTML_API_URL: 'http://127.0.0.1:6099/plugin/napcat-plugin-puppeteer/api/render',
  VISUAL_RENDER_TIMEOUT_MS: 2500
};

async function createPng(width, height) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  }).png().toBuffer();
}

module.exports = (async () => {
  const svgResult = await renderVisual({
    renderer: 'svg',
    markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect width="400" height="200" fill="#fff"/><text x="20" y="60">safe</text></svg>',
    width: 400,
    max_height: 300
  }, { config: enabledConfig });
  assert.strictEqual(svgResult.renderer, 'svg');
  assert.strictEqual(svgResult.width, 400);
  assert.strictEqual(svgResult.height, 200);
  assert.deepStrictEqual(Array.from(svgResult.buffer.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);

  const unsafeMarkup = [
    ['svg', '<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>'],
    ['svg', '<svg viewBox="0 0 10 10"><foreignObject><div>unsafe</div></foreignObject></svg>'],
    ['svg', '<svg viewBox="0 0 10 10"><image href="https://example.com/a.png"/></svg>'],
    ['svg', '<svg viewBox="0 0 10 10"><rect onclick="alert(1)"/></svg>'],
    ['html', '<svg><foreignObject><div>unsafe</div></foreignObject></svg>'],
    ['html', '<div style="background:url(https://example.com/a.png)">unsafe</div>'],
    ['html', '<iframe src="file:///tmp/a"></iframe>']
  ];
  for (const [renderer, markup] of unsafeMarkup) {
    assert.throws(
      () => validateMarkup(markup, renderer),
      (error) => error?.code === 'unsafe_markup',
      `${renderer} markup should be rejected: ${markup}`
    );
  }

  const htmlPng = await createPng(400, 120);
  const httpCalls = [];
  const htmlResult = await renderVisual({
    renderer: 'html',
    markup: '<section style="padding:20px"><h1>安全卡片</h1></section>',
    width: 400,
    max_height: 300
  }, {
    config: enabledConfig,
    httpClient: {
      async post(url, body, options) {
        httpCalls.push({ url, body, options });
        return { data: { code: 0, data: htmlPng.toString('base64') } };
      }
    }
  });
  assert.strictEqual(htmlResult.renderer, 'html');
  assert.strictEqual(htmlResult.width, 400);
  assert.strictEqual(httpCalls.length, 1);
  assert.strictEqual(httpCalls[0].url, enabledConfig.VISUAL_RENDER_HTML_API_URL);
  assert.strictEqual(httpCalls[0].body.selector, '#render-root');
  assert.strictEqual(httpCalls[0].body.encoding, 'base64');
  assert.deepStrictEqual(httpCalls[0].body.setViewport, {
    width: 400,
    height: 300,
    deviceScaleFactor: 1
  });
  assert.match(httpCalls[0].body.html, /Content-Security-Policy/);
  assert.match(httpCalls[0].body.html, /id="render-root"/);
  assert.strictEqual(httpCalls[0].options.timeout, 2500);

  await assert.rejects(
    renderVisual({
      renderer: 'html',
      markup: '<div>timeout</div>',
      width: 400,
      max_height: 300
    }, {
      config: enabledConfig,
      httpClient: { post: async () => { throw new Error('timeout'); } }
    }),
    (error) => error?.code === 'html_service_unavailable'
  );

  await assert.rejects(
    renderVisual({
      renderer: 'html',
      markup: '<div>broken</div>',
      width: 400,
      max_height: 300
    }, {
      config: enabledConfig,
      httpClient: { post: async () => ({ data: { code: 0, data: 'not-base64***' } }) }
    }),
    (error) => error?.code === 'invalid_html_response'
  );

  const oversizedDimensionsPng = await createPng(401, 200);
  await assert.rejects(
    renderVisual({
      renderer: 'html',
      markup: '<div>too wide</div>',
      width: 400,
      max_height: 300
    }, {
      config: enabledConfig,
      httpClient: { post: async () => ({ data: { code: 0, data: oversizedDimensionsPng.toString('base64') } }) }
    }),
    (error) => error?.code === 'output_dimensions_exceeded'
  );

  const oversizedBytes = Buffer.alloc(MAX_OUTPUT_BYTES + 1);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(oversizedBytes);
  await assert.rejects(
    renderVisual({
      renderer: 'html',
      markup: '<div>too large</div>',
      width: 400,
      max_height: 300
    }, {
      config: enabledConfig,
      httpClient: { post: async () => ({ data: { code: 0, data: oversizedBytes.toString('base64') } }) }
    }),
    (error) => error?.code === 'output_too_large'
  );

  await assert.rejects(
    renderVisual({ renderer: 'svg', markup: 'x'.repeat(MAX_MARKUP_CHARS + 1) }, { config: enabledConfig }),
    (error) => error?.code === 'markup_too_large'
  );
  await assert.rejects(
    renderVisual({ renderer: 'svg', markup: '<svg viewBox="0 0 1 1"/>', width: 319 }, { config: enabledConfig }),
    (error) => error?.code === 'invalid_dimensions'
  );
  await assert.rejects(
    renderVisual({ renderer: 'html', markup: '<div>remote</div>' }, {
      config: { ...enabledConfig, VISUAL_RENDER_HTML_API_URL: 'https://example.com/render' }
    }),
    (error) => error?.code === 'invalid_html_endpoint'
  );
  await assert.rejects(
    renderVisual({ renderer: 'svg', markup: '<svg viewBox="0 0 1 1"/>' }, {
      config: { ...enabledConfig, VISUAL_RENDER_ENABLED: false }
    }),
    (error) => error?.code === 'disabled'
  );

  console.log('visualRenderService.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
