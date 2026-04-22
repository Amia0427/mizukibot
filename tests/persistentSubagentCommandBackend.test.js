const assert = require('assert');

function clearProjectCache() {
  const projectRoot = 'D:\\waifu\\';
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function createFakeWorkerFactory() {
  const entries = [];
  const executeCalls = [];
  let sequence = 0;

  function createEntry(sessionId = '', spec = {}) {
    const entry = {
      busy: false,
      broken: false,
      closing: false,
      executeCalls: 0,
      key: [sessionId, spec.command, spec.workDir].join('|'),
      lastHealthCheckAt: 0,
      lastUsedAt: Date.now(),
      pending: new Map(),
      ready: true,
      readyPromise: Promise.resolve(true),
      requestSequence: 0,
      reuseCount: 0,
      sessionId,
      workerId: `fake_worker_${++sequence}`,
      healthCheck: async () => true,
      execute: async ({ args = [] } = {}) => {
        entry.executeCalls += 1;
        executeCalls.push({
          args,
          sessionId,
          workerId: entry.workerId
        });
        const message = String(args[args.length - 1] || '');
        if (/\[timeout\]/i.test(message)) {
          const error = new Error('fake worker timeout');
          error.code = 'PERSISTENT_SUBAGENT_TIMEOUT';
          throw error;
        }
        if (/\[delay:(\d+)\]/i.test(message)) {
          const delayMs = Number(message.match(/\[delay:(\d+)\]/i)?.[1] || 0) || 0;
          await new Promise((resolve, reject) => {
            entry.currentReject = reject;
            entry.currentTimer = setTimeout(resolve, delayMs);
          });
        }
        if (/\[fail\]/i.test(message)) {
          const error = new Error('fake worker requested failure');
          error.code = 'PERSISTENT_SUBAGENT_FAKE_FAIL';
          throw error;
        }
        return {
          code: 0,
          stderr: '',
          stdout: `Assistant:\nreply=${message.replace(/\[delay:\d+\]/ig, '').replace(/\[fail\]/ig, '').trim()}`
        };
      },
      cancelActive() {
        if (entry.currentTimer) {
          clearTimeout(entry.currentTimer);
          entry.currentTimer = null;
        }
        if (typeof entry.currentReject === 'function') {
          const error = new Error('fake worker cancelled');
          error.code = 'SUBAGENT_CANCELLED';
          entry.currentReject(error);
          entry.currentReject = null;
        }
      },
      retire() {
        entry.closing = true;
      },
      breakWorker() {
        entry.broken = true;
      }
    };
    entries.push(entry);
    return entry;
  }

  return {
    createEntry,
    entries,
    executeCalls
  };
}

async function runCall(backend, body) {
  const call = backend.createCommandBridgeCall(body);
  return call.promise;
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.SUBAGENT_COMMAND = 'fake-command';
    process.env.SUBAGENT_WORKDIR = 'D:/waifu';
    process.env.SUBAGENT_ARGS = JSON.stringify(['--message', '{message}']);
    process.env.SUBAGENT_COMMAND_MODE = 'persistent';
    process.env.SUBAGENT_WORKER_IDLE_TTL_MS = '1000';
    process.env.SUBAGENT_WORKER_MAX_REUSE = '2';
    process.env.SUBAGENT_WORKER_HEALTHCHECK_TTL_MS = '5000';
    process.env.SUBAGENT_PERSISTENT_BUSY_QUEUE_ENABLED = 'true';
    process.env.SUBAGENT_PERSISTENT_BUSY_QUEUE_MAX = '1';
    process.env.SUBAGENT_TIMEOUT_MS = '120';

    clearProjectCache();
    const backend = require('../api/subagentBackends/commandBackend');
    backend.resetPersistentWorkerState();

    const fakeFactory = createFakeWorkerFactory();
    backend.setCommandBackendTestHooks({
      createPersistentWorker: (sessionId, spec) => fakeFactory.createEntry(sessionId, spec)
    });

    const first = await runCall(backend, {
      question: 'hello first',
      sessionId: 'sess-a',
      options: {}
    });
    assert.ok(String(first).includes('hello first'));
    assert.strictEqual(backend.getPersistentWorkerSnapshot().length, 1);
    assert.strictEqual(backend.getPersistentWorkerSnapshot()[0].reuseCount, 1);

    const firstWorkerId = backend.getPersistentWorkerSnapshot()[0].workerId;
    const second = await runCall(backend, {
      question: 'hello second',
      sessionId: 'sess-a',
      options: {}
    });
    assert.ok(String(second).includes('hello second'));
    assert.strictEqual(backend.getPersistentWorkerSnapshot().length, 0, 'worker should retire when max reuse is reached');

    const third = await runCall(backend, {
      question: 'hello third',
      sessionId: 'sess-a',
      options: {}
    });
    assert.ok(String(third).includes('hello third'));
    assert.strictEqual(backend.getPersistentWorkerSnapshot().length, 1);
    assert.notStrictEqual(backend.getPersistentWorkerSnapshot()[0].workerId, firstWorkerId);

    await new Promise((resolve) => setTimeout(resolve, 1120));
    assert.strictEqual(backend.getPersistentWorkerSnapshot().length, 0, 'idle ttl should retire worker');

    await assert.rejects(
      runCall(backend, {
        question: 'slow [timeout]',
        sessionId: 'sess-timeout',
        options: {}
      }),
      (error) => String(error?.code || '').trim() === 'PERSISTENT_SUBAGENT_TIMEOUT'
    );

    process.env.SUBAGENT_TIMEOUT_MS = '800';
    clearProjectCache();
    const backendForCancel = require('../api/subagentBackends/commandBackend');
    backendForCancel.resetPersistentWorkerState();
    const cancelFactory = createFakeWorkerFactory();
    backendForCancel.setCommandBackendTestHooks({
      createPersistentWorker: (sessionId, spec) => cancelFactory.createEntry(sessionId, spec)
    });
    const cancelCall = backendForCancel.createCommandBridgeCall({
      question: 'cancel me [delay:300]',
      sessionId: 'sess-cancel',
      options: {}
    });
    setTimeout(() => cancelCall.cancel('cancel test'), 20);
    await assert.rejects(cancelCall.promise, (error) => {
      const code = String(error?.code || '').trim();
      return code === 'SUBAGENT_CANCELLED' || code === 'PERSISTENT_SUBAGENT_TIMEOUT';
    });

    clearProjectCache();
    const backendFallback = require('../api/subagentBackends/commandBackend');
    backendFallback.resetPersistentWorkerState();
    backendFallback.setCommandBackendTestHooks({
      createPersistentWorker() {
        const error = new Error('persistent unavailable');
        error.code = 'PERSISTENT_SUBAGENT_WORKER_UNAVAILABLE';
        throw error;
      },
      createSpawnBridgeCall(spec = {}) {
        return {
          promise: Promise.resolve({
            code: 0,
            stderr: '',
            stdout: `Assistant:\nspawn=${spec.message}`
          }),
          cancel() {}
        };
      }
    });
    const fallbackReply = await runCall(backendFallback, {
      question: 'fallback path works',
      sessionId: 'sess-fallback',
      options: {}
    });
    assert.ok(String(fallbackReply).includes('fallback path works'));
    assert.strictEqual(backendFallback.__persistentWorkerStats.fallbacks >= 1, true);

    clearProjectCache();
    process.env.SUBAGENT_WORKER_MAX_REUSE = '10';
    process.env.SUBAGENT_TIMEOUT_MS = '800';
    const backendQueue = require('../api/subagentBackends/commandBackend');
    backendQueue.resetPersistentWorkerState();
    const queueFactory = createFakeWorkerFactory();
    backendQueue.setCommandBackendTestHooks({
      createPersistentWorker: (sessionId, spec) => queueFactory.createEntry(sessionId, spec)
    });
    const slowCall = backendQueue.createCommandBridgeCall({
      question: 'slow worker [delay:120]',
      sessionId: 'sess-queue',
      options: {}
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const queuedReply = await runCall(backendQueue, {
      question: 'queued worker',
      sessionId: 'sess-queue',
      options: {}
    });
    const slowReply = await slowCall.promise;
    assert.ok(String(queuedReply).includes('queued worker'));
    assert.ok(String(slowReply).includes('slow worker'));
    assert.strictEqual(backendQueue.__persistentWorkerStats.fallbacks, 0, 'busy queue should avoid spawn fallback for simple contention');

    backend.setCommandBackendTestHooks({});
    backendForCancel.setCommandBackendTestHooks({});
    backendFallback.setCommandBackendTestHooks({});
    backendQueue.setCommandBackendTestHooks({});

    console.log('persistentSubagentCommandBackend.test.js passed');
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
