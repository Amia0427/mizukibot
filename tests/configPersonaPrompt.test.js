const assert = require('assert');
const fs = require('fs');
const path = require('path');

function clearProjectCache() {
  const projectRoot = 'D:\\waifu\\';
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

(() => {
  const snapshot = { ...process.env };
  try {
    delete process.env.CONTEXT_WINDOW_MAX_TOKENS;
    delete process.env.SHORT_TERM_MEMORY_MAX_TOKENS;
    delete process.env.SHORT_TERM_MEMORY_RECENT_MESSAGES;

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
    for (const name of requiredFiles) {
      const text = fs.readFileSync(path.join(config.PERSONA_DIR, name), 'utf8').trim();
      assert.ok(text, `${name} must not be empty`);
      assert.ok(config.SYSTEM_PROMPT.includes(text), `${name} must be included in SYSTEM_PROMPT`);
    }

    assert.strictEqual(config.CONTEXT_WINDOW_MAX_TOKENS, 400000);
    assert.strictEqual(config.SHORT_TERM_MEMORY_MAX_TOKENS, 120000);
    assert.strictEqual(config.SHORT_TERM_MEMORY_RECENT_MESSAGES, 80);

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
