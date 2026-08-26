const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const imageGeneration = require('../api/imageGeneration');
const originalDraw = imageGeneration.drawBotDiaryQzonePicture;
const oldProviderKey = process.env.BOT_DIARY_QZONE_IMAGE_PROVIDER_API_KEY;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizukibot-image-'));

process.env.BOT_DIARY_QZONE_IMAGE_PROVIDER_API_KEY = 'test-image-key';
imageGeneration.drawBotDiaryQzonePicture = async () => 'data:image/png;base64,aW1n';

delete require.cache[require.resolve('../api/skills_native/imageGenerate')];
const nativeImage = require('../api/skills_native/imageGenerate');

nativeImage.generateImage({ prompt: 'draw a square', filename: 'test-output' }, tempDir)
  .then((result) => {
    const payload = JSON.parse(result);
    assert.strictEqual(fs.readFileSync(payload.output_path, 'utf8'), 'img');
    assert.ok(payload.output_path.endsWith('test-output.png'));
    console.log('imageGenerate.test.js passed');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    imageGeneration.drawBotDiaryQzonePicture = originalDraw;
    if (oldProviderKey === undefined) delete process.env.BOT_DIARY_QZONE_IMAGE_PROVIDER_API_KEY;
    else process.env.BOT_DIARY_QZONE_IMAGE_PROVIDER_API_KEY = oldProviderKey;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
