const assert = require('assert');

const { sanitizeUserFacingText } = require('../utils/userFacingText');

module.exports = (() => {
  const raw = '前缀<think>secret reasoning</think>后缀';
  const rawThinking = '前缀<thinking>secret reasoning</thinking>后缀';
  assert.strictEqual(sanitizeUserFacingText(raw), '前缀后缀');
  assert.strictEqual(sanitizeUserFacingText(rawThinking), '前缀后缀');
  assert.strictEqual(
    sanitizeUserFacingText(raw, { preserveThink: true }),
    raw,
    'preserveThink should keep think blocks intact'
  );
  assert.strictEqual(
    sanitizeUserFacingText(rawThinking, { preserveThink: true }),
    rawThinking,
    'preserveThink should keep thinking blocks intact'
  );
  assert.strictEqual(
    sanitizeUserFacingText('前缀<thinking>secret reasoning'),
    '前缀',
    'unterminated thinking blocks should be stripped'
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
  assert.strictEqual(
    sanitizeUserFacingText('前缀\nreasoning_content: 这里是内部推理\ninternal_check=先检查现场\n后缀'),
    '前缀\n\n\n后缀',
    'reasoning_content and internal_check leaks should be stripped'
  );
  assert.strictEqual(
    sanitizeUserFacingText('[RoleplayInnerProtocol]\nsurface: private chat\nmizuki_motive: assistant-like draft\n\n诶，先别急，我接着说。'),
    '诶，先别急，我接着说。',
    'roleplay inner protocol leak blocks should be stripped'
  );

  console.log('userFacingTextCot.test.js passed');
})();
