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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function writeCheckpoint(checkpointDir, threadId, payload = {}) {
  writeJson(path.join(checkpointDir, `${threadId}.json`), {
    threadId,
    status: 'running',
    node: 'direct_reply',
    updatedAt: Date.parse('2026-07-01T00:00:00.000Z'),
    state: {
      output: {
        finalReply: 'done'
      }
    },
    ...payload
  });
}

function writeTerminalEvents(eventDir, threadId, events = []) {
  writeJson(path.join(eventDir, `${threadId}.json`), events);
}

const snapshot = { ...process.env };
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-langgraph-archive-'));
const dataDir = path.join(tempDir, 'data');
const checkpointDir = path.join(dataDir, 'langgraph_v2_checkpoints');
const eventDir = path.join(dataDir, 'langgraph_v2_events');

try {
  process.env.DATA_DIR = dataDir;
  process.env.LANGGRAPH_V2_CHECKPOINT_DIR = checkpointDir;
  process.env.LANGGRAPH_V2_EVENT_DIR = eventDir;
  process.env.API_KEY = process.env.API_KEY || 'test-key';
  clearProjectCache();

  const {
    applyArchivePlan,
    buildArchivePlan,
    classifyCheckpoint,
    parseArgs
  } = require('../scripts/archive-langgraph-v2-stale-checkpoints');
  const {
    buildLangGraphV2StoreSummary
  } = require('../utils/runtimeStatusDiagnostics/stores');

  assert.deepStrictEqual(parseArgs(['--apply', '--all', '--archive-name', 'archive_1']).dryRun, false);

  assert.strictEqual(classifyCheckpoint({
    status: 'running',
    updatedAt: Date.parse('2026-07-01T00:00:00.000Z'),
    state: { output: { finalReply: 'done' } }
  }, [
    { type: 'final_output', ts: Date.parse('2026-07-01T00:00:01.000Z') },
    { type: 'node_complete', node: 'direct_reply', ts: Date.parse('2026-07-01T00:00:02.000Z') }
  ], Date.parse('2026-07-01T01:00:00.000Z'), 30 * 60 * 1000).safeToArchive, true);

  assert.strictEqual(classifyCheckpoint({
    status: 'running',
    updatedAt: Date.parse('2026-07-01T00:00:00.000Z'),
    state: { output: { finalReply: 'done' } }
  }, [
    { type: 'node_complete', node: 'direct_reply', ts: Date.parse('2026-07-01T00:00:02.000Z') }
  ], Date.parse('2026-07-01T01:00:00.000Z'), 30 * 60 * 1000).safeToArchive, false);

  writeCheckpoint(checkpointDir, 'thread_safe');
  writeTerminalEvents(eventDir, 'thread_safe', [
    { type: 'node_start', node: 'direct_reply', ts: Date.parse('2026-07-01T00:00:00.000Z') },
    { type: 'model_reply', node: 'direct_reply', requestId: 'req_1', ts: Date.parse('2026-07-01T00:00:01.000Z') },
    { type: 'final_output', requestId: 'req_1', ts: Date.parse('2026-07-01T00:00:01.000Z') },
    { type: 'node_complete', node: 'direct_reply', requestId: 'req_1', ts: Date.parse('2026-07-01T00:00:02.000Z') }
  ]);
  writeCheckpoint(checkpointDir, 'thread_not_terminal');
  writeTerminalEvents(eventDir, 'thread_not_terminal', [
    { type: 'node_start', node: 'direct_reply', ts: Date.parse('2026-07-01T00:00:00.000Z') }
  ]);
  writeCheckpoint(checkpointDir, 'thread_completed', {
    status: 'completed',
    node: 'persist'
  });
  writeTerminalEvents(eventDir, 'thread_completed', [
    { type: 'final_output', ts: Date.parse('2026-07-01T00:00:01.000Z') },
    { type: 'node_complete', node: 'direct_reply', ts: Date.parse('2026-07-01T00:00:02.000Z') }
  ]);

  const plan = buildArchivePlan(parseArgs([
    '--all',
    '--archive-name',
    'stale_test'
  ]), new Date('2026-07-01T01:00:00.000Z'));

  assert.strictEqual(plan.dryRun, true);
  assert.strictEqual(plan.candidateCount, 2);
  assert.strictEqual(plan.selectedCount, 1);
  assert.deepStrictEqual(plan.unsafeThreadIds, ['thread_not_terminal']);
  assert.strictEqual(plan.checkpoints[0].threadId, 'thread_safe');
  assert.deepStrictEqual(plan.checkpoints[0].requestIds, ['req_1']);
  assert.strictEqual(applyArchivePlan(plan).applied, false);
  assert.strictEqual(fs.existsSync(path.join(checkpointDir, 'thread_safe.json')), true);

  const applyPlan = buildArchivePlan(parseArgs([
    '--all',
    '--apply',
    '--archive-name',
    'stale_apply'
  ]), new Date('2026-07-01T01:00:00.000Z'));
  const applyResult = applyArchivePlan(applyPlan);
  assert.strictEqual(applyResult.applied, true);
  assert.strictEqual(applyResult.moved, 1);
  assert.strictEqual(fs.existsSync(path.join(checkpointDir, 'thread_safe.json')), false);
  assert.strictEqual(fs.existsSync(path.join(checkpointDir, 'thread_not_terminal.json')), true);
  assert.strictEqual(fs.existsSync(path.join(eventDir, 'thread_safe.json')), true);
  assert.strictEqual(fs.existsSync(path.join(applyPlan.archiveDir, 'thread_safe.json')), true);
  assert.strictEqual(fs.existsSync(path.join(applyPlan.archiveDir, 'manifest.json')), true);

  const diagCheckpointDir = path.join(dataDir, 'diag_checkpoints');
  const diagEventDir = path.join(dataDir, 'diag_events');
  for (let i = 0; i < 25; i += 1) {
    writeCheckpoint(diagCheckpointDir, `thread_${i}`, {
      updatedAt: Date.parse('2026-07-01T00:00:00.000Z') - i
    });
  }
  const summary = buildLangGraphV2StoreSummary({
    storeFile: path.join(dataDir, 'diag_langgraph_v2.sqlite'),
    checkpointDir: diagCheckpointDir,
    eventDir: diagEventDir,
    now: Date.parse('2026-07-01T01:00:00.000Z'),
    staleCheckpointMs: 30 * 60 * 1000,
    safeReadDir: (dir) => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [],
    safeReadJson: (filePath, fallback) => {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (_) {
        return fallback;
      }
    },
    safeStat: (filePath) => {
      try {
        const stat = fs.statSync(filePath);
        return { exists: true, mtimeMs: stat.mtimeMs, size: stat.size };
      } catch (_) {
        return { exists: false, mtimeMs: 0, size: 0 };
      }
    }
  });
  assert.strictEqual(summary.staleRunningCheckpointCount, 25);
  assert.strictEqual(summary.staleRunningCheckpoints.length, 20);

  console.log('langGraphV2StaleCheckpointArchive.test.js passed');
} finally {
  restoreEnv(snapshot);
  clearProjectCache();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {}
}
