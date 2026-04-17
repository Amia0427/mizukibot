const assert = require('assert');

const nativePpt = require('../api/skills_native/ppt');
const nativeImage = require('../api/skills_native/imageGenerate');

module.exports = (async () => {
  const oldBaidu = process.env.BAIDU_API_KEY;
  const oldGemini = process.env.GEMINI_API_KEY;

  delete process.env.BAIDU_API_KEY;
  delete process.env.GEMINI_API_KEY;

  const pptList = await nativePpt.listThemes();
  assert.ok(String(pptList).includes('BAIDU_API_KEY') || String(pptList).includes('not configured'));

  const pptGen = await nativePpt.generatePpt({ query: 'AI report' });
  assert.ok(String(pptGen).includes('BAIDU_API_KEY') || String(pptGen).includes('not configured'));

  const imageGen = await nativeImage.generateImage({ prompt: 'a cat' }, 'D:\\waifu\\data');
  assert.ok(String(imageGen).includes('GEMINI_API_KEY') || String(imageGen).includes('unavailable'));

  if (oldBaidu !== undefined) process.env.BAIDU_API_KEY = oldBaidu;
  if (oldGemini !== undefined) process.env.GEMINI_API_KEY = oldGemini;

  console.log('nativePptImage.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
