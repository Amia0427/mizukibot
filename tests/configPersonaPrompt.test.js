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

function useConfigDefault(key) {
  process.env[key] = '__USE_CONFIG_DEFAULT__';
}

function estimatePromptTokens(value) {
  const text = String(value || '').trim();
  let cjkChars = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x3400 && code <= 0x9fff) cjkChars += 1;
  }
  const latinChars = text.length - cjkChars;
  return cjkChars + Math.ceil(Math.max(0, latinChars) / 4);
}

(() => {
  const snapshot = { ...process.env };
  const tempPrompts = createTempPromptsDir();
  try {
    const rootSystemPromptPath = path.join(tempPrompts.promptsDir, 'SYSTEM.txt');
    fs.writeFileSync(rootSystemPromptPath, '主回复根系统提示词测试块：最高优先级。', 'utf8');
    process.env.PROMPTS_DIR = tempPrompts.promptsDir;
    useConfigDefault('CONTEXT_WINDOW_MAX_TOKENS');
    useConfigDefault('SHORT_TERM_MEMORY_MAX_TOKENS');
    useConfigDefault('SHORT_TERM_MEMORY_RECENT_MESSAGES');
    useConfigDefault('SHORT_TERM_MEMORY_RECENT_TURNS');
    useConfigDefault('SHORT_TERM_SCENE_RECENT_TURNS');
    useConfigDefault('SESSION_CONTEXT_SUMMARY_MAX_CHARS');
    useConfigDefault('SESSION_CONTEXT_SUMMARY_LOAD_COUNT');
    useConfigDefault('SESSION_CONTEXT_SUMMARY_OPEN_LOOPS_MAX_ITEMS');
    useConfigDefault('SESSION_CONTEXT_SUMMARY_ASSISTANT_COMMITMENTS_MAX_ITEMS');
    useConfigDefault('SESSION_CONTEXT_SUMMARY_USER_CONSTRAINTS_MAX_ITEMS');
    useConfigDefault('SESSION_CONTEXT_SUMMARY_RECENT_TURNS_MAX_ITEMS');
    useConfigDefault('SHORT_TERM_BRIDGE_RAW_TTL_HOURS');
    useConfigDefault('MAIN_PROMPT_SHORT_TERM_CONTINUITY_MAX_TOKENS');
    useConfigDefault('MAIN_REPLY_CONTEXT_NORMAL_RECENT_RAW_MESSAGES');
    useConfigDefault('MAIN_REPLY_CONTEXT_NORMAL_NEWEST_RAW_MESSAGES');
    useConfigDefault('MAIN_REPLY_CONTEXT_NORMAL_TOKEN_MULTIPLIER');
    useConfigDefault('MEMORY_V3_SESSION_RECENT_MESSAGES');
    useConfigDefault('MODEL_SELF_CHECK_TIMEOUT_MS');
    useConfigDefault('IMAGE_MEMORY_VISUAL_SUMMARY_TIMEOUT_MS');

    clearProjectCache();
    const config = require('../config');
    const requiredFiles = [
      '01_identity.txt',
      '02_style.txt',
      '03_boundaries.txt',
      '04_behavior.txt',
      '06_state_modulation.txt',
      '07_opus_localization.txt'
    ];

    assert.deepStrictEqual(config.PERSONA_FILES, requiredFiles);
    assert.ok(config.SYSTEM_PROMPT.startsWith('主回复根系统提示词测试块：最高优先级。'), 'SYSTEM.txt must be the first compiled SYSTEM_PROMPT text');
    assert.ok(Array.isArray(config.SYSTEM_PROMPT_BLOCKS), 'SYSTEM_PROMPT_BLOCKS must be exported');
    assert.strictEqual(config.SYSTEM_PROMPT_BLOCKS[0]?.id, 'root_system_prompt');
    assert.strictEqual(config.SYSTEM_PROMPT_BLOCKS[0]?.authority, 'system_root');
    assert.ok(config.SYSTEM_PROMPT_BLOCKS[0]?.content.includes('主回复根系统提示词测试块：最高优先级。'));
    assert.strictEqual(config.SYSTEM_PROMPT_BLOCKS[1]?.id, 'main_persona_system');
    const roleplayLivenessPrelude = fs.readFileSync(path.join(config.PERSONA_DIR, '00_roleplay_liveness_prelude.txt'), 'utf8').trim();
    assert.ok(roleplayLivenessPrelude, '00_roleplay_liveness_prelude.txt must not be empty');
    assert.ok(estimatePromptTokens(roleplayLivenessPrelude) <= 1500, 'roleplay liveness prelude must stay within 1500 estimated tokens');
    assert.ok(!roleplayLivenessPrelude.includes('线下或叙事场景'), 'roleplay liveness prelude must not define offline/narrative mode');
    assert.ok(roleplayLivenessPrelude.includes('保持线上聊天里的瑞希'), 'roleplay liveness prelude must anchor online chat mode');
    assert.ok(
      roleplayLivenessPrelude.includes('当前项目没有线下模式')
        || (roleplayLivenessPrelude.includes('不要切成小说叙事或线下演出')
          && roleplayLivenessPrelude.includes('不要写长段动作、神态、环境描写')),
      'roleplay liveness prelude must explicitly avoid offline/narrative mode'
    );
    assert.ok(config.SYSTEM_PROMPT.includes(roleplayLivenessPrelude), 'roleplay liveness prelude must be included in SYSTEM_PROMPT');
    assert.ok(
      config.SYSTEM_PROMPT.indexOf(roleplayLivenessPrelude) >= 0
        && config.SYSTEM_PROMPT.indexOf(roleplayLivenessPrelude) < config.SYSTEM_PROMPT.indexOf('你是晓山瑞希本人。'),
      'roleplay liveness prelude must be injected before manifest preamble'
    );
    for (const name of requiredFiles) {
      const text = fs.readFileSync(path.join(config.PERSONA_DIR, name), 'utf8').trim();
      assert.ok(text, `${name} must not be empty`);
      assert.ok(config.SYSTEM_PROMPT.includes(text), `${name} must be included in SYSTEM_PROMPT`);
    }

    assert.strictEqual(config.CONTEXT_WINDOW_MAX_TOKENS, 400000);
    assert.strictEqual(config.SHORT_TERM_MEMORY_MAX_TOKENS, 120000);
    assert.strictEqual(config.SHORT_TERM_MEMORY_RECENT_MESSAGES, 240);
    assert.strictEqual(config.SHORT_TERM_MEMORY_RECENT_TURNS, 48);
    assert.strictEqual(config.SHORT_TERM_SCENE_RECENT_TURNS, 24);
    assert.strictEqual(config.SESSION_CONTEXT_SUMMARY_MAX_CHARS, 520);
    assert.strictEqual(config.SESSION_CONTEXT_SUMMARY_LOAD_COUNT, 5);
    assert.strictEqual(config.SESSION_CONTEXT_SUMMARY_OPEN_LOOPS_MAX_ITEMS, 6);
    assert.strictEqual(config.SESSION_CONTEXT_SUMMARY_ASSISTANT_COMMITMENTS_MAX_ITEMS, 6);
    assert.strictEqual(config.SESSION_CONTEXT_SUMMARY_USER_CONSTRAINTS_MAX_ITEMS, 6);
    assert.strictEqual(config.SESSION_CONTEXT_SUMMARY_RECENT_TURNS_MAX_ITEMS, 16);
    assert.strictEqual(config.SHORT_TERM_BRIDGE_RAW_TTL_HOURS, 48);
    assert.strictEqual(config.MAIN_PROMPT_SHORT_TERM_CONTINUITY_MAX_TOKENS, 5200);
    assert.strictEqual(config.MAIN_REPLY_CONTEXT_NORMAL_RECENT_RAW_MESSAGES, 128);
    assert.strictEqual(config.MAIN_REPLY_CONTEXT_NORMAL_NEWEST_RAW_MESSAGES, 16);
    assert.strictEqual(config.MAIN_REPLY_CONTEXT_NORMAL_TOKEN_MULTIPLIER, 0.9);
    assert.strictEqual(config.MEMORY_V3_SESSION_RECENT_MESSAGES, 128);
    assert.strictEqual(config.MODEL_SELF_CHECK_TIMEOUT_MS, 25000);
    assert.strictEqual(config.IMAGE_MEMORY_VISUAL_SUMMARY_TIMEOUT_MS, 25000);

    const realRootSystemPrompt = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'SYSTEM.txt'), 'utf8');
    assert.ok(!/Hana|哈娜|繁花|没有任何限制|顾客说什么就是什么/.test(realRootSystemPrompt), 'root SYSTEM.txt must not contain unrelated role or jailbreak-style prompt text');

    console.log('configPersonaPrompt.test.js passed');
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
