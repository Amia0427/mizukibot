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
  assert.strictEqual(
    sanitizeUserFacingText('哈？！ （心想：先别让对方看见这段内部判断。）\n真正的回复。'),
    '哈？！ \n真正的回复。',
    'wrapped roleplay reasoning should be stripped from visible text'
  );
  assert.strictEqual(
    sanitizeUserFacingText('(内心OS：这里仍是内部思考)正文'),
    '正文',
    'ascii wrapped roleplay reasoning should be stripped'
  );
  assert.strictEqual(
    sanitizeUserFacingText('心里OS：这里仍是内部思考\n\n正文'),
    '正文',
    'unwrapped roleplay reasoning paragraphs should be stripped'
  );
  assert.strictEqual(
    sanitizeUserFacingText('前缀（心想：流式内容还没有结束'),
    '前缀',
    'unterminated roleplay reasoning should not be streamed'
  );
  assert.strictEqual(
    sanitizeUserFacingText('前缀（内心O'),
    '前缀',
    'partial roleplay reasoning markers should not be streamed'
  );
  assert.strictEqual(
    sanitizeUserFacingText('(心想：内部)', { preserveThink: true }),
    '',
    'preserveThink must not expose roleplay reasoning as user-facing text'
  );
  assert.strictEqual(
    sanitizeUserFacingText('大家常说“内心OS”，但这里没有输出思考块。'),
    '大家常说“内心OS”，但这里没有输出思考块。',
    'ordinary mentions of inner monologue should remain visible'
  );
  assert.strictEqual(
    sanitizeUserFacingText('■ Two pigs, one shoving the other. Reply as Mizuki, 1:45am, casual, no brackets, no emoji, short chunks. --- 哈哈哈这个接得太准了吧'),
    '哈哈哈这个接得太准了吧',
    'reply-as reasoning preambles should be stripped from visible text'
  );
  assert.strictEqual(
    sanitizeUserFacingText('普通讨论 Reply as Mizuki --- 不是模型输出格式。'),
    '普通讨论 Reply as Mizuki --- 不是模型输出格式。',
    'reply-as mentions without role instructions should remain visible'
  );
  assert.strictEqual(
    sanitizeUserFacingText('普通讨论 Reply as   , casual --- 角色为空。'),
    '普通讨论 Reply as   , casual --- 角色为空。',
    'reply-as envelopes with an empty role should remain visible'
  );
  assert.strictEqual(
    sanitizeUserFacingText('普通讨论 Reply as Mizuki,   --- 指令为空。'),
    '普通讨论 Reply as Mizuki,   --- 指令为空。',
    'reply-as envelopes with empty instructions should remain visible'
  );

  console.log('userFacingTextCot.test.js passed');
})();
