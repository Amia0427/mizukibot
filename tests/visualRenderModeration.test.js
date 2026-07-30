const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  extractVisibleMarkupText,
  resetVisualRenderModerationCache,
  reviewVisualRenderContent
} = require('../utils/visualRenderModeration');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-visual-moderation-'));
const vendorDir = path.join(tempRoot, 'Vocabulary');
const configPath = path.join(tempRoot, 'visual-render-sensitive-words.json');
fs.mkdirSync(vendorDir, { recursive: true });
fs.writeFileSync(path.join(vendorDir, '政治类型.txt'), 'fixture-sensitive-term\n', 'utf8');
fs.writeFileSync(configPath, JSON.stringify({
  enabled: true,
  politicalContextRequired: false,
  replacementText: 'blocked',
  vendorFiles: ['政治类型.txt'],
  extraWords: [],
  allowWords: []
}), 'utf8');

function review(input, overrides = {}) {
  resetVisualRenderModerationCache();
  return reviewVisualRenderContent(input, {
    configPath,
    vendorDir,
    reload: true,
    ...overrides
  });
}

const allowed = review({
  prompt: '请制作一张安全的信息卡',
  renderer: 'html',
  markup: '<style>.hidden{content:"fixture-sensitive-term"}</style><div>安全文本</div>'
});
assert.strictEqual(allowed.allowed, true);
assert.strictEqual(allowed.visibleText, '安全文本');

const promptBlocked = review({
  prompt: '请显示 fixture-sensitive-term',
  renderer: 'html',
  markup: '<div>安全文本</div>'
});
assert.strictEqual(promptBlocked.allowed, false);
assert.strictEqual(promptBlocked.stage, 'user_prompt');
assert.strictEqual(promptBlocked.matchedCount, 1);
assert.deepStrictEqual(promptBlocked.categories, ['political']);
assert.strictEqual(promptBlocked.replacementText, 'blocked');

const markupBlocked = review({
  prompt: '请制作一张信息卡',
  renderer: 'svg',
  markup: '<svg viewBox="0 0 100 100"><text>fixture-sensitive-term</text></svg>'
});
assert.strictEqual(markupBlocked.allowed, false);
assert.strictEqual(markupBlocked.stage, 'visible_text');
assert.strictEqual(markupBlocked.matchedCount, 1);
assert.deepStrictEqual(markupBlocked.categories, ['political']);

const noPrompt = review({
  prompt: '',
  renderer: 'html',
  markup: '<div>safe</div>'
});
assert.strictEqual(noPrompt.allowed, false);
assert.strictEqual(noPrompt.reason, 'prompt_unavailable');

const missingConfig = review({
  prompt: 'safe',
  renderer: 'html',
  markup: '<div>safe</div>'
}, { configPath: path.join(tempRoot, 'missing.json') });
assert.strictEqual(missingConfig.allowed, false);
assert.strictEqual(missingConfig.reason, 'moderation_unavailable');

const invalidConfigPath = path.join(tempRoot, 'invalid.json');
fs.writeFileSync(invalidConfigPath, '{', 'utf8');
const invalidConfig = review({
  prompt: 'safe',
  renderer: 'html',
  markup: '<div>safe</div>'
}, { configPath: invalidConfigPath });
assert.strictEqual(invalidConfig.allowed, false);
assert.strictEqual(invalidConfig.reason, 'moderation_unavailable');

const emptyConfigPath = path.join(tempRoot, 'empty.json');
fs.writeFileSync(emptyConfigPath, JSON.stringify({
  enabled: true,
  politicalContextRequired: false,
  vendorFiles: ['missing-vendor-file.txt']
}), 'utf8');
const missingVocabulary = review({
  prompt: 'safe',
  renderer: 'html',
  markup: '<div>safe</div>'
}, { configPath: emptyConfigPath });
assert.strictEqual(missingVocabulary.allowed, false);
assert.strictEqual(missingVocabulary.reason, 'moderation_unavailable');

const disabledConfigPath = path.join(tempRoot, 'disabled.json');
fs.writeFileSync(disabledConfigPath, JSON.stringify({
  enabled: false,
  vendorFiles: ['政治类型.txt']
}), 'utf8');
const disabledModeration = review({
  prompt: 'safe',
  renderer: 'html',
  markup: '<div>safe</div>'
}, { configPath: disabledConfigPath });
assert.strictEqual(disabledModeration.allowed, false);
assert.strictEqual(disabledModeration.reason, 'moderation_unavailable');

assert.strictEqual(
  extractVisibleMarkupText('<svg viewBox="0 0 10 10"><title>标题</title><desc>说明</desc><text>正文</text><path d="M0 0"/></svg>', 'svg'),
  '标题说明正文'
);

console.log('visualRenderModeration.test.js passed');
