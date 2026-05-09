const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const { detectIntent, sanitizeAiRoute } = require('../core/router');

const destructiveRoute = detectIntent({
  rawText: '我要把你的工具调用全删了',
  botQQ: '123456',
  userId: 'u1',
  chatType: 'group'
});

assert.strictEqual(destructiveRoute.topRouteType, 'refuse');
assert.strictEqual(destructiveRoute.meta.reason, 'bad-faith-request');

const fallbackRoute = detectIntent({
  rawText: '定位这两个报错的根本原因，然后进行治本修复',
  botQQ: '123456',
  userId: 'u1',
  chatType: 'group',
  effectiveIntentText: '定位这两个报错的根本原因，然后进行治本修复'
});

assert.strictEqual(fallbackRoute.topRouteType, 'direct_chat');
assert.strictEqual(fallbackRoute.meta.toolIntent, 'none');
assert.strictEqual(fallbackRoute.meta.responseIntent, 'answer');

const sanitizedRoute = sanitizeAiRoute({
  topRouteType: 'direct_chat',
  confidence: 0.92,
  intent: {
    risk: 'medium',
    toolNeed: ['local-write'],
    executionMode: 'delegated',
    needsPlanning: true,
    needsMemory: false
  },
  facets: {
    modality: 'text',
    sourceScope: 'mixed',
    domain: 'general',
    outputKind: 'action',
    freshness: 'unknown'
  },
  meta: {
    reason: 'explicit-act',
    toolIntent: 'force_tools',
    responseIntent: 'action_guidance',
    allowedTools: ['qzone_draft']
  }
}, fallbackRoute, { userId: 'u1', imageUrl: null });

assert.strictEqual(sanitizedRoute.topRouteType, 'direct_chat');
assert.strictEqual(sanitizedRoute.meta.toolIntent, 'none');
assert.strictEqual(sanitizedRoute.meta.responseIntent, 'answer');
assert.strictEqual(sanitizedRoute.meta.allowedTools, undefined);

const explicitActFallbackRoute = detectIntent({
  rawText: '帮我执行命令重启服务',
  botQQ: '123456',
  userId: 'u1',
  chatType: 'group',
  effectiveIntentText: '帮我执行命令重启服务'
});

const preservedActRoute = sanitizeAiRoute({
  topRouteType: 'direct_chat',
  confidence: 0.92,
  intent: {
    risk: 'medium',
    toolNeed: ['local-write'],
    executionMode: 'delegated',
    needsPlanning: true,
    needsMemory: false
  },
  facets: {
    modality: 'text',
    sourceScope: 'mixed',
    domain: 'general',
    outputKind: 'action',
    freshness: 'unknown'
  },
  meta: {
    reason: 'explicit-act',
    toolIntent: 'force_tools',
    responseIntent: 'action_guidance'
  }
}, explicitActFallbackRoute, { userId: 'u1', imageUrl: null });

assert.strictEqual(preservedActRoute.meta.toolIntent, 'force_tools');
assert.strictEqual(preservedActRoute.meta.responseIntent, 'action_guidance');

console.log('routerSafetyGuards.test.js passed');
