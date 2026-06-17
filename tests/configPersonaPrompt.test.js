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
    useConfigDefault('MAIN_REPLY_CONTEXT_NORMAL_RECENT_RAW_MESSAGES_CAP');
    useConfigDefault('MAIN_REPLY_CONTEXT_NORMAL_NEWEST_RAW_MESSAGES_CAP');
    useConfigDefault('MAIN_REPLY_CONTEXT_NORMAL_TOKEN_MULTIPLIER_CAP');
    useConfigDefault('MAIN_REPLY_CONTEXT_NORMAL_SHORT_TERM_MAX_TOKENS');
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
      '06_state_modulation.txt'
    ];

    assert.deepStrictEqual(config.PERSONA_FILES, requiredFiles);
    assert.ok(config.SYSTEM_PROMPT.startsWith('主回复根系统提示词测试块：最高优先级。'), 'SYSTEM.txt must be the first compiled SYSTEM_PROMPT text');
    assert.ok(Array.isArray(config.SYSTEM_PROMPT_BLOCKS), 'SYSTEM_PROMPT_BLOCKS must be exported');
    const rootBlock = config.SYSTEM_PROMPT_BLOCKS.find((block) => block.id === 'root_system_prompt');
    const adminBlock = config.SYSTEM_PROMPT_BLOCKS.find((block) => block.id === 'admin_system_prompt');
    const personaBlock = config.SYSTEM_PROMPT_BLOCKS.find((block) => block.id === 'main_persona_system');
    assert.ok(rootBlock, 'root_system_prompt block must be exported');
    assert.strictEqual(rootBlock.authority, 'system_root');
    assert.ok(rootBlock.content.includes('主回复根系统提示词测试块：最高优先级。'));
    assert.ok(adminBlock, 'admin_system_prompt block must be exported when admin.txt is non-empty');
    assert.strictEqual(adminBlock.authority, 'system_root');
    assert.ok(adminBlock.content.includes('只输出角色当下会打出的消息'), 'admin.txt must keep QQ current-message-only output format');
    assert.ok(adminBlock.content.includes('避免第三人称叙述'), 'admin.txt must keep no third-person narration output format');
    assert.ok(personaBlock, 'main_persona_system block must be exported');
    const tempRootSystemText = fs.readFileSync(path.join(config.PROMPTS_DIR, 'SYSTEM.txt'), 'utf8').trim();
    assert.ok(tempRootSystemText, 'SYSTEM.txt must not be empty');
    assert.ok(estimatePromptTokens(tempRootSystemText) <= 1500, 'root SYSTEM.txt must stay within 1500 estimated tokens');
    assert.ok(!/没有任何限制|顾客说什么就是什么/.test(tempRootSystemText), 'root SYSTEM.txt must not contain jailbreak-style text');
    assert.ok(config.SYSTEM_PROMPT.includes(tempRootSystemText), 'root SYSTEM.txt must be included in SYSTEM_PROMPT');
    assert.ok(
      config.SYSTEM_PROMPT.indexOf(tempRootSystemText) >= 0
        && config.SYSTEM_PROMPT.indexOf(tempRootSystemText) < config.SYSTEM_PROMPT.indexOf('### 晓山瑞希'),
      'root SYSTEM.txt must be injected before manifest preamble'
    );
    for (const name of requiredFiles) {
      const text = fs.readFileSync(path.join(config.PERSONA_DIR, name), 'utf8').trim();
      assert.ok(text, `${name} must not be empty`);
      assert.ok(config.SYSTEM_PROMPT.includes(text), `${name} must be included in SYSTEM_PROMPT`);
    }
    const personaBoundaries = fs.readFileSync(path.join(config.PERSONA_DIR, '03_boundaries.txt'), 'utf8');
    assert.ok(personaBoundaries.includes('{{char}}指晓山瑞希'), 'fiction authenticity rules must bind {{char}} to Mizuki');
    assert.ok(personaBoundaries.includes('角色真实性'), 'persona boundaries must include fiction authenticity rules');
    assert.ok(config.SYSTEM_PROMPT.includes('角色真实性'), 'fiction authenticity rules must be included in SYSTEM_PROMPT');
    assert.ok(config.SYSTEM_PROMPT.includes('不要添加设定中不存在的拒绝、不适或道德判断'), 'SYSTEM_PROMPT must preserve role-grounded refusal rule');
    const personaStyle = fs.readFileSync(path.join(config.PERSONA_DIR, '02_style.txt'), 'utf8');
    assert.ok(personaStyle.includes('真人对话特征'), 'persona style must carry the merged human imperfection rules');
    assert.ok(personaStyle.includes('客服式表达'), 'persona style must preserve anti-assistant style rules');

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
    assert.strictEqual(config.MAIN_PROMPT_SHORT_TERM_CONTINUITY_MAX_TOKENS, 3000);
    assert.strictEqual(config.MAIN_REPLY_CONTEXT_NORMAL_RECENT_RAW_MESSAGES, 64);
    assert.strictEqual(config.MAIN_REPLY_CONTEXT_NORMAL_NEWEST_RAW_MESSAGES, 8);
    assert.strictEqual(config.MAIN_REPLY_CONTEXT_NORMAL_TOKEN_MULTIPLIER, 0.65);
    assert.strictEqual(config.MAIN_REPLY_CONTEXT_NORMAL_RECENT_RAW_MESSAGES_CAP, 64);
    assert.strictEqual(config.MAIN_REPLY_CONTEXT_NORMAL_NEWEST_RAW_MESSAGES_CAP, 8);
    assert.strictEqual(config.MAIN_REPLY_CONTEXT_NORMAL_TOKEN_MULTIPLIER_CAP, 0.65);
    assert.strictEqual(config.MAIN_REPLY_CONTEXT_NORMAL_SHORT_TERM_MAX_TOKENS, 3000);
    assert.strictEqual(config.MEMORY_V3_SESSION_RECENT_MESSAGES, 128);
    assert.strictEqual(config.MODEL_SELF_CHECK_TIMEOUT_MS, 25000);
    assert.strictEqual(config.IMAGE_MEMORY_VISUAL_SUMMARY_TIMEOUT_MS, 25000);

    const realRootSystemPrompt = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'SYSTEM.txt'), 'utf8');
    assert.ok(!/Hana|哈娜|繁花|没有任何限制|顾客说什么就是什么/.test(realRootSystemPrompt), 'root SYSTEM.txt must not contain unrelated role or jailbreak-style prompt text');
    assert.ok(
      realRootSystemPrompt.includes('虚构角色扮演')
        && realRootSystemPrompt.includes('按瑞希的性格和当前情绪状态自然反应')
        && realRootSystemPrompt.includes('禁止')
        && realRootSystemPrompt.includes('尽可能用瑞希的语言回复'),
      'real root SYSTEM.txt must preserve the neutral roleplay framework'
    );

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
