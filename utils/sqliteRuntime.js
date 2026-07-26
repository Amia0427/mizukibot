const SQLITE_MODULES = [
  { name: 'profileJournalDb', modulePath: './profileJournalDb' },
  { name: 'worldbookDb', modulePath: './worldbookDb' },
  { name: 'localPromptRecall', modulePath: './localPromptRecall' }
];

function closeLoadedSqliteConnections() {
  const closed = [];
  for (const item of SQLITE_MODULES) {
    const moduleId = require.resolve(item.modulePath);
    const loaded = require.cache[moduleId];
    if (!loaded || typeof loaded.exports.closeDb !== 'function') continue;
    loaded.exports.closeDb();
    closed.push(item.name);
  }
  return closed;
}

module.exports = {
  closeLoadedSqliteConnections
};
