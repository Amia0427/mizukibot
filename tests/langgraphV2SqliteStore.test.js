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

function restoreEnv(snapshot) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  Object.assign(process.env, snapshot);
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

    console.log('langgraphV2SqliteStore.test.js passed');
    return true;
  } finally {
    restoreEnv(env);
    clearProjectCache();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})();
