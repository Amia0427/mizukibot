const assert = require('assert');
const {
  buildPrivateStatusBarHtml,
  normalizeStatusBarData
} = require('../core/privateStatusBar');
const { validateMarkup } = require('../api/visualRenderService');

module.exports = (() => {
  const html = buildPrivateStatusBarHtml({
    snapshot: {
      relationship: {
        affection: 67.25,
        stageLabel: '亲近朋友',
        attitude: '<img src=x onerror=alert(1)>'
      },
      character: { mood: -40 }
    },
    innerThought: '<script>alert(1)</script> 你今天还好吗？'
  }, {
    now: new Date('2026-08-11T12:34:56.000Z'),
    timezone: 'Asia/Shanghai'
  });

  assert.ok(html.includes('67.25 / 100'));
  assert.ok(html.includes('2026-08-11 20:34'));
  assert.ok(html.includes('低落'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!/<[^>]+\bonerror\s*=/i.test(html));
  assert.ok(html.includes('width:67.25%'));
  assert.doesNotThrow(() => validateMarkup(html, 'html'));

  const data = normalizeStatusBarData({ snapshot: {} }, { now: new Date(0), timezone: 'UTC' });
  assert.deepStrictEqual(
    { affectionText: data.affectionText, stageLabel: data.stageLabel, mood: data.mood },
    { affectionText: '0', stageLabel: '陌生人', mood: '平静' }
  );
  console.log('privateStatusBarTemplate.test.js passed');
})();
