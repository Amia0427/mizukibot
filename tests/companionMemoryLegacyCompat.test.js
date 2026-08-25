'use strict';

const assert = require('assert');
const path = require('path');
const { createMemoryV3TempEnv } = require('./memoryV3TestHarness');

const tempRoot = createMemoryV3TempEnv('mizuki-companion-memory-legacy-');
process.env.MEMORY_STORAGE_MODE = 'legacy_compat';
process.env.COMPANION_MEMORY_SETTINGS_FILE = path.join(tempRoot, 'companion-memory-settings.json');

module.exports = (async () => {
  const { createCompanionMemoryService } = require('../src/features/companion-memory');
  const vectorMemory = require('../utils/vectorMemory');
  const service = createCompanionMemoryService();

  const remembered = await service.execute('legacy-user', {
    action: 'remember',
    text: '我周末通常会读科幻小说'
  });
  const otherMemory = await service.execute('other-user', {
    action: 'remember',
    text: '另一位用户的私密记忆'
  });
  const mirrored = vectorMemory.getMemoryItems('legacy-user')
    .find((item) => item.id === remembered.item.id);
  assert.ok(mirrored);
  assert.strictEqual(mirrored.status, 'active');

  await assert.rejects(
    service.execute('legacy-user', { action: 'forget', id: otherMemory.item.id }),
    /memory not found/
  );
  assert.strictEqual(
    vectorMemory.getMemoryItems('other-user').find((item) => item.id === otherMemory.item.id).status,
    'active'
  );

  await service.execute('legacy-user', { action: 'forget', id: remembered.item.id });
  const archived = vectorMemory.getMemoryItems('legacy-user')
    .find((item) => item.id === remembered.item.id);
  assert.ok(archived);
  assert.strictEqual(archived.status, 'archived');

  console.log('companionMemoryLegacyCompat.test.js passed');
})();
