const assert = require('assert');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function loadConfigWithFastReply(value) {
  const snapshot = { ...process.env };
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    if (value === undefined) {
      delete process.env.NORMAL_FAST_REPLY_ENABLED;
    } else {
      process.env.NORMAL_FAST_REPLY_ENABLED = value;
    }
    clearProjectCache();
    return require('../config').NORMAL_FAST_REPLY_ENABLED;
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, envValue] of Object.entries(snapshot)) {
      process.env[key] = envValue;
    }
    clearProjectCache();
  }
}

function loadFastReplyPersonaModuleConfig(env = {}) {
  const snapshot = { ...process.env };
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    delete process.env.NORMAL_FAST_REPLY_PERSONA_MODULE_MAX_ACTIVE;
    delete process.env.NORMAL_FAST_REPLY_PERSONA_MODULE_MAX_TOKEN_COST;
    delete process.env.NORMAL_FAST_REPLY_PERSONA_MODULE_TEXT_MAX_CHARS;
    delete process.env.NORMAL_FAST_REPLY_WORLDBOOK_ENABLED;
    delete process.env.NORMAL_FAST_REPLY_WORLDBOOK_MAX_ACTIVE;
    delete process.env.NORMAL_FAST_REPLY_WORLDBOOK_MAX_TOKEN_COST;
    delete process.env.NORMAL_FAST_REPLY_WORLDBOOK_TEXT_MAX_CHARS;
    for (const [key, value] of Object.entries(env)) {
      process.env[key] = value;
    }
    clearProjectCache();
    const config = require('../config');
    return {
      maxActive: config.NORMAL_FAST_REPLY_PERSONA_MODULE_MAX_ACTIVE,
      maxTokenCost: config.NORMAL_FAST_REPLY_PERSONA_MODULE_MAX_TOKEN_COST,
      textMaxChars: config.NORMAL_FAST_REPLY_PERSONA_MODULE_TEXT_MAX_CHARS,
      worldbookEnabled: config.NORMAL_FAST_REPLY_WORLDBOOK_ENABLED,
      worldbookMaxActive: config.NORMAL_FAST_REPLY_WORLDBOOK_MAX_ACTIVE,
      worldbookMaxTokenCost: config.NORMAL_FAST_REPLY_WORLDBOOK_MAX_TOKEN_COST,
      worldbookTextMaxChars: config.NORMAL_FAST_REPLY_WORLDBOOK_TEXT_MAX_CHARS
    };
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, envValue] of Object.entries(snapshot)) {
      process.env[key] = envValue;
    }
    clearProjectCache();
  }
}

assert.strictEqual(loadConfigWithFastReply('false'), false, 'NORMAL_FAST_REPLY_ENABLED=false 应关闭');
assert.strictEqual(loadConfigWithFastReply('true'), true, 'NORMAL_FAST_REPLY_ENABLED=true 应开启');
assert.deepStrictEqual(loadFastReplyPersonaModuleConfig(), {
  maxActive: 2,
  maxTokenCost: 100,
  textMaxChars: 700,
  worldbookEnabled: true,
  worldbookMaxActive: 1,
  worldbookMaxTokenCost: 180,
  worldbookTextMaxChars: 900
}, '普通快速回复短 persona module 和 worldbook 默认预算应保持轻量');
assert.deepStrictEqual(loadFastReplyPersonaModuleConfig({
  NORMAL_FAST_REPLY_PERSONA_MODULE_MAX_ACTIVE: '1',
  NORMAL_FAST_REPLY_PERSONA_MODULE_MAX_TOKEN_COST: '80',
  NORMAL_FAST_REPLY_PERSONA_MODULE_TEXT_MAX_CHARS: '360',
  NORMAL_FAST_REPLY_WORLDBOOK_ENABLED: 'false',
  NORMAL_FAST_REPLY_WORLDBOOK_MAX_ACTIVE: '0',
  NORMAL_FAST_REPLY_WORLDBOOK_MAX_TOKEN_COST: '120',
  NORMAL_FAST_REPLY_WORLDBOOK_TEXT_MAX_CHARS: '500'
}), {
  maxActive: 1,
  maxTokenCost: 80,
  textMaxChars: 360,
  worldbookEnabled: false,
  worldbookMaxActive: 0,
  worldbookMaxTokenCost: 120,
  worldbookTextMaxChars: 500
}, '普通快速回复短 persona module 和 worldbook 预算应支持 env 覆盖');

console.log('normalFastReplyConfig.test.js passed');
