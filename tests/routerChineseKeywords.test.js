const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const { detectIntent } = require('../core/router');
const { parseAdminCommand } = require('../core/router');

const imageSummaryRoute = detectIntent({
  rawText: '请总结这张图片 [CQ:image,url=https://example.com/a.jpg]',
  botQQ: '123456',
  userId: 'u1',
  chatType: 'group'
});

assert.strictEqual(imageSummaryRoute.topRouteType, 'direct_chat');
assert.strictEqual(imageSummaryRoute.meta.chatMode, 'image_summary');

const actionRoute = detectIntent({
  rawText: '帮我执行命令重启服务',
  botQQ: '123456',
  userId: 'u1',
  chatType: 'group',
  effectiveIntentText: '帮我执行命令重启服务'
});

assert.strictEqual(actionRoute.topRouteType, 'direct_chat');
assert.strictEqual(actionRoute.meta.reason, 'explicit-act');

const hapiCommand = parseAdminCommand('/hapi status');
assert.strictEqual(hapiCommand.cmd, 'hapi');
assert.strictEqual(hapiCommand.payload, 'status');

const claudeCommand = parseAdminCommand('/claude 帮我看下这个仓库');
assert.strictEqual(claudeCommand.cmd, 'claude');
assert.strictEqual(claudeCommand.payload, '帮我看下这个仓库');

const claudeOpenCommand = parseAdminCommand('/claude-open');
assert.strictEqual(claudeOpenCommand.cmd, 'claude-open');

const claudeSendCommand = parseAdminCommand('/claude-send 继续');
assert.strictEqual(claudeSendCommand.cmd, 'claude-send');
assert.strictEqual(claudeSendCommand.payload, '继续');

console.log('routerChineseKeywords.test.js passed');
