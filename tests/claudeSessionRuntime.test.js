const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const { createClaudeSessionRuntime } = require('../utils/claudeSessionRuntime');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-claude-session-'));
const storeFile = path.join(tmpDir, 'claude_sessions.json');
const transcriptFile = path.join(tmpDir, 'sample.jsonl');

fs.writeFileSync(transcriptFile, [
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }),
  JSON.stringify({ type: 'result', result: 'world', is_error: false })
].join('\n'));

const runtime = createClaudeSessionRuntime({
  storeFile
});

runtime.openSession({
  sessionKey: 'qq-private:direct_1',
  claudeSessionId: '123e4567-e89b-12d3-a456-426614174000',
  transcriptPath: transcriptFile,
  status: 'open'
});

const tail1 = runtime.readTail('qq-private:direct_1');
assert.strictEqual(tail1.ok, true);
assert.ok(String(tail1.text).includes('hello'));
assert.ok(String(tail1.text).includes('world'));

const tail2 = runtime.readTail('qq-private:direct_1');
assert.strictEqual(tail2.ok, true);
assert.strictEqual(tail2.hasNewOutput, false);

runtime.closeSession('qq-private:direct_1');
const closed = runtime.getSession('qq-private:direct_1');
assert.strictEqual(closed.status, 'closed');

console.log('claudeSessionRuntime.test.js passed');
