const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PromptLoader } = require('../utils/promptLoader');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-loader-'));
  const manifestPath = path.join(root, 'manifest.json');
  const stylePath = path.join(root, 'style.txt');
  const fewShotPath = path.join(root, 'few-shot.json');
  let readCount = 0;
  const readFileSync = (...args) => {
    readCount += 1;
    return fs.readFileSync(...args);
  };

  function writeManifest(version, styleText) {
    fs.writeFileSync(stylePath, styleText, 'utf8');
    fs.writeFileSync(fewShotPath, JSON.stringify({ version: 1, examples: [] }), 'utf8');
    fs.writeFileSync(manifestPath, JSON.stringify({
      version,
      assets: [
        { id: 'persona_style', path: 'style.txt', format: 'text' },
        { id: 'few_shot_index', path: 'few-shot.json', format: 'json' }
      ]
    }), 'utf8');
  }

  try {
    writeManifest('2026-08-17.1', 'style one');
    const loader = new PromptLoader({ manifestPath, readFileSync });
    const initial = loader.initialize();
    const readsAfterInitialize = readCount;

    assert.strictEqual(initial.version, '2026-08-17.1');
    assert.strictEqual(initial.assets.persona_style.text, 'style one');
    assert.deepStrictEqual(initial.assets.few_shot_index.value, { version: 1, examples: [] });
    assert.ok(Object.isFrozen(initial));
    assert.ok(Object.isFrozen(initial.assets));
    assert.strictEqual(loader.getSnapshot(), initial);
    assert.strictEqual(loader.getSnapshot(), initial);
    assert.strictEqual(readCount, readsAfterInitialize, 'snapshot reads must not touch disk');

    const inFlight = Promise.resolve().then(() => ({
      version: initial.version,
      style: initial.assets.persona_style.text
    }));
    writeManifest('2026-08-17.2', 'style two');
    const reloaded = loader.reload();
    const afterReload = loader.getSnapshot();

    assert.strictEqual(reloaded.ok, true);
    assert.strictEqual(afterReload.version, '2026-08-17.2');
    assert.strictEqual(afterReload.assets.persona_style.text, 'style two');
    assert.deepStrictEqual(await inFlight, {
      version: '2026-08-17.1',
      style: 'style one'
    });

    fs.writeFileSync(manifestPath, '{invalid', 'utf8');
    const failed = loader.reload();
    assert.strictEqual(failed.ok, false);
    assert.match(failed.error, /Invalid prompt loader manifest JSON/);
    assert.strictEqual(loader.getSnapshot(), afterReload);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('promptLoader.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
