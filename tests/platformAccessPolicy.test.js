const assert = require('assert');

const { isAdminUser } = require('../api/qqActionService');
const {
  filterToolsForPlatform,
  shouldRunPassiveAwareness
} = require('../src/platforms/accessPolicy');
const { setPlatformAdminResolver } = require('../src/platforms/admin');
const { runWithDeliveryContext } = require('../src/platforms/deliveryContext');
const { publishQzoneForContext } = require('../api/qqActionService');

module.exports = (async () => {
  setPlatformAdminResolver((userId) => userId === 'discord:admin');
  assert.strictEqual(isAdminUser('discord:admin'), true);

  const platformTools = [
    'qzone_draft',
    'create_qzone_auto_task',
    'companion_voice_reply',
    'web_search'
  ];
  assert.deepStrictEqual(filterToolsForPlatform(platformTools, 'discord'), ['web_search']);
  assert.deepStrictEqual(filterToolsForPlatform(platformTools, 'telegram'), ['web_search']);
  assert.deepStrictEqual(filterToolsForPlatform(platformTools, 'qq'), platformTools);
  assert.strictEqual(shouldRunPassiveAwareness({ platform: 'discord', allowPassiveContext: false }), false);
  assert.strictEqual(shouldRunPassiveAwareness({ platform: 'telegram', allowPassiveContext: true }), true);
  assert.strictEqual(shouldRunPassiveAwareness({ platform: 'qq', allowPassiveContext: false }), true);

  await runWithDeliveryContext({
    target: { platform: 'discord', chatType: 'group', conversationId: 'c1' }
  }, async () => {
    await assert.rejects(
      publishQzoneForContext('draft', { userId: 'discord:admin', routeMeta: { groupId: 'c1' } }),
      /QQ-only capability/
    );
  });
  setPlatformAdminResolver(null);

  console.log('platformAccessPolicy.test.js passed');
})().catch((error) => {
  setPlatformAdminResolver(null);
  console.error(error?.stack || error);
  process.exit(1);
});
