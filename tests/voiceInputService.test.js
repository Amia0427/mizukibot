const assert = require('assert');

const { createVoiceInputService } = require('../src/features/voice-input/service');

function createConfig(overrides = {}) {
  return {
    VOICE_INPUT_ENABLED: true,
    VOICE_INPUT_API_URL: 'https://api.example/v1/audio/transcriptions',
    VOICE_INPUT_API_KEY: 'voice-key',
    VOICE_INPUT_MODEL: 'voice-model',
    VOICE_INPUT_TIMEOUT_MS: 60000,
    VOICE_INPUT_MAX_BYTES: 5 * 1024 * 1024,
    VOICE_INPUT_MAX_CONCURRENCY: 4,
    ...overrides
  };
}

function createMessage({
  id,
  chatType = 'private',
  text = '',
  mentioned = false,
  records = ['voice.silk'],
  includeContextSegments = false
}) {
  const isGroup = chatType === 'group';
  const segments = [];
  const rawParts = [];
  if (includeContextSegments) {
    segments.push({ type: 'reply', data: { id: 'previous-1' } });
    rawParts.push('[CQ:reply,id=previous-1]');
  }
  if (mentioned) {
    segments.push({ type: 'at', data: { qq: '100' } });
    rawParts.push('[CQ:at,qq=100]');
  }
  if (text) {
    segments.push({ type: 'text', data: { text } });
    rawParts.push(text);
  }
  for (const file of records) {
    segments.push({ type: 'record', data: { file } });
    rawParts.push(`[CQ:record,file=${file}]`);
  }
  if (includeContextSegments) {
    segments.push({ type: 'image', data: { url: 'https://example.com/a.png' } });
    rawParts.push('[CQ:image,url=https://example.com/a.png]');
  }
  return {
    post_type: 'message',
    message_type: chatType,
    message_id: id,
    self_id: '100',
    user_id: '200',
    group_id: isGroup ? '300' : undefined,
    raw_message: rawParts.join(' '),
    message: segments
  };
}

function createHarness(options = {}) {
  const calls = {
    actions: [],
    transcriptions: [],
    sends: [],
    warnings: []
  };
  const actionClient = options.actionClient || {
    async callAction(action, params) {
      calls.actions.push({ action, params });
      return { file: `C:\\records\\${params.file}.mp3` };
    }
  };
  const client = options.client || {
    async transcribe(filePath) {
      calls.transcriptions.push(filePath);
      return `转写:${filePath.split('\\').pop()}`;
    }
  };
  const service = createVoiceInputService({
    config: createConfig(options.config),
    actionClient,
    client,
    stat: options.stat || (async () => ({ size: 1024 })),
    sendWithRetry: async (...args) => {
      calls.sends.push(args);
      return true;
    },
    logger: {
      warn(...args) {
        calls.warnings.push(args);
      }
    }
  });
  return { service, calls };
}

function waitForTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

