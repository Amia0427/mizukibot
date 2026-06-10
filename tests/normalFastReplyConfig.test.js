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

assert.strictEqual(loadConfigWithFastReply(undefined), false, '普通用户快速回复默认应关闭');
assert.strictEqual(loadConfigWithFastReply('false'), false, 'NORMAL_FAST_REPLY_ENABLED=false 应关闭');
assert.strictEqual(loadConfigWithFastReply('true'), true, 'NORMAL_FAST_REPLY_ENABLED=true 应开启');

console.log('normalFastReplyConfig.test.js passed');
