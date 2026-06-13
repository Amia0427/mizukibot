const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { createTempPromptsDir } = require('./promptTestHelpers');

function clearProjectCache() {
  const projectRoot = require('path').resolve(__dirname, '..') + require('path').sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

module.exports = (() => {
  const snapshot = { ...process.env };
  const tempPrompts = createTempPromptsDir();
  try {
    const normalUserDefaultText = '普通用户被动感知现场测试块：群里顺手插一句时，避开性别隐私追问，只输出自然短回复。';
    fs.writeFileSync(path.join(tempPrompts.promptsDir, 'defaut.txt'), normalUserDefaultText, 'utf8');
    process.env.PROMPTS_DIR = tempPrompts.promptsDir;
    process.env.ADMIN_USER_IDS = 'admin-passive';

    clearProjectCache();
    const passiveAwareness = require('../core/passiveGroupAwareness');

    const normalMessages = passiveAwareness.buildPassiveReplySystemMessages('normal-passive');
    assert.deepStrictEqual(normalMessages.map((message) => message.role), ['system', 'system']);
    assert.ok(normalMessages[1].content.includes(normalUserDefaultText));

    const adminPrivateMessages = passiveAwareness.buildPassiveReplySystemMessages('admin-passive');
    assert.deepStrictEqual(adminPrivateMessages.map((message) => message.role), ['system']);
    assert.ok(!JSON.stringify(adminPrivateMessages).includes(normalUserDefaultText));

    const adminGroupMessages = passiveAwareness.buildPassiveReplySystemMessages('admin-passive');
    assert.deepStrictEqual(adminGroupMessages.map((message) => message.role), ['system']);
    assert.ok(!JSON.stringify(adminGroupMessages).includes(normalUserDefaultText));

    fs.writeFileSync(path.join(tempPrompts.promptsDir, 'defaut.txt'), '', 'utf8');
    clearProjectCache();
    const passiveAwarenessWithEmptyDefault = require('../core/passiveGroupAwareness');
    const emptyDefaultMessages = passiveAwarenessWithEmptyDefault.buildPassiveReplySystemMessages('normal-passive');
    assert.deepStrictEqual(emptyDefaultMessages.map((message) => message.role), ['system']);
    assert.ok(!JSON.stringify(emptyDefaultMessages).includes(normalUserDefaultText));

    console.log('passiveAwarenessReplySystemPrompt.test.js passed');
  } finally {
    tempPrompts.cleanup();
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
      process.env[key] = value;
    }
    clearProjectCache();
  }
})();
