const assert = require('assert');
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

module.exports = (async () => {
  const snapshot = { ...process.env };
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    clearProjectCache();

    const {
      buildRuntimePrompt,
      buildRuntimePromptBlock,
      clearRuntimePromptCaches
    } = require('../utils/runtimePrompts');
    const first = buildRuntimePrompt('streaming-segmentation', { maxSegments: 3 });
    const second = buildRuntimePrompt('streaming-segmentation', { maxSegments: 3 });

    assert.strictEqual(first, second);
    assert.ok(first.includes('3'));

    clearRuntimePromptCaches();
    const fs = require('fs');
    const originalReadFileSync = fs.readFileSync;
    let runtimeTemplateReads = 0;
    try {
      fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
        if (String(filePath || '').endsWith(path.join('prompts', 'runtime', 'review-payload.txt'))) {
          runtimeTemplateReads += 1;
        }
        return originalReadFileSync.call(this, filePath, ...args);
      };

      const longOutput = 'x'.repeat(300);
      const firstBlock = buildRuntimePromptBlock('review-payload', {
        routeKey: 'chat/default',
        question: longOutput,
        subagentOutput: longOutput
      });
      const secondBlock = buildRuntimePromptBlock('review-payload', {
        routeKey: 'chat/default',
        question: longOutput,
        subagentOutput: longOutput
      });

      assert.strictEqual(firstBlock.content, secondBlock.content);
      assert.strictEqual(runtimeTemplateReads, 1);
    } finally {
      fs.readFileSync = originalReadFileSync;
    }

    console.log('runtimePromptCache.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
