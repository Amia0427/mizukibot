const assert = require('assert');
const {
  clearResearchBriefs,
  createSessionResearchCache,
  getRecentResearchBriefs,
  saveResearchBrief
} = require('../utils/sessionResearchCache');

module.exports = (() => {
  clearResearchBriefs();
  saveResearchBrief({ sessionKey: 's1', userId: 'u1', query: 'OpenAI docs', status: 'completed', summary: 'OpenAI documentation summary', sources: [{ url: 'https://example.com' }] }, { now: 1000, ttlMs: 10000 });
  assert.strictEqual(getRecentResearchBriefs('s1', { query: 'docs', now: 2000 }).length, 1);
  assert.strictEqual(getRecentResearchBriefs('s1', { query: 'unrelated', now: 2000 }).length, 0);
  assert.strictEqual(getRecentResearchBriefs('s1', { query: 'docs', now: 20000 }).length, 0);
  clearResearchBriefs();

  let now = 0;
  let sweep = null;
  let intervalClears = 0;
  let unrefCalls = 0;
  const cache = createSessionResearchCache({
    now: () => now,
    maxSessions: 128,
    defaultTtlMs: 20000,
    sweepIntervalMs: 1000,
    setInterval(callback) {
      sweep = callback;
      return {
        unref() {
          unrefCalls += 1;
        }
      };
    },
    clearInterval() {
      intervalClears += 1;
    }
  });

  for (let index = 0; index < 10000; index += 1) {
    now += 1;
    cache.saveResearchBrief({
      sessionKey: `bulk-${index}`,
      query: `query ${index}`,
      status: 'completed',
      summary: `summary ${index}`
    });
  }

  let metrics = cache.getMetrics();
  assert.strictEqual(metrics.scope, 'process-local');
  assert.deepStrictEqual(metrics.size, { sessions: 128, briefs: 128 });
  assert.strictEqual(metrics.evictions, 9872);
  assert.strictEqual(metrics.expired, 0);
  assert.strictEqual(unrefCalls, 1);
  assert.strictEqual(cache.getRecentResearchBriefs('bulk-0').length, 0);
  assert.strictEqual(cache.getRecentResearchBriefs('bulk-9999').length, 1);

  now = 40001;
  sweep();
  metrics = cache.getMetrics();
  assert.deepStrictEqual(metrics.size, { sessions: 0, briefs: 0 });
  assert.strictEqual(metrics.expired, 128);
  assert.strictEqual(intervalClears, 1);

  cache.saveResearchBrief({
    sessionKey: 'after-sweep',
    query: 'restart timer',
    status: 'completed',
    summary: 'timer restarts after the cache becomes empty'
  });
  assert.strictEqual(unrefCalls, 2);
  cache.stop();
  assert.strictEqual(intervalClears, 2);

  now = 1;
  const lruCache = createSessionResearchCache({
    now: () => now,
    maxSessions: 2,
    defaultTtlMs: 10000,
    autoSweep: false
  });
  lruCache.saveResearchBrief({ sessionKey: 'old-accessed', summary: 'keep me' });
  now += 1;
  lruCache.saveResearchBrief({ sessionKey: 'old-idle', summary: 'evict me' });
  now += 1;
  assert.strictEqual(lruCache.getRecentResearchBriefs('old-accessed').length, 1);
  now += 1;
  lruCache.saveResearchBrief({ sessionKey: 'new', summary: 'new value' });
  assert.strictEqual(lruCache.getRecentResearchBriefs('old-idle').length, 0);
  assert.strictEqual(lruCache.getRecentResearchBriefs('old-accessed').length, 1);
  assert.strictEqual(lruCache.getMetrics().evictions, 1);

  for (let index = 0; index < 9; index += 1) {
    now += 1;
    lruCache.saveResearchBrief({
      sessionKey: 'new',
      id: `brief-${index}`,
      status: 'completed',
      summary: `brief ${index}`
    });
  }
  assert.strictEqual(lruCache.getRecentResearchBriefs('new', { limit: 8 }).length, 8);
  lruCache.stop();

  now = 0;
  const compatibilityCache = createSessionResearchCache({
    now: () => now,
    maxSessions: 4,
    defaultTtlMs: 10000,
    autoSweep: false
  });
  compatibilityCache.saveResearchBrief({ summary: 'unknown user session', ttlMs: 1 });
  compatibilityCache.saveResearchBrief({ id: 'failed', sessionKey: 'filtered', status: 'failed', summary: 'failed' });
  compatibilityCache.saveResearchBrief({ id: 'empty', sessionKey: 'filtered', status: 'completed', summary: '' });
  assert.strictEqual(compatibilityCache.getRecentResearchBriefs('').length, 1);
  assert.strictEqual(compatibilityCache.getRecentResearchBriefs('filtered').length, 0);
  assert.strictEqual(compatibilityCache.getRecentResearchBriefs('', { now: 999 }).length, 1);
  assert.strictEqual(compatibilityCache.getRecentResearchBriefs('', { now: 1000 }).length, 0);
  compatibilityCache.clearResearchBriefs('filtered');
  assert.deepStrictEqual(compatibilityCache.getMetrics().size, { sessions: 0, briefs: 0 });
  compatibilityCache.saveResearchBrief({ sessionKey: 'one', summary: 'one' });
  compatibilityCache.saveResearchBrief({ sessionKey: 'two', summary: 'two' });
  compatibilityCache.clearResearchBriefs();
  assert.deepStrictEqual(compatibilityCache.getMetrics().size, { sessions: 0, briefs: 0 });

  now = 0;
  const pressureCache = createSessionResearchCache({
    now: () => now,
    maxSessions: 2,
    defaultTtlMs: 1000,
    autoSweep: false
  });
  pressureCache.saveResearchBrief({ sessionKey: 'expired', summary: 'expired' });
  now = 1;
  pressureCache.saveResearchBrief({ sessionKey: 'live', summary: 'live', ttlMs: 2000 });
  now = 1000;
  pressureCache.saveResearchBrief({ sessionKey: 'new', summary: 'new' });
  assert.deepStrictEqual(pressureCache.getMetrics().size, { sessions: 2, briefs: 2 });
  assert.strictEqual(pressureCache.getMetrics().expired, 1);
  assert.strictEqual(pressureCache.getMetrics().evictions, 0);
  console.log('sessionResearchCache.test.js passed');
})();
