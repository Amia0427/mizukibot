const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';
process.env.ADMIN_USER_IDS = '1960901788';

const { detectIntent } = require('../core/router');

const route = detectIntent({
  rawText: '/create dreamy cat astronaut',
  botQQ: '123456',
  userId: 'u_not_admin',
  chatType: 'group'
});

assert.strictEqual(route.topRouteType, 'admin');
assert.strictEqual(route.meta.command.cmd, 'create');
assert.strictEqual(route.meta.command.payload, 'dreamy cat astronaut');
assert.deepStrictEqual(route.meta.command.args, ['dreamy cat astronaut']);

const emptyRoute = detectIntent({
  rawText: '/create',
  botQQ: '123456',
  userId: '1960901788',
  chatType: 'group'
});

assert.strictEqual(emptyRoute.topRouteType, 'admin');
assert.strictEqual(emptyRoute.meta.command.cmd, 'create');
assert.strictEqual(emptyRoute.meta.command.payload, '');

console.log('createAdminRouting.test.js passed');
