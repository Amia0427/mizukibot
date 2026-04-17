const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';
process.env.ADMIN_USER_IDS = '1960901788';

const { detectIntent } = require('../core/router');

const nonAdminRoute = detectIntent({
  rawText: '/claude 帮我分析这个仓库',
  botQQ: '123456',
  userId: 'u_not_admin',
  chatType: 'group'
});

assert.strictEqual(nonAdminRoute.topRouteType, 'admin');
assert.strictEqual(nonAdminRoute.meta.command.cmd, 'claude');
assert.strictEqual(nonAdminRoute.meta.admin, false);

const adminRoute = detectIntent({
  rawText: '/claude 帮我分析这个仓库',
  botQQ: '123456',
  userId: '1960901788',
  chatType: 'group'
});

assert.strictEqual(adminRoute.topRouteType, 'admin');
assert.strictEqual(adminRoute.meta.command.cmd, 'claude');
assert.strictEqual(adminRoute.meta.admin, true);

const openRoute = detectIntent({
  rawText: '/claude-open',
  botQQ: '123456',
  userId: 'u_not_admin',
  chatType: 'group'
});

assert.strictEqual(openRoute.topRouteType, 'admin');
assert.strictEqual(openRoute.meta.command.cmd, 'claude-open');
assert.strictEqual(openRoute.meta.admin, false);

console.log('claudeAdminRouting.test.js passed');
