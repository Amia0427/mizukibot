const assert = require('assert');

const { renderWeixinQrPng } = require('../src/platforms/weixin/qr');

module.exports = (async () => {
  const png = await renderWeixinQrPng('opaque-ilink-qr-content');
  assert.strictEqual(png.subarray(1, 4).toString('ascii'), 'PNG');

  const direct = await renderWeixinQrPng(`data:image/png;base64,${png.toString('base64')}`);
  assert.deepStrictEqual(direct, png);
  await assert.rejects(renderWeixinQrPng(''), /content is required/);

  console.log('weixinQr.test.js passed');
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
