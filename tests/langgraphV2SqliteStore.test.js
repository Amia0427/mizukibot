const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function restoreEnv(snapshot) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  Object.assign(process.env, snapshot);
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

module.exports = (() => {
  const env = { ...process.env };
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-langgraph-v2-store-'));
  const dataDir = path.join(tempRoot, 'data');
  const storeFile = path.join(tempRoot, 'runtime', 'langgraph.sqlite');
  const checkpointDir = path.join(tempRoot, 'legacy', 'checkpoints');
  const eventDir = path.join(tempRoot, 'legacy', 'events');

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = dataDir;
    delete process.env.LANGGRAPH_V2_STORE_FILE;
    clearProjectCache();

    const defaultConfig = require('../config');
    assert.strictEqual(
      defaultConfig.LANGGRAPH_V2_STORE_FILE,
      path.join(dataDir, 'langgraph_v2.sqlite')
    );

    process.env.LANGGRAPH_V2_STORE_FILE = storeFile;
    process.env.LANGGRAPH_V2_CHECKPOINT_DIR = checkpointDir;
    process.env.LANGGRAPH_V2_EVENT_DIR = eventDir;
    clearProjectCache();

    const Database = require('better-sqlite3');
    const { createCheckpointStore } = require('../utils/langgraphV2Store');
    assert.throws(
      () => createCheckpointStore({ checkpointDir, eventDir }),
      (error) => error?.code === 'LANGGRAPH_V2_STORE_FILE_REQUIRED'
    );

    const store = createCheckpointStore({ storeFile, checkpointDir, eventDir });
    assert.strictEqual(store.storeFile, storeFile);
    assert.strictEqual(fs.existsSync(storeFile), true);
    assert.strictEqual(fs.existsSync(checkpointDir), false);
    assert.strictEqual(fs.existsSync(eventDir), false);
    store.close();
    assert.doesNotThrow(() => store.close());
    assert.throws(() => store.loadCheckpoint('closed-thread'), /not open|closed/i);

    const db = new Database(storeFile, { readonly: true, fileMustExist: true });
    try {
      assert.strictEqual(db.pragma('journal_mode', { simple: true }), 'wal');
      const tables = db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'langgraph_v2_%'
        ORDER BY name
      `).pluck().all();
      assert.deepStrictEqual(tables, [
        'langgraph_v2_checkpoints',
        'langgraph_v2_events',
        'langgraph_v2_legacy_tombstones',
        'langgraph_v2_quarantined_records'
      ]);
      const indexes = db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index' AND name LIKE 'langgraph_v2_%'
        ORDER BY name
      `).pluck().all();
      assert.ok(indexes.includes('langgraph_v2_checkpoints_status_updated_at'));
      assert.ok(indexes.includes('langgraph_v2_events_thread_id_id'));
    } finally {
      db.close();
    }

    const transitionFile = path.join(tempRoot, 'transition.sqlite');
    const transitionStore = createCheckpointStore({
      storeFile: transitionFile,
      checkpointDir,
      eventDir
    });
    try {
      transitionStore.saveTransition('thread-atomic', {
        status: 'running',
        node: 'dispatch',
        updatedAt: 100,
        state: { thread: { threadId: 'thread-atomic' }, version: 1 }
      }, [
        { type: 'checkpoint', sequence: -1, ts: 100 },
        { type: 'node_end', sequence: 0, ts: 101 }
      ]);
      assert.strictEqual(transitionStore.loadCheckpoint('thread-atomic').state.version, 1);
      assert.deepStrictEqual(
        transitionStore.loadEvents('thread-atomic').map((event) => event.sequence),
        [-1, 0]
      );

      const triggerDb = new Database(transitionFile);
      try {
        triggerDb.exec(`
          CREATE TRIGGER reject_second_transition_event
          BEFORE INSERT ON langgraph_v2_events
          WHEN json_extract(NEW.event_json, '$.sequence') = 2
          BEGIN
            SELECT RAISE(ABORT, 'forced event failure');
          END;
        `);
      } finally {
        triggerDb.close();
      }

      assert.throws(() => transitionStore.saveTransition('thread-atomic', {
        status: 'running',
        node: 'draft_reply',
        updatedAt: 200,
        state: { thread: { threadId: 'thread-atomic' }, version: 2 }
      }, [
        { type: 'node_start', sequence: 1, ts: 200 },
        { type: 'node_end', sequence: 2, ts: 201 }
      ]), /forced event failure/);
      assert.strictEqual(transitionStore.loadCheckpoint('thread-atomic').state.version, 1);
      assert.deepStrictEqual(
        transitionStore.loadEvents('thread-atomic').map((event) => event.sequence),
        [-1, 0]
      );
    } finally {
      transitionStore.close();
    }

    fs.mkdirSync(checkpointDir, { recursive: true });
    fs.mkdirSync(eventDir, { recursive: true });
    const legacyCheckpointFile = path.join(checkpointDir, 'legacy-target.json');
    const legacyEventFile = path.join(eventDir, 'legacy-target.json');
    const probeCheckpointFile = path.join(checkpointDir, 'legacy-probe.json');
    fs.writeFileSync(legacyCheckpointFile, JSON.stringify({
      threadId: 'legacy-target',
      status: 'running',
      node: 'prepare',
      updatedAt: 300,
      state: { version: 'legacy' }
    }), 'utf8');
    fs.writeFileSync(legacyEventFile, JSON.stringify([
      { type: 'legacy_event', sequence: 1, ts: 300 }
    ]), 'utf8');
    fs.writeFileSync(probeCheckpointFile, '{broken', 'utf8');
    const legacyBefore = [legacyCheckpointFile, legacyEventFile, probeCheckpointFile].map((file) => ({
      file,
      hash: sha256(file),
      mtimeMs: fs.statSync(file).mtimeMs
    }));

    const legacyStoreFile = path.join(tempRoot, 'legacy-read.sqlite');
    const legacyStore = createCheckpointStore({
      storeFile: legacyStoreFile,
      checkpointDir,
      eventDir
    });
    try {
      const inspectDb = new Database(legacyStoreFile);
      try {
        assert.strictEqual(inspectDb.prepare('SELECT COUNT(*) FROM langgraph_v2_checkpoints').pluck().get(), 0);
        assert.strictEqual(inspectDb.prepare('SELECT COUNT(*) FROM langgraph_v2_events').pluck().get(), 0);
        assert.strictEqual(inspectDb.prepare('SELECT COUNT(*) FROM langgraph_v2_quarantined_records').pluck().get(), 0);
      } finally {
        inspectDb.close();
      }

      assert.strictEqual(legacyStore.loadCheckpoint('legacy-target').state.version, 'legacy');
      assert.deepStrictEqual(
        legacyStore.loadEvents('legacy-target').map((event) => event.sequence),
        [1]
      );

      const afterLazyReadDb = new Database(legacyStoreFile);
      try {
        assert.strictEqual(afterLazyReadDb.prepare('SELECT COUNT(*) FROM langgraph_v2_checkpoints').pluck().get(), 0);
        assert.strictEqual(afterLazyReadDb.prepare('SELECT COUNT(*) FROM langgraph_v2_events').pluck().get(), 0);
        assert.strictEqual(afterLazyReadDb.prepare('SELECT COUNT(*) FROM langgraph_v2_quarantined_records').pluck().get(), 0);
      } finally {
        afterLazyReadDb.close();
      }

      legacyStore.saveTransition('legacy-target', {
        status: 'completed',
        node: 'persist',
        updatedAt: 400,
        state: { version: 'sqlite' }
      }, [
        { type: 'sqlite_event', sequence: 2, ts: 400 }
      ]);
      assert.strictEqual(legacyStore.loadCheckpoint('legacy-target').state.version, 'sqlite');
      assert.deepStrictEqual(
        legacyStore.loadEvents('legacy-target').map((event) => event.sequence),
        [1, 2]
      );

      const clearTriggerDb = new Database(legacyStoreFile);
      try {
        clearTriggerDb.exec(`
          CREATE TRIGGER reject_legacy_tombstone
          BEFORE INSERT ON langgraph_v2_legacy_tombstones
          BEGIN
            SELECT RAISE(ABORT, 'forced tombstone failure');
          END;
        `);
      } finally {
        clearTriggerDb.close();
      }
      assert.throws(() => legacyStore.clear('legacy-target'), /forced tombstone failure/);
      assert.strictEqual(legacyStore.loadCheckpoint('legacy-target').state.version, 'sqlite');
      assert.deepStrictEqual(
        legacyStore.loadEvents('legacy-target').map((event) => event.sequence),
        [1, 2]
      );

      const dropTriggerDb = new Database(legacyStoreFile);
      try {
        dropTriggerDb.exec('DROP TRIGGER reject_legacy_tombstone');
      } finally {
        dropTriggerDb.close();
      }
      legacyStore.clear('legacy-target');
      assert.strictEqual(legacyStore.loadCheckpoint('legacy-target'), null);
      assert.deepStrictEqual(legacyStore.loadEvents('legacy-target'), []);

      legacyStore.saveTransition('legacy-target', {
        status: 'running',
        node: 'prepare',
        updatedAt: 500,
        state: { version: 'new-sqlite' }
      }, [
        { type: 'sqlite_event', sequence: 3, ts: 500 }
      ]);
      assert.strictEqual(legacyStore.loadCheckpoint('legacy-target').state.version, 'new-sqlite');
      assert.deepStrictEqual(
        legacyStore.loadEvents('legacy-target').map((event) => event.sequence),
        [3]
      );
      const tombstoneDb = new Database(legacyStoreFile);
      try {
        assert.strictEqual(
          tombstoneDb.prepare('SELECT COUNT(*) FROM langgraph_v2_legacy_tombstones WHERE thread_id = ?').pluck().get('legacy-target'),
          1
        );
      } finally {
        tombstoneDb.close();
      }
      for (const snapshot of legacyBefore) {
        assert.strictEqual(sha256(snapshot.file), snapshot.hash);
        assert.strictEqual(fs.statSync(snapshot.file).mtimeMs, snapshot.mtimeMs);
      }
    } finally {
      legacyStore.close();
    }

    console.log('langgraphV2SqliteStore.test.js passed');
    return true;
  } finally {
    restoreEnv(env);
    clearProjectCache();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})();
