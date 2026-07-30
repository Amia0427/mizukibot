const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createSmallTheaterRuntime } = require('../core/smallTheater');
const {
  resetVisualRenderModerationCache,
  reviewVisualRenderContent
} = require('../utils/visualRenderModeration');

const baseStory = {
  title: '雨后的纸飞机',
  acts: [1, 2, 3, 4].map((number) => ({
    heading: `场景${number}`,
    narration: `第${number}幕安全旁白。`,
    dialogues: [{ speaker: number % 2 ? '瑞希' : '你', text: `第${number}幕安全对白。` }]
  })),
  ending: '晚霞替这一天收好了尾。'
};

function createFixtureGuard(configPath, vendorDir) {
  return (input) => {
    resetVisualRenderModerationCache();
    return reviewVisualRenderContent(input, {
      configPath,
      vendorDir,
      reload: true
    });
  };
}

function createRuntime({ reviewContent, story = baseStory }) {
  const calls = { memory: 0, model: 0, render: 0, send: 0 };
  const runtime = createSmallTheaterRuntime({
    config: {
      SMALL_THEATER_ENABLED: true,
      SMALL_THEATER_MAX_INPUT_CHARS: 4000,
      SMALL_THEATER_MEMORY_TOP_K: 8,
      SMALL_THEATER_MODEL_TIMEOUT_MS: 60000,
      SMALL_THEATER_COOLDOWN_MS: 15000,
      SMALL_THEATER_FAILURE_RETRY_COOLDOWN_MS: 5000,
      SMALL_THEATER_MAX_CONCURRENCY: 2
    },
    reviewContent,
    logEvent() {},
    async queryMemory() {
      calls.memory += 1;
      return { results: [] };
    },
    async requestAssistantMessage() {
      calls.model += 1;
      return { role: 'assistant', content: JSON.stringify(story) };
    },
    async renderVisual() {
      calls.render += 1;
      return { buffer: Buffer.from('png') };
    },
    async sendImage() {
      calls.send += 1;
      return { success: true, messageId: 'fixture-message' };
    }
  });
  return { calls, runtime };
}

module.exports = (async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-small-theater-moderation-'));
  const vendorDir = path.join(tempRoot, 'Vocabulary');
  const configPath = path.join(tempRoot, 'visual-render-sensitive-words.json');
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.writeFileSync(path.join(vendorDir, '政治类型.txt'), 'fixture-sensitive-term\n', 'utf8');
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    politicalContextRequired: false,
    replacementText: 'blocked-by-fixture',
    vendorFiles: ['政治类型.txt'],
    extraWords: [],
    allowWords: []
  }), 'utf8');

  const fixtureGuard = createFixtureGuard(configPath, vendorDir);
  const promptGate = createRuntime({ reviewContent: fixtureGuard });
  const promptResult = await promptGate.runtime.handle({
    rawText: '/小剧场 fixture-sensitive-term',
    userId: 'fixture-prompt-user',
    chatType: 'private'
  });
  assert.strictEqual(promptResult.code, 'content_blocked');
  assert.strictEqual(promptResult.replyText, 'blocked-by-fixture');
  assert.deepStrictEqual(promptGate.calls, { memory: 0, model: 0, render: 0, send: 0 });

  const unsafeStory = {
    ...baseStory,
    acts: baseStory.acts.map((act, index) => index === 2
      ? { ...act, narration: '这里出现 fixture-sensitive-term。' }
      : act)
  };
  const outputGate = createRuntime({ reviewContent: fixtureGuard, story: unsafeStory });
  const outputResult = await outputGate.runtime.handle({
    rawText: '/小剧场 安全的测试素材',
    userId: 'fixture-output-user',
    chatType: 'private'
  });
  assert.strictEqual(outputResult.code, 'content_blocked');
  assert.deepStrictEqual(outputGate.calls, { memory: 1, model: 1, render: 0, send: 0 });

  const unavailableGate = createRuntime({
    reviewContent: createFixtureGuard(path.join(tempRoot, 'missing.json'), vendorDir)
  });
  const unavailableResult = await unavailableGate.runtime.handle({
    rawText: '/小剧场 安全的测试素材',
    userId: 'fixture-missing-user',
    chatType: 'private'
  });
  assert.strictEqual(unavailableResult.code, 'content_blocked');
  assert.deepStrictEqual(unavailableGate.calls, { memory: 0, model: 0, render: 0, send: 0 });

  console.log('smallTheaterModerationGate.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
