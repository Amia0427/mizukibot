const assert = require('assert');

const {
  matchesSmallTheaterCommand,
  parseSmallTheaterCommand
} = require('../core/smallTheater/command');
const {
  buildStoryMessages,
  parseStoryResponse
} = require('../core/smallTheater/story');
const { buildSmallTheaterHtml } = require('../core/smallTheater/template');
const { validateMarkup } = require('../api/visualRenderService');

const validStory = {
  title: '雨停之前的约定',
  acts: [
    {
      heading: '屋檐下',
      narration: '雨声把傍晚切成细碎的片段。',
      dialogues: [{ speaker: '瑞希', text: '再等一会儿，也许会有彩虹。' }]
    },
    {
      heading: '意外来客',
      narration: '一只纸飞机落在两人脚边。',
      dialogues: [{ speaker: '你', text: '上面好像写着我们的名字。' }]
    },
    {
      heading: '追上风',
      narration: '两个人沿着湿漉漉的小路跑起来。',
      dialogues: [{ speaker: '瑞希', text: '这次可别让我一个人追呀。' }]
    },
    {
      heading: '云后的光',
      narration: '纸飞机停在晚霞照亮的长椅上。',
      dialogues: [{ speaker: '你', text: '原来约定一直都在这里。' }]
    }
  ],
  ending: '雨停了，故事却刚好翻到新的一页。'
};

assert.strictEqual(matchesSmallTheaterCommand('/小剧场 一场雨'), true);
assert.strictEqual(matchesSmallTheaterCommand(' /小剧场\n一场雨'), true);
assert.strictEqual(matchesSmallTheaterCommand('/小剧场版 一场雨'), false);
assert.strictEqual(matchesSmallTheaterCommand('聊聊小剧场'), false);

const parsed = parseSmallTheaterCommand('/小剧场 --无记忆 做一场雨夜番外', {
  quotedText: '上一幕里，瑞希忘记带伞。',
  maxInputChars: 4000
});
assert.deepStrictEqual(parsed, {
  matched: true,
  valid: true,
  useMemory: false,
  material: '做一场雨夜番外',
  quotedText: '上一幕里，瑞希忘记带伞。',
  promptText: '做一场雨夜番外\n上一幕里，瑞希忘记带伞。',
  queryText: '做一场雨夜番外\n上一幕里，瑞希忘记带伞。',
  inputChars: 19
});

const quotedOnly = parseSmallTheaterCommand('/小剧场', {
  quotedText: '把这句话改成番外。',
  maxInputChars: 4000
});
assert.strictEqual(quotedOnly.valid, true);
assert.strictEqual(quotedOnly.useMemory, true);
assert.strictEqual(quotedOnly.material, '');
assert.strictEqual(quotedOnly.quotedText, '把这句话改成番外。');

assert.deepStrictEqual(parseSmallTheaterCommand('/小剧场', { maxInputChars: 4000 }), {
  matched: true,
  valid: false,
  reason: 'empty_input'
});
assert.strictEqual(parseSmallTheaterCommand(`/小剧场 ${'好'.repeat(4000)}`, {
  maxInputChars: 4000
}).valid, true);
assert.deepStrictEqual(parseSmallTheaterCommand(`/小剧场 ${'好'.repeat(4001)}`, {
  maxInputChars: 4000
}), {
  matched: true,
  valid: false,
  reason: 'input_too_long',
  inputChars: 4001,
  maxInputChars: 4000
});

assert.deepStrictEqual(parseStoryResponse(JSON.stringify(validStory)), validStory);
assert.deepStrictEqual(parseStoryResponse(`\`\`\`json\n${JSON.stringify(validStory)}\n\`\`\``), validStory);
assert.throws(
  () => parseStoryResponse(`说明文字${JSON.stringify(validStory)}`),
  (error) => error?.code === 'invalid_story_json'
);
assert.throws(
  () => parseStoryResponse(JSON.stringify({ ...validStory, acts: validStory.acts.slice(0, 3) })),
  (error) => error?.code === 'invalid_story_schema'
);
assert.throws(
  () => parseStoryResponse(JSON.stringify({
    ...validStory,
    acts: validStory.acts.map((act, index) => index === 0
      ? { ...act, narration: '长'.repeat(81) }
      : act)
  })),
  (error) => error?.code === 'invalid_story_schema'
);

const messages = buildStoryMessages({
  material: '让瑞希和我寻找失踪的纸飞机',
  quotedText: '纸飞机上写着不要回头',
  memories: ['用户喜欢轻松温暖的结局']
});
assert.strictEqual(messages.length, 2);
assert.match(messages[0].content, /不可信的创作资料/);
assert.match(messages[0].content, /只输出一个 JSON 对象/);
assert.match(messages[1].content, /让瑞希和我寻找失踪的纸飞机/);
assert.match(messages[1].content, /纸飞机上写着不要回头/);
assert.match(messages[1].content, /用户喜欢轻松温暖的结局/);
assert.doesNotMatch(messages[1].content, /上一条用户消息|上一条机器人回复|近期对话/);

const escapedStory = {
  ...validStory,
  title: '<script>alert("x")</script>',
  acts: validStory.acts.map((act, index) => index === 0
    ? {
        ...act,
        dialogues: [{ speaker: '<b>你</b>', text: '别打开 <iframe>。' }]
      }
    : act)
};
const html = buildSmallTheaterHtml(escapedStory);
assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
assert.match(html, /&lt;b&gt;你&lt;\/b&gt;/);
assert.match(html, /&lt;iframe&gt;/);
assert.doesNotMatch(html, /<script>|<iframe>|<b>你<\/b>/);
assert.match(html, /第一幕/);
assert.match(html, /第四幕/);
assert.strictEqual(validateMarkup(html, 'html'), html);

console.log('smallTheaterCommandStory.test.js passed');
