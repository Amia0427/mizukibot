const SQLITE_MODULES = [
  { name: 'toolAuthorization', modulePath: '../api/toolAuthorization' },
  { name: 'langgraphV2Store', modulePath: './langgraphV2Store' },
  { name: 'profileJournalDb', modulePath: './profileJournalDb' },
  { name: 'conversationVariables', modulePath: './conversationVariables' },
  { name: 'worldbookDb', modulePath: './worldbookDb' },
  { name: 'localPromptRecall', modulePath: './localPromptRecall' }
];

function closeLoadedSqliteConnections() {
  const closed = [];
  for (const item of SQLITE_MODULES) {
    const moduleId = require.resolve(item.modulePath);
    const loaded = require.cache[moduleId];
    const close = loaded?.exports?.closeDb || loaded?.exports?.closeToolAuthorizationStore;
    if (typeof close !== 'function') continue;
    close();
    closed.push(item.name);
  }
  return closed;
}

module.exports = {
  closeLoadedSqliteConnections
};
