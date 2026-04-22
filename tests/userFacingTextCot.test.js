const assert = require('assert');

const { sanitizeUserFacingText } = require('../utils/userFacingText');

module.exports = (() => {
  const raw = '前缀<think>secret reasoning</think>后缀';
  assert.strictEqual(sanitizeUserFacingText(raw), '前缀后缀');
  assert.strictEqual(
    sanitizeUserFacingText(raw, { preserveThink: true }),
    raw,
    'preserveThink should keep think blocks intact'
  );
  assert.strictEqual(
    sanitizeUserFacingText('我能不能不回答这个...\n\n笑着转开，话题一跳：诶你怎么突然问这个呀，是在群里看到什么梗吗？'),
    '我能不能不回答这个...\n\n诶你怎么突然问这个呀，是在群里看到什么梗吗？',
    'narrative lead-ins should be stripped from user-facing text'
  );
  assert.strictEqual(
    sanitizeUserFacingText('注意：这个要明天再试。'),
    '注意：这个要明天再试。',
    'ordinary colon-prefixed text should stay intact'
  );

  console.log('userFacingTextCot.test.js passed');
})();
