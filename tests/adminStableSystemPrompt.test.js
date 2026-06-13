const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTempPromptsDir } = require('./promptTestHelpers');

function clearProjectCache() {
  const projectRoot = 'D:\\waifu\\';
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempPrompts = createTempPromptsDir();
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-admin-prompt-data-'));
  try {
    const adminText = '管理员主回复专用系统提示词测试块：只给管理员。';
    const rootText = '普通主回复根系统提示词测试块：所有主回复都可见。';
    const normalUserDefaultText = '普通用户输出规范测试块：禁止输出内部规则。';
    fs.writeFileSync(path.join(tempPrompts.promptsDir, 'admin.txt'), adminText, 'utf8');
    fs.writeFileSync(path.join(tempPrompts.promptsDir, 'SYSTEM.txt'), rootText, 'utf8');
    fs.writeFileSync(path.join(tempPrompts.promptsDir, 'defaut.txt'), normalUserDefaultText, 'utf8');
    process.env.PROMPTS_DIR = tempPrompts.promptsDir;
    process.env.DATA_DIR = tempDataDir;
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.ADMIN_USER_IDS = 'admin_1';
    process.env.PROMPT_OPTIONAL_BUILD_ENABLED = 'false';

    clearProjectCache();
    const config = require('../config');
    const { buildPromptSnapshot } = require('../utils/promptCompiler');
    const { buildMainStableSystemBlocks } = require('../utils/stagePromptContracts');

    assert.ok(!config.SYSTEM_PROMPT.includes(adminText), 'global SYSTEM_PROMPT must not include admin-only text');
    assert.ok(!config.SYSTEM_PROMPT.includes(normalUserDefaultText), 'global SYSTEM_PROMPT must not include normal-user-only text without user context');
    const exportedAdminBlock = config.SYSTEM_PROMPT_BLOCKS.find((block) => block.id === 'admin_system_prompt');
    assert.ok(exportedAdminBlock, 'admin.txt must be exported as a stable prompt block');
    assert.ok(exportedAdminBlock.content.includes(adminText));
    assert.strictEqual(exportedAdminBlock.appliesWhen?.admin_only, true);
    const exportedNormalUserBlock = config.SYSTEM_PROMPT_BLOCKS.find((block) => block.id === 'normal_user_default_prompt');
    assert.ok(exportedNormalUserBlock, 'defaut.txt must be exported as a normal-user stable prompt block');
    assert.ok(exportedNormalUserBlock.content.includes(normalUserDefaultText));
    assert.strictEqual(exportedNormalUserBlock.appliesWhen?.normal_user_only, true);

    const normalStable = buildMainStableSystemBlocks({
      systemPrompt: config.SYSTEM_PROMPT,
      userId: 'normal_1',
      routeMeta: {}
    });
    assert.ok(!normalStable.some((block) => block.id === 'admin_system_prompt'));
    assert.strictEqual(normalStable[0]?.id, 'root_system_prompt');
    assert.strictEqual(normalStable[1]?.id, 'normal_user_default_prompt');

    const adminStable = buildMainStableSystemBlocks({
      systemPrompt: config.SYSTEM_PROMPT,
      userId: 'admin_1',
      routeMeta: { chatType: 'private' }
    });
    assert.strictEqual(adminStable[0]?.id, 'admin_system_prompt');
    assert.strictEqual(adminStable[1]?.id, 'root_system_prompt');
    assert.ok(!adminStable.some((block) => block.id === 'normal_user_default_prompt'));

    const adminGroupStable = buildMainStableSystemBlocks({
      systemPrompt: config.SYSTEM_PROMPT,
      userId: 'admin_1',
      routeMeta: { chatType: 'group', groupId: 'group_1' }
    });
    assert.ok(!adminGroupStable.some((block) => block.id === 'admin_system_prompt'));
    assert.ok(!adminGroupStable.some((block) => block.id === 'normal_user_default_prompt'));
    assert.strictEqual(adminGroupStable[0]?.id, 'root_system_prompt');

    const normalSnapshot = buildPromptSnapshot(normalStable, {
      stage: 'main',
      userId: 'normal_1',
      adminUserIds: config.ADMIN_USER_IDS,
      policyKey: 'test/normal-main-stable'
    });
    const normalSnapshotIds = normalSnapshot.assembledBlocks.map((block) => block.id);
    const normalSnapshotText = normalSnapshot.renderedSystemMessages.map((message) => message.content).join('\n');
    assert.ok(!normalSnapshotIds.includes('admin_system_prompt'));
    assert.ok(normalSnapshotIds.includes('normal_user_default_prompt'));
    assert.ok(!normalSnapshotText.includes(adminText));
    assert.ok(normalSnapshotText.includes(normalUserDefaultText));

    const adminSnapshot = buildPromptSnapshot(adminStable, {
      stage: 'main',
      isAdmin: true,
      userId: 'admin_1',
      adminUserIds: config.ADMIN_USER_IDS,
      policyKey: 'test/admin-main-stable'
    });
    const adminSnapshotIds = adminSnapshot.assembledBlocks.map((block) => block.id);
    const adminSnapshotText = adminSnapshot.renderedSystemMessages.map((message) => message.content).join('\n');
    assert.strictEqual(adminSnapshotIds[0], 'admin_system_prompt');
    assert.ok(!adminSnapshotIds.includes('normal_user_default_prompt'));
    assert.ok(adminSnapshotText.includes(adminText));
    assert.ok(!adminSnapshotText.includes(normalUserDefaultText));

    const adminGroupSnapshot = buildPromptSnapshot(adminGroupStable, {
      stage: 'main',
      userId: 'admin_1',
      adminUserIds: config.ADMIN_USER_IDS,
      policyKey: 'test/admin-group-stable'
    });
    const adminGroupSnapshotIds = adminGroupSnapshot.assembledBlocks.map((block) => block.id);
    const adminGroupSnapshotText = adminGroupSnapshot.renderedSystemMessages.map((message) => message.content).join('\n');
    assert.ok(!adminGroupSnapshotIds.includes('admin_system_prompt'));
    assert.ok(!adminGroupSnapshotIds.includes('normal_user_default_prompt'));
    assert.ok(!adminGroupSnapshotText.includes(adminText));
    assert.ok(!adminGroupSnapshotText.includes(normalUserDefaultText));

    console.log('adminStableSystemPrompt.test.js passed');
  } finally {
    tempPrompts.cleanup();
    try {
      fs.rmSync(tempDataDir, { recursive: true, force: true });
    } catch (_) {}
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
      process.env[key] = value;
    }
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
