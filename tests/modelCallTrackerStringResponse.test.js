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

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-model-call-string-response-'));

  try {
    process.env.DATA_DIR = tempDir;
    clearProjectCache();

    const {
      finishModelCall,
      flushModelCallLogsSync,
      startModelCall
    } = require('../utils/modelCallTracker');

    const callId = startModelCall({
      source: 'normal_fast_reply',
      url: 'https://gcli.ggchan.dev/v1/chat/completions',
      request: {
        model: 'gemini-3-flash-preview-search',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 1024,
        stream: false
      }
    });

    finishModelCall(callId, {
      response: {
        status: 200,
        data: JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          model: 'gemini-3-flash-preview-search',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: ''
            },
            finish_reason: 'length'
          }],
          usage: {
            prompt_tokens: 1987,
            completion_tokens: 1024,
            total_tokens: 3011
          }
        })
      },
      attempts: 1,
      requestUrl: 'https://gcli.ggchan.dev/v1/chat/completions'
    });

    flushModelCallLogsSync();
    const rows = fs.readFileSync(path.join(tempDir, 'model-calls.ndjson'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const row = rows.find((item) => item.id === callId);
    assert.ok(row, 'model call log should contain the completed call');
    assert.strictEqual(row.finish_reason, 'length');
    assert.strictEqual(row.usage.prompt_tokens, 1987);
    assert.strictEqual(row.usage.completion_tokens, 1024);
    assert.strictEqual(row.usage.total_tokens, 3011);
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }

  console.log('modelCallTrackerStringResponse.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
