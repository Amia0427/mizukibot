const assert = require('assert');

const { createSmallTheaterRuntime } = require('../core/smallTheater');

const story = {
  title: '纸飞机的秘密',
  acts: [1, 2, 3, 4].map((number) => ({
    heading: `第${number}个场景`,
    narration: `这是第${number}幕的旁白。`,
    dialogues: [{ speaker: number % 2 ? '瑞希' : '你', text: `这是第${number}幕的对白。` }]
  })),
  ending: '风把秘密留在了晚霞里。'
};

function createHarness(overrides = {}) {
  const calls = {
    memory: [],
    model: [],
    moderation: [],
    render: [],
    send: [],
    logs: []
  };
  const clock = { now: 1000 };
  const config = {
    SMALL_THEATER_ENABLED: true,
    SMALL_THEATER_MAX_INPUT_CHARS: 4000,
    SMALL_THEATER_MEMORY_TOP_K: 8,
    SMALL_THEATER_MODEL_TIMEOUT_MS: 60000,
    SMALL_THEATER_COOLDOWN_MS: 15000,
    SMALL_THEATER_FAILURE_RETRY_COOLDOWN_MS: 5000,
    SMALL_THEATER_MAX_CONCURRENCY: 2,
    ...overrides.config
  };
  const deps = {
    config,
    now: () => clock.now,
    logEvent(stage, payload) {
      calls.logs.push({ stage, payload });
    },
    async queryMemory(input) {
      calls.memory.push(input);
      if (overrides.queryMemory) return overrides.queryMemory(input);
      return {
        results: [
          { source: 'personal', text: 'private-memory-marker' },
          { source: 'recent', text: 'recent-conversation-marker' },
          { source: 'group', text: 'group-memory-marker' },
          { source: 'jargon', text: 'group-jargon-marker' }
        ]
      };
    },
    async requestAssistantMessage(messages, options) {
      calls.model.push({ messages, options });
      if (overrides.requestAssistantMessage) {
        return overrides.requestAssistantMessage(messages, options);
      }
      return { role: 'assistant', content: JSON.stringify(story) };
    },
    reviewContent(input) {
      calls.moderation.push(input);
      if (overrides.reviewContent) return overrides.reviewContent(input, calls.moderation.length);
      return { allowed: true, visibleText: 'safe' };
    },
    async renderVisual(input) {
      calls.render.push(input);
      if (overrides.renderVisual) return overrides.renderVisual(input);
      return { buffer: Buffer.from('png'), renderer: 'html', width: 900, height: 1400 };
    },
    async sendImage(context, buffer) {
      calls.send.push({ context, buffer });
      if (overrides.sendImage) return overrides.sendImage(context, buffer);
      return { success: true, messageId: 'message-1' };
    }
  };
  return {
    calls,
    clock,
    runtime: createSmallTheaterRuntime(deps)
  };
}

async function assertFailureCooldown(overrides, expectedStage, userId) {
  const harness = createHarness(overrides);
  const first = await harness.runtime.handle({
    rawText: '/小剧场 第一次失败',
    userId,
    chatType: 'private'
  });
  assert.strictEqual(first.code, 'generation_failed');

  harness.clock.now += 4999;
  const coolingDown = await harness.runtime.handle({
    rawText: '/小剧场 立即重试',
    userId,
    chatType: 'private'
  });
  assert.strictEqual(coolingDown.code, 'cooldown');

  harness.clock.now += 1;
  const retried = await harness.runtime.handle({
    rawText: '/小剧场 五秒后重试',
    userId,
    chatType: 'private'
  });
  assert.strictEqual(retried.code, 'generation_failed');
  assert.deepStrictEqual(
    harness.calls.logs
      .filter(({ stage }) => stage === 'failed')
      .map(({ payload }) => payload.stage),
    [expectedStage, expectedStage]
  );
}

