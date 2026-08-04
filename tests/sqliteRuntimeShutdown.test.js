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

module.exports = (() => {
  const env = { ...process.env };
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-sqlite-runtime-close-'));
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempRoot;
    process.env.PROFILE_JOURNAL_DB_ENABLED = 'true';
    process.env.PROFILE_JOURNAL_DB_FILE = path.join(tempRoot, 'profile_journal.sqlite');
    process.env.PERSONA_WORLDBOOK_DB_PRIMARY_READ = 'true';
    process.env.PERSONA_WORLDBOOK_DB_FILE = process.env.PROFILE_JOURNAL_DB_FILE;
    process.env.LOCAL_PROMPT_RECALL_ENABLED = 'true';
    process.env.LOCAL_PROMPT_RECALL_DB_FILE = path.join(tempRoot, 'local_prompt_recall.sqlite');
    clearProjectCache();

    const profileJournalDb = require('../utils/profileJournalDb');
    const worldbookDb = require('../utils/worldbookDb');
    const localPromptRecall = require('../utils/localPromptRecall');
    const langgraphV2Store = require('../utils/langgraphV2Store');
    const profileDb = profileJournalDb.getDb({ force: true });
    const worldbookDbHandle = worldbookDb.getDb({ force: true });
    const promptDb = localPromptRecall.getDb({ force: true, createIfMissing: true });
    const langgraphStoreFile = path.join(tempRoot, 'langgraph_v2.sqlite');
    const langgraphStore = langgraphV2Store.createCheckpointStore({
      storeFile: langgraphStoreFile
    });
    langgraphStore.saveCheckpoint('close-test', {
      status: 'completed',
      node: 'persist',
      updatedAt: 1,
      state: { value: 'close test value' }
    });
    profileJournalDb.upsertProfileFact({
      id: 'close-test',
      userId: 'u-close',
      type: 'like',
      fieldKey: 'preference_like',
      value: 'close test value',
      status: 'active',
      sourceKind: 'explicit',
      confidence: 1,
      createdAt: 1,
      updatedAt: 1
    });

    const { closeLoadedSqliteConnections } = require('../utils/sqliteRuntime');
    assert.deepStrictEqual(closeLoadedSqliteConnections().sort(), [
      'langgraphV2Store',
      'localPromptRecall',
      'profileJournalDb',
      'worldbookDb'
    ]);
    assert.strictEqual(profileDb.open, false);
    assert.strictEqual(worldbookDbHandle.open, false);
    assert.strictEqual(promptDb.open, false);
    assert.throws(() => langgraphStore.loadCheckpoint('close-test'), /not open|closed/i);

    const reopened = profileJournalDb.getDb({ force: true });
    assert.notStrictEqual(reopened, profileDb);
    assert.strictEqual(reopened.prepare('SELECT value FROM profile_facts WHERE id = ?').pluck().get('close-test'), 'close test value');
    const reopenedLanggraphStore = langgraphV2Store.createCheckpointStore({
      storeFile: langgraphStoreFile
    });
    assert.strictEqual(reopenedLanggraphStore.loadCheckpoint('close-test').state.value, 'close test value');
    reopenedLanggraphStore.close();
    profileJournalDb.closeDb();
    return true;
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in env)) delete process.env[key];
    }
    Object.assign(process.env, env);
    clearProjectCache();
  }
})();

console.log('sqliteRuntimeShutdown.test.js passed');
