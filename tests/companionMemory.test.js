'use strict';

const assert = require('assert');
const path = require('path');
const { createMemoryV3TempEnv } = require('./memoryV3TestHarness');

const tempRoot = createMemoryV3TempEnv('mizuki-companion-memory-');
process.env.MEMORY_STORAGE_MODE = 'v3_only';
process.env.COMPANION_MEMORY_SETTINGS_FILE = path.join(tempRoot, 'companion-memory-settings.json');

module.exports = (async () => {
  const {
    createCompanionMemoryService,
    createCompanionMemorySettingsStore
  } = require('../src/features/companion-memory');

  const settingsStore = createCompanionMemorySettingsStore(process.env.COMPANION_MEMORY_SETTINGS_FILE);
  const service = createCompanionMemoryService({ settingsStore });

  assert.strictEqual(service.isAutoMemoryEnabled('user-a'), true);
  const remembered = await service.execute('user-a', {
    action: 'remember',
    text: '我喜欢简洁、明确的技术回答'
  });
  assert.strictEqual(remembered.action, 'remember');
  assert.ok(remembered.item.id);

  const ownList = await service.execute('user-a', { action: 'list' });
  assert.deepStrictEqual(ownList.items.map((item) => item.text), ['我喜欢简洁、明确的技术回答']);
  assert.deepStrictEqual((await service.execute('user-b', { action: 'list' })).items, []);

  await assert.rejects(
    service.execute('user-b', {
      action: 'correct',
      id: remembered.item.id,
      text: '不应允许跨用户修改'
    }),
    /memory not found/
  );

  const corrected = await service.execute('user-a', {
    action: 'correct',
    id: remembered.item.id,
    text: '我喜欢简洁但要保留关键依据的技术回答'
  });
  assert.notStrictEqual(corrected.item.id, remembered.item.id);
  assert.deepStrictEqual(
    (await service.execute('user-a', { action: 'list' })).items.map((item) => item.text),
    ['我喜欢简洁但要保留关键依据的技术回答']
  );

  await service.execute('user-a', { action: 'forget', id: corrected.item.id });
  assert.deepStrictEqual((await service.execute('user-a', { action: 'list' })).items, []);

  const disabled = await service.execute('user-a', { action: 'set_auto', enabled: false });
  assert.strictEqual(disabled.autoMemoryEnabled, false);
  assert.strictEqual(service.isAutoMemoryEnabled('user-a'), false);
  assert.strictEqual(service.isAutoMemoryEnabled('user-b'), true);
  assert.strictEqual(
    createCompanionMemorySettingsStore(process.env.COMPANION_MEMORY_SETTINGS_FILE).isAutoMemoryEnabled('user-a'),
    false
  );

  const settings = await service.execute('user-a', { action: 'settings' });
  assert.strictEqual(settings.autoMemoryEnabled, false);

  console.log('companionMemory.test.js passed');
})();
