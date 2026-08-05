const assert = require('assert');
const sharp = require('sharp');
const {
  constrainPng,
  renderAndSendChart,
  shouldSendChartImage
} = require('../src/features/pjsk/renderer');

module.exports = (async () => {
  assert.strictEqual(shouldSendChartImage({ chatType: 'private', userId: 'u' }), true);
  assert.strictEqual(shouldSendChartImage({ chatType: 'group', groupId: 'g' }, '分析谱面'), false);
  assert.strictEqual(shouldSendChartImage({ chatType: 'group', groupId: 'g' }, '发谱面图'), true);
  const png = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#ffffff' } }).png().toBuffer();
  const constrained = await constrainPng(png);
  assert.strictEqual(constrained.width, 32);
  assert.strictEqual(constrained.height, 24);

  let sent = 0;
  const result = await renderAndSendChart({
    chart: { title: 'Test', difficulty: 'master', level: 30 },
    sus: 'trusted',
    context: { chatType: 'private', userId: 'u', question: '分析 PJSK Test MASTER 谱' }
  }, {
    reviewContent: () => ({ allowed: true }),
    renderChartImage: async () => ({ buffer: png, width: 32, height: 24 }),
    sendImage: async () => { sent += 1; return { messageId: 123 }; }
  });
  assert.strictEqual(result.status, 'sent');
  assert.strictEqual(sent, 1);

  const degraded = await renderAndSendChart({
    chart: { title: 'Test', difficulty: 'master', level: 30 },
    sus: 'trusted',
    context: { chatType: 'private', userId: 'u', question: '分析 PJSK Test MASTER 谱' }
  }, {
    reviewContent: () => ({ allowed: true }),
    renderChartImage: async () => { throw new Error('render failed'); }
  });
  assert.strictEqual(degraded.status, 'render_failed');
  console.log('pjskRenderer.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
