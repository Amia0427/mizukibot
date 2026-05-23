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

function restoreEnv(snapshot = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

module.exports = (() => {
  const snapshot = { ...process.env };
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-self-improvement-post-reply-'));
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempRoot;
    process.env.SELF_IMPROVEMENT_ENABLED = 'true';
    process.env.SELF_IMPROVEMENT_EXTRACT_MIN_CONFIDENCE = '0.1';
    process.env.SELF_IMPROVEMENT_STORE_DIR = path.join(tempRoot, 'self_improvement');
    process.env.SELF_IMPROVEMENT_RULES_FILE = path.join(tempRoot, 'self_improvement', 'promoted_rules.json');
    process.env.SELF_IMPROVEMENT_GUIDES_FILE = path.join(tempRoot, 'self_improvement', 'skill_guides.json');
    clearProjectCache();

    const {
      readEvents,
      storeExtractedSelfImprovementItems
    } = require('../utils/selfImprovementRuntime');

    const stored = storeExtractedSelfImprovementItems('u1', [{
      kind: 'strategy',
      summary: 'Use concise direct replies',
      details: 'The turn worked because the reply stayed short.',
      suggested_action: 'Keep similar replies concise.',
      confidence: 0.9,
      evidence: ['reply was short']
    }], {
      jobId: 'job-ref-1',
      postReplyJobId: 'job-ref-1',
      turnId: 'turn-ref-1',
      turnIds: ['turn-ref-1', 'turn-ref-2'],
      sourceSessionId: 'session-ref-1',
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat'
    });

    assert.strictEqual(stored.length, 1);
    const event = readEvents().find((item) => item.id === stored[0].id);
    assert.ok(event, 'stored self improvement event should be readable');
    assert.strictEqual(event.jobId, 'job-ref-1');
    assert.strictEqual(event.postReplyJobId, 'job-ref-1');
    assert.strictEqual(event.turnId, 'turn-ref-1');
    assert.deepStrictEqual(event.turnIds, ['turn-ref-1', 'turn-ref-2']);
    assert.strictEqual(event.sourceSessionId, 'session-ref-1');

    console.log('selfImprovementPostReplyRef.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})();
