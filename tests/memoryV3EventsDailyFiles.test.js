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

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-events-'));
  const eventsDir = path.join(tempDir, 'memory-v3', 'events');
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDir;
    process.env.MEMORY_V3_DIR = path.join(tempDir, 'memory-v3');
    process.env.MEMORY_V3_EVENTS_DIR = eventsDir;
    clearProjectCache();

    const {
      appendMemoryEvent,
      eventFileForTs,
      listMemoryEventFiles,
      loadMemoryEvents
    } = require('../utils/memory-v3/events');

    const ts = Date.UTC(2026, 3, 29, 12, 30, 0);
    assert.strictEqual(path.basename(eventFileForTs(ts)), '2026-04-29.ndjson');

    await appendMemoryEvent({
      type: 'turn_received',
      ts,
      userId: 'user-a',
      text: 'daily event'
    });

    const legacyMonthFile = path.join(eventsDir, '2026-04.ndjson');
    fs.writeFileSync(legacyMonthFile, `${JSON.stringify({
      type: 'turn_replied',
      ts: ts - 1,
      userId: 'user-a',
      text: 'legacy month event'
    })}\n`, 'utf8');

    const fileNames = listMemoryEventFiles().map((file) => path.basename(file));
    assert.ok(fileNames.includes('2026-04.ndjson'));
    assert.ok(fileNames.includes('2026-04-29.ndjson'));

    const loaded = loadMemoryEvents();
    assert.ok(loaded.some((event) => event.text === 'daily event'));
    assert.ok(loaded.some((event) => event.text === 'legacy month event'));

    console.log('memoryV3EventsDailyFiles.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
