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

  console.log('userFacingTextCot.test.js passed');
})();
