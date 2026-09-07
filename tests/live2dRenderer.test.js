const assert = require('assert');
const { createLive2dRenderer, normalizeRenderResult } = require('../core/live2d/renderer');

assert.deepStrictEqual(normalizeRenderResult(Buffer.from('gif')), {
  ok: true,
  buffer: Buffer.from('gif')
});

const calls = [];
const renderer = createLive2dRenderer({
  config: { LIVE2D_RENDER_ENABLED: true },
  renderAnimation: async (input) => {
    calls.push(input);
    return { buffer: Buffer.from('gif-frame-sequence') };
  }
});

module.exports = (async () => {
  const result = await renderer.render({
    emotion: 'happy',
    intensity: 'high',
    animation: 'happy'
  });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.buffer, Buffer.from('gif-frame-sequence'));
  assert.deepStrictEqual(calls, [{
    emotion: 'happy',
    intensity: 'high',
    animation: 'happy'
  }]);
  assert.strictEqual((await createLive2dRenderer({
    config: { LIVE2D_RENDER_ENABLED: false },
    renderAnimation: async () => Buffer.from('unused')
  }).render({})).code, 'disabled');
  console.log('live2dRenderer.test.js passed');
})();