module.exports = (async () => {
  const privateHarness = createHarness();
  const privateResult = await privateHarness.runtime.handle({
    rawText: '/小剧场 让瑞希和我追一架纸飞机',
    quotedText: '纸飞机从天台飞走了',
    userId: 'user-1',
    chatType: 'private',
    requestId: 'request-1'
  });
  assert.strictEqual(privateResult.handled, true);
  assert.strictEqual(privateResult.ok, true);
  assert.strictEqual(privateResult.messageId, 'message-1');
  assert.strictEqual(privateHarness.calls.memory.length, 1);
  assert.strictEqual(privateHarness.calls.memory[0].userId, 'user-1');
  assert.deepStrictEqual(privateHarness.calls.memory[0].groupIds, []);
  assert.strictEqual(privateHarness.calls.memory[0].topK, 8);
  const privateModelInput = privateHarness.calls.model[0].messages[1].content;
  assert.match(privateModelInput, /private-memory-marker/);
  assert.doesNotMatch(privateModelInput, /recent-conversation-marker/);
  assert.doesNotMatch(privateModelInput, /group-memory-marker|group-jargon-marker/);
  assert.strictEqual(privateHarness.calls.model[0].options.disableTools, true);
  assert.deepStrictEqual(privateHarness.calls.model[0].options.allowedTools, []);
  assert.strictEqual(privateHarness.calls.model[0].options.modelConfig.timeoutMs, 60000);
  assert.strictEqual(privateHarness.calls.render[0].renderer, 'html');
  assert.strictEqual(privateHarness.calls.render[0].width, 900);
  assert.strictEqual(privateHarness.calls.render[0].max_height, 2000);
  assert.strictEqual(privateHarness.calls.send[0].context.userId, 'user-1');
  assert.strictEqual(privateHarness.calls.moderation.length, 2);
  assert.strictEqual(privateHarness.calls.moderation[0].markup, '<div></div>');
  assert.match(privateHarness.calls.moderation[1].markup, /纸飞机的秘密/);
  assert.ok(privateHarness.calls.logs.every(({ payload }) => {
    const serialized = JSON.stringify(payload);
    return !serialized.includes('让瑞希和我追一架纸飞机')
      && !serialized.includes('private-memory-marker')
      && !serialized.includes('纸飞机的秘密');
  }));

  const groupHarness = createHarness();
  const groupResult = await groupHarness.runtime.handle({
    rawText: '/小剧场 群里的纸飞机比赛',
    userId: 'member-1',
    groupId: 'group-1',
    chatType: 'group',
    requestId: 'request-2'
  });
  assert.strictEqual(groupResult.ok, true);
  assert.strictEqual(groupHarness.calls.memory[0].userId, 'group:group-1');
  assert.strictEqual(groupHarness.calls.memory[0].groupId, 'group-1');
  assert.deepStrictEqual(groupHarness.calls.memory[0].groupIds, ['group-1']);
  assert.strictEqual(groupHarness.calls.memory[0].facet, 'group');
  const groupModelInput = groupHarness.calls.model[0].messages[1].content;
  assert.match(groupModelInput, /group-memory-marker/);
  assert.match(groupModelInput, /group-jargon-marker/);
  assert.doesNotMatch(groupModelInput, /private-memory-marker|recent-conversation-marker/);

  const noMemoryHarness = createHarness();
  const noMemoryResult = await noMemoryHarness.runtime.handle({
    rawText: '/小剧场 --无记忆 只用这次素材',
    userId: 'user-2',
    chatType: 'private'
  });
  assert.strictEqual(noMemoryResult.ok, true);
  assert.strictEqual(noMemoryHarness.calls.memory.length, 0);

  const degradedMemoryHarness = createHarness({
    queryMemory: async () => {
      throw new Error('memory unavailable');
    }
  });
  const degradedResult = await degradedMemoryHarness.runtime.handle({
    rawText: '/小剧场 记忆服务坏了也继续',
    userId: 'user-3',
    chatType: 'private'
  });
  assert.strictEqual(degradedResult.ok, true);
  assert.strictEqual(degradedMemoryHarness.calls.model.length, 1);
  assert.ok(degradedMemoryHarness.calls.logs.some(({ stage }) => stage === 'memory_degraded'));

  const promptBlockedHarness = createHarness({
    reviewContent: (_input, callNumber) => callNumber === 1
      ? {
          allowed: false,
          reason: 'sensitive_content',
          stage: 'user_prompt',
          matchedCount: 1,
          categories: ['fixture']
        }
      : { allowed: true }
  });
  const promptBlocked = await promptBlockedHarness.runtime.handle({
    rawText: '/小剧场 fixture-sensitive-term',
    userId: 'blocked-1',
    chatType: 'private'
  });
  assert.strictEqual(promptBlocked.ok, false);
  assert.strictEqual(promptBlocked.code, 'content_blocked');
  assert.strictEqual(promptBlockedHarness.calls.memory.length, 0);
  assert.strictEqual(promptBlockedHarness.calls.model.length, 0);
  assert.strictEqual(promptBlockedHarness.calls.render.length, 0);
  assert.strictEqual(promptBlockedHarness.calls.send.length, 0);

  const outputBlockedHarness = createHarness({
    reviewContent: (_input, callNumber) => callNumber === 2
      ? {
          allowed: false,
          reason: 'sensitive_content',
          stage: 'visible_text',
          matchedCount: 1,
          categories: ['fixture']
        }
      : { allowed: true }
  });
  const outputBlocked = await outputBlockedHarness.runtime.handle({
    rawText: '/小剧场 安全素材',
    userId: 'blocked-2',
    chatType: 'private'
  });
  assert.strictEqual(outputBlocked.code, 'content_blocked');
  assert.strictEqual(outputBlockedHarness.calls.render.length, 0);
  assert.strictEqual(outputBlockedHarness.calls.send.length, 0);

  const cooldownHarness = createHarness();
  const firstCooldownResult = await cooldownHarness.runtime.handle({
    rawText: '/小剧场 第一次',
    userId: 'cooldown-user',
    chatType: 'private'
  });
  assert.strictEqual(firstCooldownResult.ok, true);
  cooldownHarness.clock.now += 14999;
  const coolingDown = await cooldownHarness.runtime.handle({
    rawText: '/小剧场 第二次',
    userId: 'cooldown-user',
    chatType: 'private'
  });
  assert.strictEqual(coolingDown.code, 'cooldown');
  cooldownHarness.clock.now += 1;
  const cooldownExpired = await cooldownHarness.runtime.handle({
    rawText: '/小剧场 第三次',
    userId: 'cooldown-user',
    chatType: 'private'
  });
  assert.strictEqual(cooldownExpired.ok, true);

  await assertFailureCooldown({
    requestAssistantMessage: async () => {
      throw Object.assign(new Error('model timed out'), { code: 'ETIMEDOUT' });
    }
  }, 'story_generation', 'model-failure-user');

  await assertFailureCooldown({
    renderVisual: async () => {
      throw Object.assign(new Error('renderer unavailable'), { code: 'html_service_unavailable' });
    }
  }, 'render', 'render-failure-user');

  await assertFailureCooldown({
    sendImage: async () => {
      throw Object.assign(new Error('QQ send failed'), { code: 'qq_send_failed' });
    }
  }, 'send', 'send-failure-user');

  let releaseModel;
  const gate = new Promise((resolve) => { releaseModel = resolve; });
  const concurrencyHarness = createHarness({
    requestAssistantMessage: async () => {
      await gate;
      return { role: 'assistant', content: JSON.stringify(story) };
    }
  });
  const activeOne = concurrencyHarness.runtime.handle({
    rawText: '/小剧场 用户一', userId: 'active-1', chatType: 'private'
  });
  const activeTwo = concurrencyHarness.runtime.handle({
    rawText: '/小剧场 用户二', userId: 'active-2', chatType: 'private'
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual((await concurrencyHarness.runtime.handle({
    rawText: '/小剧场 用户三', userId: 'active-3', chatType: 'private'
  })).code, 'busy');
  assert.strictEqual((await concurrencyHarness.runtime.handle({
    rawText: '/小剧场 用户一重复', userId: 'active-1', chatType: 'private'
  })).code, 'busy');
  releaseModel();
  const activeResults = await Promise.all([activeOne, activeTwo]);
  assert.ok(activeResults.every((result) => result.ok === true));

  console.log('smallTheaterRuntime.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
