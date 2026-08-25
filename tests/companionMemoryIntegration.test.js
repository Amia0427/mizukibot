'use strict';

const assert = require('assert');
const path = require('path');
const { createMemoryV3TempEnv } = require('./memoryV3TestHarness');

const tempRoot = createMemoryV3TempEnv('mizuki-companion-memory-integration-');
process.env.API_KEY = process.env.API_KEY || 'test-key';
process.env.MEMORY_STORAGE_MODE = 'v3_only';
process.env.COMPANION_MEMORY_SETTINGS_FILE = path.join(tempRoot, 'companion-memory-settings.json');

module.exports = (async () => {
  const { getToolExecutor, getToolSchemaByName } = require('../api/toolRegistry');
  const { enforceToolPolicy, resolveToolPolicy } = require('../utils/toolPolicy');

  assert.ok(getToolSchemaByName('companion_memory'));
  const executor = getToolExecutor('companion_memory');
  assert.strictEqual(typeof executor, 'function');
  assert.deepStrictEqual(enforceToolPolicy('companion_memory', { action: 'LIST', limit: 500 }), {
    action: 'list',
    limit: 50,
    query: ''
  });
  assert.strictEqual(resolveToolPolicy('companion_memory', { action: 'list' }).policy.confirmation, 'none');
  assert.strictEqual(resolveToolPolicy('companion_memory', { action: 'remember' }).policy.confirmation, 'explicit');
  assert.strictEqual(resolveToolPolicy('companion_memory', { action: 'forget' }).policy.effect, 'destructive');

  const groupResult = await executor({
    action: 'list',
    __context: { userId: 'memory-user', chatType: 'group' }
  });
  assert.strictEqual(groupResult, '记忆中心只支持私聊。');

  const remembered = await executor({
    action: 'remember',
    text: '我喜欢在晚上听音乐',
    __context: { userId: 'memory-user', chatType: 'private' }
  });
  assert.ok(remembered.includes('已记住'));

  const listed = await executor({
    action: 'list',
    __context: { userId: 'memory-user', chatType: 'private' }
  });
  assert.ok(listed.includes('我喜欢在晚上听音乐'));

  const otherUser = await executor({
    action: 'list',
    __context: { userId: 'other-user', chatType: 'private' }
  });
  assert.strictEqual(otherUser, '当前没有可管理的长期记忆。');

  console.log('companionMemoryIntegration.test.js passed');
})();
