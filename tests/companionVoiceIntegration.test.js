'use strict';

const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';
process.env.COMPANION_VOICE_ENABLED = 'false';
process.env.COMPANION_VOICE_MAX_CHARS = '999';

module.exports = (async () => {
  const { sendPrivateVoiceMessage } = require('../api/qqActionService');
  const config = require('../config');
  assert.strictEqual(config.COMPANION_VOICE_MAX_CHARS, 300);
  const calls = [];
  await sendPrivateVoiceMessage('voice-user', Buffer.from('voice-bytes'), {
    actionClient: {
      callAction: async (action, params) => calls.push({ action, params })
    }
  });
  assert.deepStrictEqual(calls, [{
    action: 'send_private_msg',
    params: {
      user_id: 'voice-user',
      message: [{
        type: 'record',
        data: { file: `base64://${Buffer.from('voice-bytes').toString('base64')}` }
      }]
    }
  }]);

  const { getToolExecutor, getToolSchemaByName } = require('../api/toolRegistry');
  const { COMPANION_TOOL_PRESET } = require('../utils/companionTools');
  const { enforceToolPolicy, getPolicy, POLICY_VERSION } = require('../utils/toolPolicy');

  const schema = getToolSchemaByName('companion_voice_reply');
  assert.ok(schema);
  assert.deepStrictEqual(schema.function.parameters.required, ['text']);
  assert.strictEqual(schema.function.parameters.properties.text.maxLength, undefined);
  assert.strictEqual(typeof getToolExecutor('companion_voice_reply'), 'function');
  assert.ok(COMPANION_TOOL_PRESET.includes('companion_voice_reply'));
  assert.deepStrictEqual(enforceToolPolicy('companion_voice_reply', {
    text: '  给你一条语音  ',
    userId: 'other-user'
  }), { text: '给你一条语音' });
  assert.deepStrictEqual(getPolicy('companion_voice_reply'), {
    version: POLICY_VERSION,
    risk: 'medium',
    capability: 'network',
    effect: 'external_send',
    confirmation: 'explicit',
    scope: 'user',
    idempotency: 'required',
    replay: 'block_uncertain',
    exposure: 'public'
  });

  const executor = getToolExecutor('companion_voice_reply');
  assert.strictEqual(await executor({
    text: '群聊不应发送',
    __context: {
      userId: 'voice-user',
      chatType: 'group',
      platform: 'qq',
      deliveryTarget: {
        platform: 'qq',
        chatType: 'group',
        conversationId: 'group-1'
      }
    }
  }), '语音未发送，请直接用文字回复：群聊不应发送');
  assert.strictEqual(await executor({
    text: '配置关闭时保留这段文字',
    __context: { userId: 'voice-user', chatType: 'private', platform: 'qq' }
  }), '语音未发送，请直接用文字回复：配置关闭时保留这段文字');

  console.log('companionVoiceIntegration.test.js passed');
})();
