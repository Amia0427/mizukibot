'use strict';

const assert = require('assert');

const { createDeliveryTarget } = require('../src/platforms/contracts');
const { createCompanionVoiceService } = require('../src/features/companion-voice');
const { createToolExecutionHelpers } = require('../api/runtimeV2/runtime/toolExecution');

function buildTarget() {
  return createDeliveryTarget({
    platform: 'qq',
    chatType: 'private',
    containerId: 'bot-1',
    conversationId: 'qq-private',
    externalUserId: 'user-1'
  });
}

function createModerationGuard(blockedText) {
  return {
    check(text) {
      return {
        blocked: String(text || '').includes(blockedText),
        matchedWords: []
      };
    }
  };
}

function createService(overrides = {}) {
  const calls = { provider: [], audio: [], text: [] };
  const service = createCompanionVoiceService({
    config: {
      COMPANION_VOICE_ENABLED: true,
      COMPANION_VOICE_NAME: 'mizuki',
      COMPANION_VOICE_SPEED: 1,
      COMPANION_VOICE_MAX_CHARS: 3,
      COMPANION_VOICE_MAX_SEGMENTS: 4,
      COMPANION_VOICE_MAX_CONCURRENCY: 1
    },
    sensitiveGuard: createModerationGuard('敏感词'),
    provider: {
      configured: true,
      async synthesize(input) {
        calls.provider.push(input.text);
        return {
          buffer: Buffer.from(input.text),
          mimeType: 'audio/mpeg',
          format: 'mp3',
          fileName: 'voice.mp3'
        };
      }
    },
    canSendAudio: () => true,
    sendAudio: async (_target, audio) => {
      calls.audio.push(audio.buffer.toString());
      return { status: 'accepted', mode: 'record' };
    },
    sendText: async (_target, text) => {
      calls.text.push(text);
      return { status: 'accepted', mode: 'record' };
    },
    ...overrides
  });
  return { service, calls };
}

module.exports = (async () => {
  {
    const { service, calls } = createService();
    const result = await service.reply({
      text: '安全内容',
      userInputText: '用户包含敏感词',
      deliveryTarget: buildTarget()
    });
    assert.deepStrictEqual(result, {
      handled: true,
      sent: false,
      fallbackText: '',
      reason: 'sensitive_input',
      status: 'blocked'
    });
    assert.deepStrictEqual(calls, { provider: [], audio: [], text: [] });
  }

  {
    const { service, calls } = createService();
    const result = await service.reply({
      text: '输出含敏感词',
      userInputText: '安全输入',
      deliveryTarget: buildTarget()
    });
    assert.deepStrictEqual(result, {
      handled: true,
      sent: false,
      fallbackText: '',
      reason: 'sensitive_output',
      status: 'blocked'
    });
    assert.deepStrictEqual(calls, { provider: [], audio: [], text: [] });
  }

  {
    const { service, calls } = createService();
    const result = await service.reply({
      text: '敏感词',
      userInputText: '安全输入',
      deliveryTarget: buildTarget()
    });
    assert.strictEqual(result.reason, 'sensitive_output');
    assert.deepStrictEqual(calls, { provider: [], audio: [], text: [] });
  }

  {
    const { service, calls } = createService();
    const result = await service.reply({
      text: '安全文本',
      userInputText: '安全输入',
      deliveryTarget: buildTarget()
    });
    assert.strictEqual(result.reason, 'voice_sent');
    assert.deepStrictEqual(calls.provider, ['安全文', '本']);
    assert.deepStrictEqual(calls.audio, ['安全文', '本']);
    assert.deepStrictEqual(calls.text, []);
  }

  {
    const { service, calls } = createService({
      sensitiveGuard: createModerationGuard('legacy敏感')
    });
    const result = await service.reply('legacy-user', 'legacy敏感');
    assert.deepStrictEqual(result, {
      sent: false,
      fallbackText: '',
      reason: 'sensitive_output',
      status: 'blocked'
    });
    assert.deepStrictEqual(calls, { provider: [], audio: [], text: [] });
  }

  const config = require('../config');
  config.COMPANION_VOICE_ENABLED = true;
  const executor = require('../api/toolRegistry').getToolExecutor('companion_voice_reply');
  const output = await executor({
    text: '六四',
    __context: {
      originalUserText: '安全输入',
      deliveryTarget: buildTarget()
    }
  });
  assert.strictEqual(output, '语音未发送：内容触发敏感词审查，请换一种说法。');
  assert.doesNotMatch(output, /六四/);

  const context = createToolExecutionHelpers({}).buildToolContext({
    request: {
      question: '模型可见的归一化问题',
      originalUserText: '用户真实输入',
      routeMeta: { originalUserText: '路由副本' }
    }
  });
  assert.strictEqual(context.originalUserText, '用户真实输入');

  const inputBlockedOutput = await executor({
    text: '安全输出',
    userInputText: '模型不能覆盖上下文',
    __context: {
      originalUserText: '六四',
      deliveryTarget: buildTarget()
    }
  });
  assert.strictEqual(inputBlockedOutput, '语音未发送：内容触发敏感词审查，请换一种说法。');

  console.log('companionVoiceModeration.test.js passed');
})();
