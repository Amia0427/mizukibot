const assert = require('assert');
const fs = require('fs');
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
  try {
    const adminText = '管理员主回复专用系统提示词测试块：只给管理员。';
    const rootText = '普通主回复根系统提示词测试块：所有主回复都可见。';
    fs.writeFileSync(path.join(tempPrompts.promptsDir, 'admin.txt'), adminText, 'utf8');
    fs.writeFileSync(path.join(tempPrompts.promptsDir, 'SYSTEM.txt'), rootText, 'utf8');
    process.env.PROMPTS_DIR = tempPrompts.promptsDir;
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.ADMIN_USER_IDS = 'admin_1';
    process.env.PROMPT_OPTIONAL_BUILD_ENABLED = 'false';

    clearProjectCache();
    const config = require('../config');
    const { buildMainStableSystemBlocks } = require('../utils/stagePromptContracts');
    const service = require('../api/runtimeV2/context/service');
    service.promptLayerCache.stable.clear();
    service.promptLayerCache.session.clear();

    assert.ok(!config.SYSTEM_PROMPT.includes(adminText), 'global SYSTEM_PROMPT must not include admin-only text');
    const exportedAdminBlock = config.SYSTEM_PROMPT_BLOCKS.find((block) => block.id === 'admin_system_prompt');
    assert.ok(exportedAdminBlock, 'admin.txt must be exported as a stable prompt block');
    assert.ok(exportedAdminBlock.content.includes(adminText));
    assert.strictEqual(exportedAdminBlock.appliesWhen?.admin_only, true);

    const normalStable = buildMainStableSystemBlocks({
      systemPrompt: config.SYSTEM_PROMPT,
      userId: 'normal_1',
      routeMeta: {}
    });
    assert.ok(!normalStable.some((block) => block.id === 'admin_system_prompt'));
    assert.strictEqual(normalStable[0]?.id, 'root_system_prompt');

    const adminStable = buildMainStableSystemBlocks({
      systemPrompt: config.SYSTEM_PROMPT,
      userId: 'admin_1',
      routeMeta: {}
    });
    assert.strictEqual(adminStable[0]?.id, 'admin_system_prompt');
    assert.strictEqual(adminStable[1]?.id, 'root_system_prompt');

    const normalPrompt = await service.buildDynamicPrompt(
      { level: 'friend', points: 1 },
      'normal_1',
      '今天聊点轻松的',
      null,
      {
        routePolicyKey: 'direct_chat/default',
        topRouteType: 'direct_chat',
        routeMeta: {}
      }
    );
    assert.ok(!normalPrompt.promptSnapshot.stableBlockIds.includes('admin_system_prompt'));
    assert.ok(!normalPrompt.dynamicPrompt.includes(adminText));
    assert.ok(!normalPrompt.dynamicPrompt.includes('admin_affection='));

    const adminPrompt = await service.buildDynamicPrompt(
      { level: 'friend', points: 1 },
      'admin_1',
      '今天聊点轻松的',
      null,
      {
        routePolicyKey: 'direct_chat/default',
        topRouteType: 'direct_chat',
        routeMeta: {}
      }
    );
    assert.strictEqual(adminPrompt.promptSnapshot.stableBlockIds[0], 'admin_system_prompt');
    assert.ok(adminPrompt.stableSystemBlocks[0]?.content.includes(adminText));
    assert.ok(adminPrompt.dynamicPrompt.includes(adminText));
    assert.ok(adminPrompt.dynamicPrompt.includes('admin_affection='));
    assert.ok(adminPrompt.dynamicPrompt.includes('恋人感'));
    assert.ok(adminPrompt.dynamicPrompt.includes('admin_affection_private='));

    const normalAgain = await service.buildDynamicPrompt(
      { level: 'friend', points: 1 },
      'normal_1',
      '换个普通用户问题',
      null,
      {
        routePolicyKey: 'direct_chat/default',
        topRouteType: 'direct_chat',
        routeMeta: {}
      }
    );
    assert.ok(!normalAgain.promptSnapshot.stableBlockIds.includes('admin_system_prompt'));
    assert.ok(!normalAgain.dynamicPrompt.includes(adminText));
    assert.ok(service.promptLayerCache.stable.size >= 2, 'admin and normal stable prompts must use separate cache keys');

    console.log('adminStableSystemPrompt.test.js passed');
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
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
