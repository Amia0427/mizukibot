const fs = require('fs');
const path = require('path');
const config = require('../config');
const {
  safeReadJson,
  sanitizeThreadId
} = require('../utils/langgraphV2Store');

const DEFAULT_STALE_MS = 30 * 60 * 1000;

function normalizeText(value = '') {
  return String(value || '').trim();
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    dryRun: true,
    all: false,
    threadIds: [],
    archiveName: '',
    reason: 'historical_langgraph_v2_stale_checkpoints',
    staleMs: DEFAULT_STALE_MS
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = normalizeText(argv[i]);
    if (arg === '--apply') out.dryRun = false;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--all') out.all = true;
    else if (arg === '--thread-id' && argv[i + 1]) {
      out.threadIds.push(normalizeText(argv[i + 1]));
      i += 1;
    } else if (arg.startsWith('--thread-id=')) {
      out.threadIds.push(normalizeText(arg.slice('--thread-id='.length)));
    } else if (arg === '--archive-name' && argv[i + 1]) {
      out.archiveName = normalizeText(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--archive-name=')) {
      out.archiveName = normalizeText(arg.slice('--archive-name='.length));
    } else if (arg === '--reason' && argv[i + 1]) {
      out.reason = normalizeText(argv[i + 1]) || out.reason;
      i += 1;
    } else if (arg.startsWith('--reason=')) {
      out.reason = normalizeText(arg.slice('--reason='.length)) || out.reason;
    } else if (arg === '--stale-ms' && argv[i + 1]) {
      out.staleMs = Number(argv[i + 1]) || out.staleMs;
      i += 1;
    } else if (arg.startsWith('--stale-ms=')) {
      out.staleMs = Number(arg.slice('--stale-ms='.length)) || out.staleMs;
    }
  }
  out.threadIds = Array.from(new Set(out.threadIds.filter(Boolean).map(sanitizeThreadId)));
  out.staleMs = Math.max(1000, Number(out.staleMs) || DEFAULT_STALE_MS);
  return out;
}

function formatArchiveName(now = new Date()) {
  const stamp = now.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `stale-checkpoints-${stamp}`;
}

function isSafeArchiveName(value = '') {
  return /^[A-Za-z0-9_.-]+$/.test(normalizeText(value));
}

function readJsonFile(filePath, fallback = null) {
  return safeReadJson(filePath, fallback);
}

function listCheckpointFiles(checkpointDir = '') {
  if (!fs.existsSync(checkpointDir)) return [];
  return fs.readdirSync(checkpointDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name);
}

function latestEvent(events = []) {
  return events.reduce((latest, event) => {
    const ts = Number(event?.ts || 0);
    return ts >= Number(latest?.ts || 0) ? event : latest;
  }, null);
}