module.exports = (async () => {
  assert.throws(() => createVoiceInputService({
    config: createConfig({ VOICE_INPUT_API_KEY: '' })
  }), /VOICE_INPUT_API_KEY/);

  {
    const { service, calls } = createHarness();
    const result = await service.prepare(createMessage({
      id: 'success-1',
      chatType: 'group',
      text: '请评价这首歌',
      mentioned: true,
      includeContextSegments: true
    }));
    assert.strictEqual(result.consumed, false);
    assert.strictEqual(calls.actions.length, 1);
    assert.deepStrictEqual(calls.actions[0], {
      action: 'get_record',
      params: { file: 'voice.silk', out_format: 'mp3' }
    });
    assert.strictEqual(result.message.message.some((segment) => segment.type === 'record'), false);
    assert.ok(result.message.message.some((segment) => segment.type === 'reply'));
    assert.ok(result.message.message.some((segment) => segment.type === 'at'));
    assert.ok(result.message.message.some((segment) => segment.type === 'image'));
    assert.match(result.message.raw_message, /请评价这首歌/);
    assert.match(result.message.raw_message, /\[语音转写\] 转写:voice\.silk\.mp3/);
    assert.doesNotMatch(result.message.raw_message, /CQ:record/);
    assert.match(result.message.raw_message, /CQ:reply/);
    assert.match(result.message.raw_message, /CQ:at/);
    assert.match(result.message.raw_message, /CQ:image/);
  }

  {
    const order = [];
    const { service } = createHarness({
      client: {
        async transcribe(filePath) {
          order.push(filePath);
          return filePath.endsWith('first.silk.mp3') ? '第一段' : '第二段';
        }
      }
    });
    const result = await service.prepare(createMessage({
      id: 'multiple-1',
      records: ['first.silk', 'second.silk']
    }));
    assert.deepStrictEqual(order, [
      'C:\\records\\first.silk.mp3',
      'C:\\records\\second.silk.mp3'
    ]);
    assert.ok(result.message.raw_message.indexOf('第一段') < result.message.raw_message.indexOf('第二段'));
  }

  {
    const { service, calls } = createHarness();
    const message = createMessage({ id: 'duplicate-1' });
    assert.strictEqual((await service.prepare(message)).consumed, false);
    assert.strictEqual((await service.prepare(message)).consumed, true);
    assert.strictEqual(calls.transcriptions.length, 1);
  }

  {
    let transcribeCalls = 0;
    const { service } = createHarness({
      stat: async () => ({ size: (5 * 1024 * 1024) + 1 }),
      client: {
        async transcribe() {
          transcribeCalls += 1;
          return '不应调用';
        }
      }
    });
    const result = await service.prepare(createMessage({ id: 'large-1', text: '帮我听听' }));
    assert.strictEqual(result.consumed, false);
    assert.strictEqual(transcribeCalls, 0);
    assert.match(result.message.raw_message, /语音识别失败，未获得音频内容/);
  }

  {
    const secretPath = 'C:\\secret\\voice.silk.mp3';
    const secretTranscript = '不应进入日志的音频内容';
    const { service, calls } = createHarness({
      actionClient: {
        async callAction() {
          return { file: secretPath };
        }
      },
      stat: async () => {
        const error = new Error(`ENOENT: ${secretPath} ${secretTranscript}`);
        error.code = 'ENOENT';
        throw error;
      }
    });
    await service.prepare(createMessage({ id: 'safe-log-1', text: '帮我转写' }));
    const logged = JSON.stringify(calls.warnings);
    assert.doesNotMatch(logged, /secret/);
    assert.doesNotMatch(logged, /不应进入日志/);
    assert.doesNotMatch(logged, /voice-key/);
    assert.match(logged, /audio_file_unavailable/);
  }

  {
    const { service, calls } = createHarness({
      client: {
        async transcribe() {
          throw new Error('asr failed');
        }
      }
    });
    const result = await service.prepare(createMessage({ id: 'private-failure-1' }));
    assert.strictEqual(result.consumed, true);
    assert.strictEqual(calls.sends.length, 1);
    assert.deepStrictEqual(calls.sends[0][0], {
      action: 'send_private_msg',
      params: {
        user_id: '200',
        message: '语音识别失败，请稍后重试或改发文字。'
      }
    });
  }

  {
    const { service, calls } = createHarness({
      client: {
        async transcribe() {
          throw new Error('asr failed');
        }
      }
    });
    const result = await service.prepare(createMessage({
      id: 'group-failure-1',
      chatType: 'group'
    }));
    assert.strictEqual(result.consumed, true);
    assert.strictEqual(calls.sends.length, 0);
  }

  {
    const { service, calls } = createHarness({
      client: {
        async transcribe() {
          throw new Error('asr failed');
        }
      }
    });
    const result = await service.prepare(createMessage({
      id: 'group-failure-mention-1',
      chatType: 'group',
      mentioned: true
    }));
    assert.strictEqual(result.consumed, true);
    assert.strictEqual(calls.sends.length, 1);
    assert.deepStrictEqual(calls.sends[0][0], {
      action: 'send_group_msg',
      params: {
        group_id: '300',
        message: '[CQ:at,qq=200] 语音识别失败，请稍后重试或改发文字。'
      }
    });
  }

  {
    const { service, calls } = createHarness({
      config: { VOICE_INPUT_ENABLED: false }
    });
    const message = createMessage({ id: 'disabled-1' });
    const result = await service.prepare(message);
    assert.strictEqual(result.message, message);
    assert.strictEqual(result.consumed, false);
    assert.strictEqual(calls.actions.length, 0);
    assert.strictEqual(calls.transcriptions.length, 0);
  }

  {
    const { service, calls } = createHarness();
    const result = await service.prepare({
      post_type: 'message',
      message_type: 'private',
      message_id: 'raw-only-1',
      user_id: '200',
      raw_message: '请转写 [CQ:record,file=raw-only.silk]'
    });
    assert.strictEqual(result.consumed, false);
    assert.strictEqual(calls.actions[0].params.file, 'raw-only.silk');
    assert.match(result.message.raw_message, /请转写 \[语音转写\] 转写:raw-only\.silk\.mp3/);
  }

  {
    const { service } = createHarness();
    const result = await service.prepare({
      post_type: 'message',
      message_type: 'private',
      message_id: 'structured-only-1',
      user_id: '200',
      self_id: '100',
      message: [
        { type: 'reply', data: { id: 'previous-1' } },
        { type: 'at', data: { qq: '100' } },
        { type: 'text', data: { text: '请转写' } },
        { type: 'record', data: { file: 'structured-only.silk' } },
        { type: 'image', data: { url: 'https://example.com/a.png' } }
      ]
    });
    assert.strictEqual(result.consumed, false);
    assert.match(result.message.raw_message, /请转写/);
    assert.match(result.message.raw_message, /\[语音转写\] 转写:structured-only\.silk\.mp3/);
    assert.match(result.message.raw_message, /CQ:reply/);
    assert.match(result.message.raw_message, /CQ:at/);
    assert.match(result.message.raw_message, /CQ:image/);
  }

  {
    const started = [];
    let releaseFirst;
    const { service } = createHarness({
      config: { VOICE_INPUT_MAX_CONCURRENCY: 1 },
      client: {
        async transcribe(filePath) {
          started.push(filePath);
          if (started.length === 1) {
            await new Promise((resolve) => {
              releaseFirst = resolve;
            });
          }
          return '完成';
        }
      }
    });
    const first = service.prepare(createMessage({ id: 'concurrency-1', records: ['first.silk'] }));
    await waitForTurn();
    const second = service.prepare(createMessage({ id: 'concurrency-2', records: ['second.silk'] }));
    await waitForTurn();
    assert.strictEqual(started.length, 1);
    releaseFirst();
    await Promise.all([first, second]);
    assert.strictEqual(started.length, 2);
  }

  console.log('voiceInputService.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
