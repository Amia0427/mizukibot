#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const config = require('../config');
const {
  openSqliteDatabase,
  runQuickCheck,
  runWalCheckpoint
} = require('../utils/sqliteConnection');

function configuredDatabaseFiles() {
  return Array.from(new Set([
    config.PROFILE_JOURNAL_DB_FILE,
    config.PERSONA_WORLDBOOK_DB_FILE,
    config.LOCAL_PROMPT_RECALL_DB_FILE
  ].filter(Boolean).map((file) => path.resolve(file))));
}

function checkDatabase(file) {
  if (!fs.existsSync(file)) return { file, ok: true, skipped: true, reason: 'file_missing' };
  let db;
  try {
    db = openSqliteDatabase(Database, file);
    const integrity = runQuickCheck(db);
    const checkpoint = runWalCheckpoint(db, 'PASSIVE');
    return { file, ok: integrity.ok, integrity, checkpoint };
  } catch (error) {
    return { file, ok: false, error: error.message };
  } finally {
    if (db) db.close();
  }
}

function main(args = process.argv.slice(2)) {
  const files = args.length > 0
    ? Array.from(new Set(args.map((file) => path.resolve(file))))
    : configuredDatabaseFiles();
  const results = files.map(checkDatabase);
  process.stdout.write(`${JSON.stringify({ ok: results.every((item) => item.ok), results }, null, 2)}\n`);
  if (results.some((item) => !item.ok)) process.exitCode = 1;
  return results;
}

if (require.main === module) main();

module.exports = {
  checkDatabase,
  configuredDatabaseFiles,
  main
};
