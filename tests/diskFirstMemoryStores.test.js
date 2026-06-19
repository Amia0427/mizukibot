const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-disk-first-memory-'));
process.env.DATA_DIR = tempRoot;
process.env.SESSION_CONTEXT_SUMMARY_FILE = path.join(tempRoot, 'legacy-session-summaries.json');
fs.mkdirSync(tempRoot, { recursive: true });

const {
  appendSessionTurn,
  createSessionBackedStore,
  getSessionContext,
  listUserSessionKeys,
  updateSessionState
} = require('../utils/shortTermSessionStore');
const {
  getRecentSessionContextSummaries,
  saveSessionContextSummary
} = require('../utils/sessionContextSummaryStore');

module.exports = (() => {
  const userId = 'u_disk_first';
  const sessionKey = `direct:${userId}`;
  appendSessionTurn(sessionKey, { role: 'user', content: 'hello' });
  updateSessionState(sessionKey, { activeTopic: 'disk first', presence: { state: 'waiting' } });

  const context = getSessionContext(sessionKey);
  assert.strictEqual(context.history.length, 1);
  assert.strictEqual(context.state.activeTopic, 'disk first');
  assert.ok(listUserSessionKeys(userId).includes(sessionKey));

  const historyStore = createSessionBackedStore('history');
  historyStore[sessionKey].push({ role: 'assistant', content: 'saved' });
  assert.strictEqual(getSessionContext(sessionKey).history.length, 2);

  const saved = saveSessionContextSummary({
    sessionKey,
    userId,
    summary: 'summary on disk'
  }, { now: Date.now() });
  assert.strictEqual(saved.saved, true);
  const summaries = getRecentSessionContextSummaries(sessionKey, { limit: 1 });
  assert.strictEqual(summaries.length, 1);
  assert.strictEqual(summaries[0].summary, 'summary on disk');

  console.log('diskFirstMemoryStores.test.js passed');
})();
