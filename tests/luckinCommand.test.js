const assert = require('assert');

const {
  buildLuckinMenuReply,
  containsSensitiveToken,
  parseLuckinCommand
} = require('../src/features/luckin/command');

const menu = parseLuckinCommand('瑞希瑞幸');
assert.strictEqual(menu.kind, 'menu');
assert.strictEqual(menu.payload, '');

const recommend = parseLuckinCommand('[CQ:at,qq=bot_test] 瑞希瑞幸 推荐', { botQQ: 'bot_test' });
assert.strictEqual(recommend.kind, 'recommend');
assert.strictEqual(recommend.payload, '');

const preview = parseLuckinCommand('瑞希瑞幸 预览 上海张江 生椰拿铁');
assert.strictEqual(preview.kind, 'preview');
assert.strictEqual(preview.payload, '上海张江 生椰拿铁');

assert.strictEqual(parseLuckinCommand('我想喝瑞幸', { botQQ: 'bot_test' }), null);
assert.strictEqual(parseLuckinCommand('今天喝咖啡吗', { botQQ: 'bot_test' }), null);

assert.strictEqual(containsSensitiveToken('Bearer luckin_token_value_1234567890'), true);
assert.strictEqual(containsSensitiveToken('abc.def.ghi'), true);
assert.strictEqual(containsSensitiveToken('瑞希瑞幸 菜单'), false);

const reply = buildLuckinMenuReply();
assert.ok(reply.includes('瑞希瑞幸 菜单'));
assert.ok(reply.includes('瑞希瑞幸 推荐'));
assert.ok(reply.includes('瑞希瑞幸 预览'));
assert.ok(reply.includes('Token'));

console.log('luckinCommand.test.js passed');
