const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'messageHandler.runtime-04.chunk.js'), 'utf8');
const passiveGateIndex = source.indexOf("if (!isPrivateChatType(chatType) && !directBotAnchor)");
const fallbackIndex = source.indexOf("runtimeQuestionText = '[分享卡片]'");
const routeResolverIndex = source.indexOf('route = await routeResolver({');

assert.ok(passiveGateIndex >= 0, '群聊被动门禁必须存在');
assert.ok(fallbackIndex > passiveGateIndex, '无 URL 卡片兜底必须发生在群聊被动门禁之后');
assert.ok(routeResolverIndex > fallbackIndex, '无 URL 卡片兜底必须在路由前生效');

console.log('messageHandlerCardContextSource.test.js passed');
