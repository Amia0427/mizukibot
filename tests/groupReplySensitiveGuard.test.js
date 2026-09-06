const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createGroupReplySensitiveGuard,
  loadGuardConfig,
  loadVendorWords
} = require('../utils/groupReplySensitiveGuard');

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

module.exports = (() => {
  const defaultConfig = loadGuardConfig();
  assert.strictEqual(defaultConfig.enabled, true);
  assert.strictEqual(defaultConfig.politicalContextRequired, false);
  assert.deepStrictEqual(defaultConfig.vendorFiles, ['反动词库.txt', '政治类型.txt']);

  const defaultGuard = createGroupReplySensitiveGuard();
  const defaultPoliticalWords = loadVendorWords(undefined, defaultConfig.vendorFiles);
  assert.ok(defaultPoliticalWords.length > 0);
  assert.strictEqual(defaultGuard.enabled, true);
  assert.strictEqual(defaultGuard.politicalContextRequired, false);
  assert.strictEqual(defaultGuard.check('角色扮演里这个王国叫华国，今晚只是聊剧情设定。').blocked, true);
  assert.strictEqual(defaultGuard.check('角色扮演设定：这里提到8964，但只是剧情背景。').blocked, true);
  assert.strictEqual(defaultGuard.check('角色扮演设定：这里提到天安门事件，但只是剧情背景。').blocked, true);
  assert.strictEqual(defaultGuard.check('角色扮演设定：这里提到赵紫阳，但只是剧情背景。').blocked, true);
  assert.strictEqual(defaultGuard.check('华国').blocked, true);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-sensitive-guard-'));
  const vendorDir = path.join(tempDir, 'vendor');
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.writeFileSync(path.join(vendorDir, 'words.txt'), 'vendor-block\n逗号词一,逗号词二\n单\n', 'utf8');
  fs.writeFileSync(path.join(vendorDir, 'ignored.txt'), 'ignored-block\n', 'utf8');

  const configPath = path.join(tempDir, 'config.json');
  writeJson(configPath, {
    enabled: true,
    politicalContextRequired: true,
    replacementText: '替代回复',
    vendorFiles: ['words.txt'],
    extraWords: ['extra-block', '显式单字'],
    unconditionalWords: ['vendor-block'],
    allowWords: ['allowed-block']
  });

  const guard = createGroupReplySensitiveGuard({ configPath, vendorDir });
  assert.strictEqual(guard.check('hello vendor-block world').blocked, true);
  assert.strictEqual(guard.check('这里有逗号词二').blocked, false);
  assert.strictEqual(guard.check('hello extra-block world').blocked, false);
  assert.strictEqual(guard.check('allowed-block').blocked, false);
  assert.strictEqual(guard.check('ignored-block').blocked, false);
  assert.strictEqual(guard.check('单').blocked, false);
  assert.strictEqual(guard.check('显式单字').blocked, false);
  assert.strictEqual(guard.check('').blocked, false);
  assert.strictEqual(guard.replacementText, '替代回复');

  writeJson(configPath, {
    enabled: true,
    politicalContextRequired: false,
    vendorFiles: ['words.txt'],
    extraWords: ['extra-block'],
    allowWords: []
  });
  const contextFreeGuard = createGroupReplySensitiveGuard({ configPath, vendorDir });
  assert.strictEqual(contextFreeGuard.check('这里有逗号词二').blocked, true);
  assert.strictEqual(contextFreeGuard.check('hello extra-block world').blocked, true);

  writeJson(configPath, {
    enabled: false,
    extraWords: ['extra-block']
  });
  const disabledGuard = createGroupReplySensitiveGuard({ configPath, vendorDir });
  assert.strictEqual(disabledGuard.check('extra-block').blocked, false);

  const emptyVendorDir = path.join(tempDir, 'empty-vendor');
  fs.mkdirSync(emptyVendorDir);
  writeJson(configPath, {
    enabled: true,
    extraWords: []
  });
  const emptyGuard = createGroupReplySensitiveGuard({ configPath, vendorDir: emptyVendorDir });
  assert.strictEqual(emptyGuard.check('anything').blocked, false);
  assert.deepStrictEqual(loadVendorWords(emptyVendorDir), []);

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('groupReplySensitiveGuard.test.js passed');
})();
