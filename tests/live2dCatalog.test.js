const assert = require('assert');
const path = require('path');
const {
  createLive2dCatalog,
  readEmotionManifest
} = require('../core/replyVisual');

const projectRoot = path.resolve('D:/workspace');
const fallbackPath = path.join(projectRoot, 'assets/live2d/fallback/happy.gif');
const fakeFiles = new Set([path.join(projectRoot, 'manifest.json'), fallbackPath]);
const fakeFs = {
  existsSync(filePath) {
    return fakeFiles.has(filePath);
  },
  readFileSync() {
    return '{"happy":{"animation":"happy","fallback":"assets/live2d/fallback/happy.gif"}}';
  }
};

assert.deepStrictEqual(readEmotionManifest('/missing.json', fakeFs), {});
const catalog = createLive2dCatalog({
  config: {
    LIVE2D_EMOTION_MANIFEST: path.join(projectRoot, 'manifest.json'),
    LIVE2D_MODEL_DIR: path.join(projectRoot, 'assets/live2d')
  },
  manifestPath: path.join(projectRoot, 'manifest.json'),
  projectRoot,
  fsImpl: fakeFs
});
assert.deepStrictEqual(catalog.get('happy'), {
  ok: true,
  reason: '',
  emotion: 'happy',
  animation: 'happy',
  fallbackPath,
  modelDir: path.join(projectRoot, 'assets/live2d')
});
assert.strictEqual(catalog.get('neutral').reason, 'missing_mapping');
assert.strictEqual(catalog.get('unknown').reason, 'unsupported_emotion');

console.log('live2dCatalog.test.js passed');
