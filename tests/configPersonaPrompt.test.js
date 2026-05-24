const assert = require('assert');
const fs = require('fs');
const path = require('path');

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
  try {
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
    useConfigDefault('MEMORY_V3_SESSION_RECENT_MESSAGES');

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
    const roleplayLivenessPrelude = fs.readFileSync(path.join(config.PERSONA_DIR, '00_roleplay_liveness_prelude.txt'), 'utf8').trim();
    assert.ok(roleplayLivenessPrelude, '00_roleplay_liveness_prelude.txt must not be empty');
    assert.ok(estimatePromptTokens(roleplayLivenessPrelude) <= 1500, 'roleplay liveness prelude must stay within 1500 estimated tokens');
    assert.ok(!roleplayLivenessPrelude.includes('线下或叙事场景'), 'roleplay liveness prelude must not define offline/narrative mode');
    assert.ok(roleplayLivenessPrelude.includes('当前项目没有线下模式'), 'roleplay liveness prelude must explicitly avoid offline mode');
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
    assert.strictEqual(config.MAIN_PROMPT_SHORT_TERM_CONTINUITY_MAX_TOKENS, 3600);
    assert.strictEqual(config.MEMORY_V3_SESSION_RECENT_MESSAGES, 96);

    console.log('configPersonaPrompt.test.js passed');
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
      process.env[key] = value;
    }
    clearProjectCache();
  }
})();
