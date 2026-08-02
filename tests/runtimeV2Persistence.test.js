const assert = require('assert');

const { createRuntimePersistence } = require('../api/runtimeV2/host/persistence');

(() => {
  const calls = [];
  const store = {
    appendEvents(threadId, events) {
      calls.push(['appendEvents', threadId, events]);
    },
    saveCheckpoint(threadId, checkpoint) {
      calls.push(['saveCheckpoint', threadId, checkpoint]);
    },
    saveTransition(threadId, checkpoint, events) {
      calls.push(['saveTransition', threadId, checkpoint, events]);
    }
  };
  const persistence = createRuntimePersistence({
    appendRequestTraceEvent(event) {
      calls.push(['trace', event]);
    },
    emitEvents(events, request) {
      calls.push(['emit', events, request]);
    },
    nextTracePhase(_trace, phase, detail) {
      return { phase, detail };
    },
    normalizeRequestTrace(value) {
      return value?.traceId ? value : null;
    },
    nowTs: () => 1234,
    snapshotState: (state) => ({
      thread: state.thread,
      compacted: true
    }),
    store
  });
  const state = {
    thread: { threadId: 'thread-runtime', currentNode: 'dispatch' },
    request: {
      routePolicyKey: 'direct_chat/default',
      routeDebugKey: 'direct_chat/default',
      topRouteType: 'direct_chat',
      requestTrace: { traceId: 'trace-runtime' }
    }
  };
  const events = [
    { type: 'node_end', node: 'dispatch', durationMs: 12 }
  ];

  persistence.saveTransition(state, 'dispatch', 'running', events);
  assert.deepStrictEqual(calls[0], [
    'saveTransition',
    'thread-runtime',
    {
      status: 'running',
      node: 'dispatch',
      updatedAt: 1234,
      state: {
        thread: state.thread,
        compacted: true
      }
    },
    events
  ]);
  assert.strictEqual(calls[1][0], 'trace');
  assert.strictEqual(calls[2][0], 'emit');

  calls.length = 0;
  persistence.persistCheckpoint(state, 'prepare', 'running');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0], 'saveCheckpoint');

  calls.length = 0;
  persistence.appendRuntimeEvents(state, events);
  assert.deepStrictEqual(calls.map((call) => call[0]), ['appendEvents', 'trace', 'emit']);

  let emittedAfterFailure = false;
  const failingPersistence = createRuntimePersistence({
    appendRequestTraceEvent() {
      emittedAfterFailure = true;
    },
    emitEvents() {
      emittedAfterFailure = true;
    },
    nextTracePhase: () => ({}),
    normalizeRequestTrace: (value) => value,
    nowTs: () => 5678,
    snapshotState: (value) => value,
    store: {
      saveTransition() {
        throw new Error('forced transaction failure');
      }
    }
  });
  assert.throws(
    () => failingPersistence.saveTransition(state, 'dispatch', 'running', events),
    /forced transaction failure/
  );
  assert.strictEqual(emittedAfterFailure, false);

  console.log('runtimeV2Persistence.test.js passed');
})();
