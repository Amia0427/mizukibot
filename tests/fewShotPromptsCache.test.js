const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function restoreEnv(snapshot = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

function writeRequiredPersonaFiles(personaDir) {
  fs.mkdirSync(personaDir, { recursive: true });
  for (const name of [
    '01_identity.txt',
    '02_style.txt',
    '03_boundaries.txt',
    '04_behavior.txt',
    '06_state_modulation.txt',
    '07_opus_localization.txt'
  ]) {
    fs.writeFileSync(path.join(personaDir, name), `persona-${name}`, 'utf8');
  }
}

function writeFewShotIndex(filePath, exampleId, keyword) {
  fs.writeFileSync(filePath, JSON.stringify({
    version: 2,
    max_examples: 1,
    examples: [
      {
        id: exampleId,
        priority: 10,
        match: {
          keywords_any: [keyword],
          regex_any: [`${keyword}.{0,8}测试`]
        },
        user: `${keyword} user`,
        assistant: `${keyword} assistant`
      }
    ]
  }), 'utf8');
}

module.exports = (() => {
  const snapshot = { ...process.env };
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-few-shot-cache-'));
  const promptsDir = path.join(tempRoot, 'prompts');
  const personaDir = path.join(promptsDir, 'persona');
  const indexFile = path.join(personaDir, '05_examples.index.json');

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = path.join(tempRoot, 'data');
    process.env.PROMPTS_DIR = promptsDir;
    writeRequiredPersonaFiles(personaDir);
    writeFewShotIndex(indexFile, 'first_example', '缓存');
    clearProjectCache();

    const fewShotPrompts = require('../utils/fewShotPrompts');
    fewShotPrompts.clearFewShotIndexCache();

    const originalReadFileSync = fs.readFileSync;
    let indexReads = 0;
    try {
      fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
        if (path.resolve(String(filePath || '')) === path.resolve(indexFile)) {
          indexReads += 1;
        }
        return originalReadFileSync.call(this, filePath, ...args);
      };

      const first = fewShotPrompts.buildDynamicFewShotPrompt({
        question: '缓存测试',
        routePolicyKey: 'chat/default',
        topRouteType: 'chat',
        maxExamples: 1
      });
      const second = fewShotPrompts.buildDynamicFewShotPrompt({
        question: '缓存测试',
        routePolicyKey: 'chat/default',
        topRouteType: 'chat',
        maxExamples: 1
      });

      assert.ok(first.includes('[示例:first_example]'));
      assert.strictEqual(first, second);
      assert.strictEqual(indexReads, 1);

      writeFewShotIndex(indexFile, 'second_example', '刷新');
      const changed = fewShotPrompts.buildDynamicFewShotPrompt({
        question: '刷新测试',
        routePolicyKey: 'chat/default',
        topRouteType: 'chat',
        maxExamples: 1
      });

      assert.ok(changed.includes('[示例:second_example]'));
      assert.strictEqual(indexReads, 2);

      fs.writeFileSync(indexFile, JSON.stringify({
        version: 2,
        max_examples: 2,
        examples: [
          {
            id: 'plain_match',
            priority: 90,
            match: { keywords_any: ['继续'] },
            user: 'plain user',
            assistant: 'plain assistant'
          },
          {
            id: 'linked_worldbook',
            priority: 1,
            match: {
              worldbook_ids: ['wb_mizuki_future_two_tracks']
            },
            user: 'linked user',
            assistant: 'linked assistant'
          }
        ]
      }), 'utf8');
      const linked = fewShotPrompts.buildDynamicFewShotPrompt({
        question: '继续',
        routePolicyKey: 'chat/default',
        topRouteType: 'chat',
        maxExamples: 2,
        activeWorldbookIds: ['wb_mizuki_future_two_tracks'],
        preferredExampleIds: ['linked_worldbook']
      });
      assert.ok(linked.indexOf('[示例:linked_worldbook]') >= 0);
      assert.ok(linked.indexOf('[示例:plain_match]') >= 0);
      assert.ok(linked.indexOf('[示例:linked_worldbook]') < linked.indexOf('[示例:plain_match]'));
    } finally {
      fs.readFileSync = originalReadFileSync;
    }

    console.log('fewShotPromptsCache.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})();
