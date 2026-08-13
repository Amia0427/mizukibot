const assert = require('assert');
const {
  buildPrivateStatusBarHtml,
  optimizePortraitImageSource,
  normalizeStatusBarData,
  resolvePortraitImageSource,
  selectPortraitImage
} = require('../core/privateStatusBar');
const { validateMarkup } = require('../api/visualRenderService');

module.exports = (async () => {
  const html = buildPrivateStatusBarHtml({
    snapshot: {
      relationship: {
        affection: 67.25,
        stageLabel: '亲近朋友',
        attitude: '<img src=x onerror=alert(1)>'
      },
      character: { mood: -40 }
    },
    text: {
      affection_note: '和你在一起的时间，总是很开心。',
      mood_note: '<img src=x onerror=alert(1)> 就这样静静待着也不错。',
      inner_thought: '<script>alert(1)</script> 你今天还好吗？'
    }
  }, {
    now: new Date('2026-08-11T12:34:56.000Z'),
    timezone: 'Asia/Shanghai'
  });

  assert.ok(html.includes('67.25 / 100'));
  assert.ok(html.includes('2026-08-11 20:34'));
  assert.ok(html.includes('低落'));
  assert.ok(html.includes('和你在一起的时间'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!/<[^>]+\bonerror\s*=/i.test(html));
  assert.ok(html.includes('width:67.25%'));
  assert.ok(html.includes('data-render-image="portrait"'));
  assert.ok(html.includes('晓山瑞希'));
  assert.ok(html.includes('小贴士'));
  assert.ok(html.includes('width:960px'));
  assert.ok(html.includes('height:640px'));
  assert.doesNotThrow(() => validateMarkup(html, 'html'));

  const maximumLengthHtml = buildPrivateStatusBarHtml({
    snapshot: {
      relationship: { attitude: '稳'.repeat(120) }
    },
    text: {
      affection_note: '好'.repeat(80),
      mood_note: '心'.repeat(80),
      inner_thought: '话'.repeat(120)
    }
  });
  assert.ok(maximumLengthHtml.includes(`<p class="model-note text-long">${'好'.repeat(80)}</p>`));
  assert.ok(maximumLengthHtml.includes(`<p class="model-note text-long">${'心'.repeat(80)}</p>`));
  assert.ok(maximumLengthHtml.includes(`<p class="thought-text text-long">${'话'.repeat(120)}</p>`));
  assert.ok(maximumLengthHtml.includes(`<span class="attitude text-long">稳定态度：${'稳'.repeat(120)}</span>`));
  assert.ok(!maximumLengthHtml.includes('line-clamp'));

  const data = normalizeStatusBarData({ snapshot: {} }, { now: new Date(0), timezone: 'UTC' });
  assert.deepStrictEqual(
    { affectionText: data.affectionText, stageLabel: data.stageLabel, mood: data.mood },
    { affectionText: '0', stageLabel: '陌生人', mood: '平静' }
  );
  const portraitImages = JSON.stringify({
    0: 'https://img.example/neutral.png',
    40: 'https://img.example/friendly.png',
    80: 'https://img.example/close.png'
  });
  assert.strictEqual(selectPortraitImage(portraitImages, 67), 'https://img.example/friendly.png');
  assert.strictEqual(selectPortraitImage(portraitImages, 92), 'https://img.example/close.png');
  const localImage = await resolvePortraitImageSource('D:/waifu/zhungtailan.jpg', async (filePath) => {
    assert.strictEqual(filePath, 'D:\\waifu\\zhungtailan.jpg');
    return Buffer.from('jpeg');
  });
  assert.strictEqual(localImage, 'data:image/jpeg;base64,anBlZw==');
  let optimizedInput = null;
  const optimizedImage = await optimizePortraitImageSource(localImage, {
    sharpFactory(buffer) {
      optimizedInput = buffer;
      return {
        rotate() { return this; },
        resize(width, height, options) {
          assert.deepStrictEqual({ width, height, options }, {
            width: 560,
            height: 560,
            options: { fit: 'cover' }
          });
          return this;
        },
        jpeg(options) {
          assert.deepStrictEqual(options, { quality: 88, mozjpeg: true });
          return this;
        },
        async toBuffer() { return Buffer.from('optimized'); }
      };
    }
  });
  assert.strictEqual(optimizedInput.toString(), 'jpeg');
  assert.strictEqual(optimizedImage, 'data:image/jpeg;base64,b3B0aW1pemVk');
  assert.strictEqual(
    await optimizePortraitImageSource('https://img.example/mizuki.png'),
    'https://img.example/mizuki.png'
  );
  console.log('privateStatusBarTemplate.test.js passed');
})();
