const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const WORKER_FLAG = 'MIZUKI_SQLITE_CONCURRENCY_WORKER';
const WRITES_PER_WORKER = 30;

function runProfileWorker(workerId) {
  const profileJournalDb = require('../utils/profileJournalDb');
  const now = Date.now();
  for (let index = 0; index < WRITES_PER_WORKER; index += 1) {
    const result = profileJournalDb.upsertProfileFact({
      id: `profile-${workerId}-${index}`,
      userId: `user-${workerId}`,
      type: 'like',
      fieldKey: 'preference_like',
      value: `profile value ${workerId}-${index}`,
      status: 'active',
      sourceKind: 'explicit',
      confidence: 1,
      createdAt: now + index,
      updatedAt: now + index
    });
    if (!result.ok) throw new Error(result.reason);
  }
  profileJournalDb.resetDbForTests();
}

function runWorldbookWorker(workerId) {
  const worldbookDb = require('../utils/worldbookDb');
  const now = Date.now();
  for (let index = 0; index < WRITES_PER_WORKER; index += 1) {
    const moduleId = `worldbook-${workerId}-${index}`;
    const result = worldbookDb.upsertWorldbookEntry({
      id: moduleId,
      moduleId,
      title: moduleId,
      body: `worldbook body ${workerId}-${index}`,
      status: 'active',
      updatedAt: now + index
    });
    if (!result.ok) throw new Error(result.reason);
  }
  worldbookDb.resetDbForTests();
}

function runWorker() {
  const workerId = process.env.SQLITE_WORKER_ID;
  if (process.env.SQLITE_WORKER_KIND === 'profile') runProfileWorker(workerId);
  else runWorldbookWorker(workerId);
}

function spawnWorker(kind, workerId, dbFile) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn(process.execPath, ['--unhandled-rejections=strict', __filename], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        [WORKER_FLAG]: '1',
        SQLITE_WORKER_KIND: kind,
        SQLITE_WORKER_ID: workerId,
        DATA_DIR: path.dirname(dbFile),
        PROFILE_JOURNAL_DB_ENABLED: 'true',
        PROFILE_JOURNAL_AUTO_CLEAN_ENABLED: 'false',
        PROFILE_JOURNAL_DB_FILE: dbFile,
        PERSONA_WORLDBOOK_DB_PRIMARY_READ: 'true',
        PERSONA_WORLDBOOK_DB_FILE: dbFile
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`SQLite worker ${kind}-${workerId} exited ${code}: ${stderr}`));
    });
  });
}

async function runTest() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-sqlite-concurrency-'));
  const dbFile = path.join(tempRoot, 'profile_journal.sqlite');
  await Promise.all([
    spawnWorker('profile', 'a', dbFile),
    spawnWorker('profile', 'b', dbFile),
    spawnWorker('worldbook', 'a', dbFile),
    spawnWorker('worldbook', 'b', dbFile)
  ]);

  const Database = require('better-sqlite3');
  const {
    DEFAULT_BUSY_TIMEOUT_MS,
    openSqliteDatabase,
    runQuickCheck,
    runWalCheckpoint
  } = require('../utils/sqliteConnection');
  const db = openSqliteDatabase(Database, dbFile);
  try {
    assert.strictEqual(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.strictEqual(db.pragma('foreign_keys', { simple: true }), 1);
    assert.strictEqual(db.pragma('busy_timeout', { simple: true }), DEFAULT_BUSY_TIMEOUT_MS);
    assert.strictEqual(db.prepare('SELECT COUNT(*) FROM profile_facts').pluck().get(), WRITES_PER_WORKER * 2);
    assert.strictEqual(db.prepare('SELECT COUNT(*) FROM worldbook_entries').pluck().get(), WRITES_PER_WORKER * 2);
    assert.deepStrictEqual(runQuickCheck(db), { ok: true, messages: ['ok'] });
    const checkpoint = runWalCheckpoint(db, 'TRUNCATE');
    assert.strictEqual(checkpoint.busy, 0);
    assert.ok(checkpoint.checkpointedFrames >= 0);
    assert.throws(() => runWalCheckpoint(db, 'INVALID'), /unsupported WAL checkpoint mode/);
  } finally {
    db.close();
  }

  const { checkDatabase } = require('../scripts/check-sqlite-integrity');
  const integrity = checkDatabase(dbFile);
  assert.strictEqual(integrity.ok, true);
  assert.strictEqual(integrity.integrity.ok, true);
  const corruptFile = path.join(tempRoot, 'corrupt.sqlite');
  fs.writeFileSync(corruptFile, 'not a sqlite database', 'utf8');
  const corrupt = checkDatabase(corruptFile);
  assert.strictEqual(corrupt.ok, false);
  assert.match(corrupt.error, /database|encrypted/i);
  console.log('sqliteConcurrency.test.js passed');
}

if (process.env[WORKER_FLAG] === '1') {
  try {
    runWorker();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
} else {
  module.exports = runTest().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