function countEventsByType(events = []) {
  return events.reduce((acc, event) => {
    const key = normalizeText(event?.type || 'unknown') || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function hasDirectReplyTerminal(events = []) {
  return events.some((event) => event?.type === 'node_complete' && event?.node === 'direct_reply');
}

function hasFinalOutput(events = []) {
  return events.some((event) => event?.type === 'final_output');
}

function hasFinalReply(checkpoint = {}) {
  const output = checkpoint?.state?.output && typeof checkpoint.state.output === 'object'
    ? checkpoint.state.output
    : {};
  return Boolean(String(output.finalReply || output.reply || output.text || '').trim());
}

function collectRequestIds(events = []) {
  const ids = new Set();
  for (const event of events) {
    const id = normalizeText(event?.requestId || event?.request_id);
    if (id) ids.add(id);
  }
  return Array.from(ids);
}

function classifyCheckpoint(checkpoint = {}, events = [], nowMs = Date.now(), staleMs = DEFAULT_STALE_MS) {
  const status = normalizeText(checkpoint.status || 'unknown') || 'unknown';
  const updatedAt = Number(checkpoint.updatedAt || 0);
  const active = new Set(['running', 'queued', 'reviewing']).has(status);
  const stale = active && updatedAt > 0 && nowMs - updatedAt > staleMs;
  const terminalDirectReply = hasDirectReplyTerminal(events);
  const finalOutput = hasFinalOutput(events);
  const finalReply = hasFinalReply(checkpoint);
  const safeToArchive = Boolean(stale && terminalDirectReply && finalOutput && finalReply);
  const latest = latestEvent(events);
  return {
    status,
    updatedAt,
    updatedAtIso: updatedAt > 0 ? new Date(updatedAt).toISOString() : '',
    ageMs: updatedAt > 0 ? Math.max(0, nowMs - updatedAt) : 0,
    active,
    stale,
    terminalDirectReply,
    finalOutput,
    finalReply,
    safeToArchive,
    latestEventType: normalizeText(latest?.type),
    latestEventNode: normalizeText(latest?.node),
    latestEventAt: latest?.ts ? new Date(Number(latest.ts)).toISOString() : '',
    eventCount: events.length,
    eventCountsByType: countEventsByType(events),
    requestIds: collectRequestIds(events)
  };
}

function toPlanEntry(paths = {}, file = '', checkpoint = {}, events = [], nowMs = Date.now(), staleMs = DEFAULT_STALE_MS) {
  const threadId = sanitizeThreadId(checkpoint.threadId || path.basename(file, '.json'));
  const sourcePath = path.join(paths.checkpointDir, `${threadId}.json`);
  const eventPath = path.join(paths.eventDir, `${threadId}.json`);
  const stat = fs.existsSync(sourcePath) ? fs.statSync(sourcePath) : { size: 0, mtimeMs: 0 };
  const classification = classifyCheckpoint(checkpoint, events, nowMs, staleMs);
  return {
    threadId,
    file: `${threadId}.json`,
    node: normalizeText(checkpoint.node),
    sourcePath,
    eventPath,
    archivePath: path.join(paths.archiveDir, `${threadId}.json`),
    checkpointBytes: stat.size,
    checkpointMtimeIso: stat.mtimeMs ? new Date(stat.mtimeMs).toISOString() : '',
    ...classification
  };
}

function publicEntry(entry = {}) {
  return {
    threadId: entry.threadId,
    file: entry.file,
    status: entry.status,
    node: entry.node,
    updatedAt: entry.updatedAtIso,
    ageMs: entry.ageMs,
    checkpointBytes: entry.checkpointBytes,
    eventCount: entry.eventCount,
    latestEventType: entry.latestEventType,
    latestEventNode: entry.latestEventNode,
    terminalDirectReply: entry.terminalDirectReply,
    finalOutput: entry.finalOutput,
    finalReply: entry.finalReply,
    safeToArchive: entry.safeToArchive,
    requestIds: entry.requestIds
  };
}

function buildArchivePlan(args = {}, now = new Date()) {
  if (args.all !== true && (!Array.isArray(args.threadIds) || args.threadIds.length === 0)) {
    throw new Error('pass --all or at least one --thread-id');
  }
  const archiveName = normalizeText(args.archiveName) || formatArchiveName(now);
  if (!isSafeArchiveName(archiveName)) throw new Error(`unsafe archive name: ${archiveName}`);
  const archiveRoot = path.join(config.DATA_DIR, 'langgraph_v2_checkpoints_archive');
  const archiveDir = path.join(archiveRoot, archiveName);
  const paths = {
    checkpointDir: config.LANGGRAPH_V2_CHECKPOINT_DIR,
    eventDir: config.LANGGRAPH_V2_EVENT_DIR,
    archiveRoot,
    archiveDir
  };
  const requested = new Set((args.threadIds || []).map(sanitizeThreadId));
  const nowMs = now.getTime();
  const allEntries = listCheckpointFiles(paths.checkpointDir)
    .map((file) => {
      const checkpoint = readJsonFile(path.join(paths.checkpointDir, file), null);
      if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return null;
      const threadId = sanitizeThreadId(checkpoint.threadId || path.basename(file, '.json'));
      const events = readJsonFile(path.join(paths.eventDir, `${threadId}.json`), []);
      return toPlanEntry(paths, file, checkpoint, Array.isArray(events) ? events : [], nowMs, args.staleMs);
    })
    .filter(Boolean);
  const candidates = allEntries.filter((entry) => (
    args.all === true
      ? entry.stale
      : requested.has(entry.threadId)
  ));
  const selected = candidates.filter((entry) => entry.safeToArchive);
  const found = new Set(allEntries.map((entry) => entry.threadId));
  const missingThreadIds = Array.from(requested).filter((threadId) => !found.has(threadId));
  const unsafeThreadIds = candidates
    .filter((entry) => !entry.safeToArchive)
    .map((entry) => entry.threadId);
  return {
    generatedAt: now.toISOString(),
    dryRun: args.dryRun !== false,
    reason: normalizeText(args.reason) || 'historical_langgraph_v2_stale_checkpoints',
    checkpointDir: paths.checkpointDir,
    eventDir: paths.eventDir,
    archiveDir,
    staleMs: args.staleMs,
    requestedCount: args.all === true ? candidates.length : requested.size,
    candidateCount: candidates.length,
    selectedCount: selected.length,
    missingThreadIds,
    unsafeThreadIds,
    summary: {
      selectedCount: selected.length,
      withRequestIds: selected.filter((entry) => entry.requestIds.length > 0).length,
      terminalDirectReply: selected.filter((entry) => entry.terminalDirectReply).length,
      finalOutput: selected.filter((entry) => entry.finalOutput).length,
      finalReply: selected.filter((entry) => entry.finalReply).length
    },
    checkpoints: selected
  };
}

function writeManifest(plan = {}, applyResult = {}) {
  const manifestPath = path.join(plan.archiveDir, 'manifest.json');
  const payload = {
    generatedAt: plan.generatedAt,
    appliedAt: new Date().toISOString(),
    reason: plan.reason,
    checkpointDir: plan.checkpointDir,
    eventDir: plan.eventDir,
    archiveDir: plan.archiveDir,
    staleMs: plan.staleMs,
    selectedCount: plan.selectedCount,
    summary: plan.summary,
    applyResult,
    checkpoints: plan.checkpoints.map(publicEntry)
  };
  fs.writeFileSync(manifestPath, JSON.stringify(payload, null, 2), 'utf8');
  return manifestPath;
}

function applyArchivePlan(plan = {}) {
  if (plan.dryRun) {
    return { applied: false, reason: 'dry_run', moved: 0 };
  }
  fs.mkdirSync(plan.archiveDir, { recursive: true });
  let moved = 0;
  for (const checkpoint of plan.checkpoints) {
    if (!fs.existsSync(checkpoint.sourcePath)) continue;
    if (fs.existsSync(checkpoint.archivePath)) {
      throw new Error(`archive target already exists: ${checkpoint.archivePath}`);
    }
    fs.renameSync(checkpoint.sourcePath, checkpoint.archivePath);
    moved += 1;
  }
  const applyResult = { applied: true, moved };
  applyResult.manifestPath = writeManifest(plan, applyResult);
  return applyResult;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const plan = buildArchivePlan(args);
  const applyResult = applyArchivePlan(plan);
  console.log(JSON.stringify({
    ...plan,
    applyResult,
    checkpoints: plan.checkpoints.map(publicEntry)
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  classifyCheckpoint,
  buildArchivePlan,
  applyArchivePlan,
  main
};
