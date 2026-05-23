const assert = require('assert');
const { EventEmitter } = require('events');

function clearProjectCache() {
  const projectRoot = 'D:\\waifu\\';
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.SUBAGENT_COMMAND = 'fake-command';
    process.env.SUBAGENT_WORKDIR = 'D:/waifu';

    clearProjectCache();
    const backend = require('../api/subagentBackends/commandBackend');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {} };
    child.pid = 12345;
    child.exitCode = null;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };

    const entry = {
      child,
      closing: false,
      broken: false,
      key: 'utf8-session|fake-command|D:/waifu',
      pending: new Map(),
      ready: false,
      readyPromise: null,
      resolveReady: null,
      rejectReady: null,
      stderr: ''
    };
    entry.readyPromise = new Promise((resolve, reject) => {
      entry.resolveReady = resolve;
      entry.rejectReady = reject;
    });
    backend.__testInternals.attachWorkerListeners(entry);
    const ready = entry.readyPromise;
    const rawReady = Buffer.from('{"type":"ready"}\n', 'utf8');
    child.stdout.emit('data', rawReady.subarray(0, 5));
    child.stdout.emit('data', rawReady.subarray(5));
    await ready;

    const resultPromise = new Promise((resolve, reject) => {
      entry.pending.set('run_1', { resolve, reject });
    });
    const rawResponse = Buffer.from('{"type":"response","id":"run_1","ok":true,"result":{"code":0,"stdout":"Assistant:\\n你坏了啊","stderr":""}}\n', 'utf8');
    const splitIndex = rawResponse.indexOf(Buffer.from('坏', 'utf8')) + 1;
    child.stdout.emit('data', rawResponse.subarray(0, splitIndex));
    child.stdout.emit('data', rawResponse.subarray(splitIndex));

    const result = await resultPromise;
    assert.strictEqual(result.stdout, 'Assistant:\n你坏了啊');
    assert.ok(!result.stdout.includes('�'));

    console.log('persistentSubagentUtf8Stream.test.js passed');
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
      process.env[key] = value;
    }
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
