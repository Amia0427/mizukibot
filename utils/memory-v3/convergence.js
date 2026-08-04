'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { atomicWriteJson, ensureDir, normalizeText, safeReadJson } = require('./helpers');
const { loadMemoryEvents } = require('./events');
const { loadMemoryNodes } = require('./storage');
const { createNodeFromEvent, materializeMemoryViews } = require('./materializer');
const { applyStrictArchiveRun, restoreArchiveRun } = require('./archiveRuns');
const {
  buildStrictArchiveInputHash,
  classifyStrictArchiveCandidates,
  STRICT_ARCHIVE_POLICY_VERSION
} = require('./strictArchivePolicy');
const {
  collectLegacyVectorMigrationEvents,
  migrateLegacyVectorMemoryToV3
} = require('./migration');
const {
  archiveLegacyFiles,
  buildLegacyArchiveManifest,
  legacyPathEntries,
  restoreLegacyArchive
} = require('./legacyArchive');

const DEFAULT_ROLLBACK_AFTER_MS = 8 * 60 * 1000;

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function normalizeRunId(value = '') {
  const runId = normalizeText(value);
  if (!runId || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(runId)) {
    throw new Error('Invalid convergence run id');
  }
  return runId;
}

function convergenceRunsDir() {
  return config.MEMORY_GOVERNANCE_RUNS_DIR || path.join(config.DATA_DIR, 'memory-governance', 'runs');
}

function convergenceManifestPath(runId = '') {
  return path.join(convergenceRunsDir(), `${normalizeRunId(runId)}.json`);
}

function sourceEntriesHash(entries = []) {
  return hashJson((Array.isArray(entries) ? entries : []).map((entry) => ({
    originalPath: entry.originalPath,
    exists: entry.exists === true,
    type: entry.type,
    size: Number(entry.size || 0) || 0,
    mtimeMs: Number(entry.mtimeMs || 0) || 0,
    sha256: entry.sha256 || ''
  })));
}

function loadLegacyCandidates(deps = {}) {
  const collect = deps.collectLegacyVectorMigrationEvents || collectLegacyVectorMigrationEvents;
  return collect(deps.migrationOptions || {});
}

function futureMemoryNodes(nodes = [], migrationEvents = [], existingEventIds = new Set()) {
  const byId = new Map((Array.isArray(nodes) ? nodes : [])
    .filter((node) => normalizeText(node?.id || node?.nodeId))
    .map((node) => [normalizeText(node.id || node.nodeId), node]));
  for (const event of migrationEvents) {
    if (existingEventIds.has(event.id) || byId.has(event.id)) continue;
    const node = createNodeFromEvent(event);
    if (node) byId.set(node.id, node);
  }
  return Array.from(byId.values()).sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function normalizePreflight(preflight = {}) {
  const recallGatePassed = preflight.recallGatePassed === true;
  const scopeLeakPassed = preflight.scopeLeakPassed === true;
  const summary = preflight.summary || {};
  const recallMetrics = summary.recallGate?.metrics || {};
  return {
    evaluated: preflight.evaluated === true,
    ok: preflight.evaluated === true && recallGatePassed && scopeLeakPassed,
    recallGatePassed,
    scopeLeakPassed,
    failures: Array.isArray(preflight.failures) ? preflight.failures.map(normalizeText).filter(Boolean) : [],
    reportHash: normalizeText(preflight.reportHash),
    metrics: {
      baselineRecallAt8: summary.baseline?.recallAt8 ?? null,
      baselineMrrAt8: summary.baseline?.mrrAt8 ?? null,
      candidateRecallAt8: summary.candidate?.recallAt8 ?? null,
      candidateMrrAt8: summary.candidate?.mrrAt8 ?? null,
      leakage: Number(recallMetrics.leakage || 0) || 0,
      lifecycleLeakage: Number(recallMetrics.lifecycleLeakage || 0) || 0,
      forbiddenHits: Number(recallMetrics.forbiddenHits || 0) || 0
    }
  };
}

function immutablePlanPayload(plan = {}) {
  return {
    version: plan.version,
    kind: plan.kind,
    runId: plan.runId,
    createdAt: plan.createdAt,
    policyVersion: plan.policyVersion,
    sourceFiles: plan.sourceFiles,
    sourceFilesHash: plan.sourceFilesHash,
    migration: plan.migration,
    archive: plan.archive,
    lancedb: plan.lancedb,
    preflight: plan.preflight,
    legacyArchive: plan.legacyArchive
  };
}

function buildConvergencePlan(options = {}) {
  const now = Number(options.now || Date.now()) || Date.now();
  const deps = options.deps || {};
  const migrationEvents = loadLegacyCandidates(deps);
  const sourceManifest = (deps.buildLegacyArchiveManifest || buildLegacyArchiveManifest)({
    now,
    dataDir: options.dataDir,
    targetDir: options.legacyArchiveTarget
  });
  const events = (deps.loadMemoryEvents || loadMemoryEvents)();
  const existingIds = new Set(events.map((event) => normalizeText(event.id)).filter(Boolean));
  const pendingEvents = migrationEvents.filter((event) => !existingIds.has(event.id));
  const nodes = Array.isArray(options.nodes) ? options.nodes : (deps.loadMemoryNodes || loadMemoryNodes)();
  const futureNodes = futureMemoryNodes(nodes, migrationEvents, existingIds);
  const archiveCandidates = classifyStrictArchiveCandidates(futureNodes);
  const runId = normalizeRunId(options.runId || `converge-${new Date(now).toISOString().replace(/[-:.]/g, '').slice(0, 15)}`);
  const plan = {
    version: 1,
    kind: 'memory_v3_convergence_plan',
    runId,
    createdAt: new Date(now).toISOString(),
    policyVersion: STRICT_ARCHIVE_POLICY_VERSION,
    sourceFiles: sourceManifest.entries,
    sourceFilesHash: sourceEntriesHash(sourceManifest.entries),
    migration: {
      candidateCount: migrationEvents.length,
      pendingEventCount: pendingEvents.length,
      inputHash: hashJson(migrationEvents.map((event) => event.id)),
      stableIds: migrationEvents.map((event) => event.id)
    },
    archive: {
      currentNodeCount: nodes.length,
      futureNodeCount: futureNodes.length,
      candidateCount: archiveCandidates.length,
      inputHash: buildStrictArchiveInputHash(futureNodes),
      candidates: archiveCandidates.map((item) => ({
        sourceId: item.sourceId,
        reason: item.reason,
        previousStatus: item.previousStatus,
        evidenceHash: item.evidenceHash
      }))
    },
    lancedb: {
      tableName: config.MEMORY_LANCEDB_MEMORY_TABLE,
      estimatedRows: Math.max(0, futureNodes.length - archiveCandidates.length),
      estimatedRebuildMs: Math.max(1000, Math.ceil(futureNodes.length / 256) * 250)
    },
    preflight: normalizePreflight(options.preflight),
    legacyArchive: {
      dataDir: sourceManifest.dataDir,
      targetDir: sourceManifest.targetDir,
      manifestPath: sourceManifest.manifestPath,
      manifestHash: sourceManifest.manifestHash
    },
    status: 'planned'
  };
  plan.planHash = hashJson(immutablePlanPayload(plan));
  return plan;
}

function saveConvergencePlan(plan = {}) {
  const filePath = convergenceManifestPath(plan.runId);
  const existing = safeReadJson(filePath, null);
  if (existing) {
    const saved = readConvergencePlan(filePath);
    if (saved.planHash !== plan.planHash) throw new Error(`Convergence run already exists: ${plan.runId}`);
    return saved;
  }
  ensureDir(path.dirname(filePath));
  atomicWriteJson(filePath, plan);
  return { ...plan, planPath: filePath };
}

function readConvergencePlan(input) {
  const filePath = typeof input === 'string'
    ? (input.endsWith('.json') ? path.resolve(input) : convergenceManifestPath(input))
    : '';
  const plan = filePath ? safeReadJson(filePath, null) : input;
  if (!plan || plan.kind !== 'memory_v3_convergence_plan' || !plan.runId || !plan.planHash) {
    throw new Error('Invalid memory convergence plan');
  }
  if (hashJson(immutablePlanPayload(plan)) !== plan.planHash) {
    throw new Error('Memory convergence plan hash mismatch');
  }
  return { ...plan, planPath: filePath || convergenceManifestPath(plan.runId) };
}

function verifySourceManifest(plan = {}) {
  const current = legacyPathEntries(plan.legacyArchive?.dataDir || config.DATA_DIR, plan.legacyArchive?.targetDir || '');
  return sourceEntriesHash(current) === plan.sourceFilesHash;
}

async function evaluateConvergencePreflight(options = {}) {
  const report = options.report || await (options.runMemoryGate || require('../../scripts/diagnose-memory-ops').runMemoryOpsFromArgv)([
    'lancedb-gate',
    '--auto-gold',
    '--limit',
    String(Math.max(1, Number(options.limit || 50) || 50))
  ]);
  const summary = report.summary || {};
  const recallGate = summary.recallGate || {};
  const regressionGate = summary.regressionGate || {};
  const metrics = recallGate.metrics || {};
  const recallGatePassed = regressionGate.ok === true && Number(metrics.judgedCases || 0) > 0;
  const scopeLeakPassed = Number(metrics.leakage || 0) === 0
    && Number(metrics.lifecycleLeakage || 0) === 0
    && Number(metrics.forbiddenHits || 0) === 0;
  const failures = [];
  if (!recallGatePassed) failures.push('recall_regression_gate_failed');
  if (!scopeLeakPassed) failures.push('scope_leak_gate_failed');
  return {
    evaluated: true,
    ok: recallGatePassed && scopeLeakPassed,
    recallGatePassed,
    scopeLeakPassed,
    failures,
    reportHash: hashJson(summary),
    summary
  };
}

async function backfillAllMemoryEmbeddings(options = {}) {
  if (options.backfillEmbeddings === false) return { ok: true, skipped: true, reason: 'disabled' };
  const runBackfill = options.runBackfill || require('../../scripts/backfill-memory-v3-embeddings').runBackfill;
  return runBackfill({
    dryRun: false,
    source: 'memory',
    retryFailed: true,
    lowResourceMode: false,
    maxBatches: Math.max(1, Number(options.maxEmbeddingBatches || 1000) || 1000)
  });
}

function validateLanceDbState(sync = {}, inspection = {}, projectionFreshness = {}) {
  const coverage = inspection.coverage?.memory || {};
  const overlap = inspection.storageOverlap || inspection.coverage?.storageOverlap || {};
  const failures = [];
  if (sync.ok === false) failures.push('lancedb_reconcile_failed');
  if (inspection.ok === false) failures.push('lancedb_inspection_failed');
  if (projectionFreshness.projectionStale === true) failures.push('memory_projection_stale');
  if (Number(coverage.readyButNotSynced || 0) > 0) failures.push('missing_lancedb_rows');
  if (Number(coverage.staleTableRows || 0) > 0) failures.push('stale_lancedb_rows');
  if (Number(overlap.missingVectorRows?.count || 0) > 0) failures.push('storage_overlap_missing_rows');
  if (Number(overlap.vectorOnlyRows?.count || 0) > 0) failures.push('storage_overlap_orphan_rows');
  if (Number(overlap.unexpectedVectorRows?.count || 0) > 0) failures.push('storage_overlap_unexpected_rows');
  const recommendedAction = overlap.recommendedAction || inspection.repairPlan?.recommendedAction || 'none';
  if (recommendedAction !== 'none') failures.push('storage_overlap_action_required');
  return { ok: failures.length === 0, failures, recommendedAction };
}

async function reconcileLanceDb(options = {}) {
  if (options.reconcileLanceDb === false) return { ok: true, skipped: true, reason: 'disabled' };
  const sync = options.syncLanceDb || require('../../scripts/sync-lancedb-memory-index').syncMemoryRowsLowMemory;
  const inspect = options.inspectLanceDb || require('../../scripts/sync-lancedb-memory-index').buildSyncSummary;
  const write = await sync({
    full: true,
    fullReconcile: true,
    deleteStaleRows: true,
    dir: options.lanceDbDir
  });
  const inspection = await inspect({
    dryRun: true,
    full: true,
    fullReconcile: true,
    deleteStaleRows: true,
    dir: options.lanceDbDir,
    includeRows: false
  });
  const inspectProjection = options.inspectProjection
    || require('./diagnostics').diagnoseProjectionFreshness;
  const projectionFreshness = inspectProjection();
  return {
    ...validateLanceDbState(write, inspection, projectionFreshness),
    sync: write,
    inspection,
    projectionFreshness
  };
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function inspectMaintenanceWindow(options = {}) {
  const queue = options.queue || require('../postReplyJobQueue').getPostReplyJobQueue();
  const processing = queue.listJobs(['processing']).length;
  const stateFile = options.stateFile
    || process.env.MIZUKIBOT_POST_REPLY_WORKER_STATE_FILE
    || path.join(config.DATA_DIR, 'runtime', 'post-reply-worker', 'worker-state.json');
  const workerState = safeReadJson(stateFile, null);
  const stage = normalizeText(workerState?.stage).toLowerCase();
  const pid = Math.max(0, Number(workerState?.pid || 0) || 0);
  const workerRunning = ['starting', 'ready', 'draining'].includes(stage) && isProcessAlive(pid);
  const failures = [];
  if (processing > 0) failures.push('post_reply_processing_not_zero');
  if (workerRunning) failures.push('post_reply_worker_not_stopped');
  return {
    ok: failures.length === 0,
    processing,
    workerStage: stage || 'not_found',
    workerPid: pid,
    failures
  };
}

function saveRunState(plan = {}, updates = {}) {
  const next = { ...plan, ...updates };
  delete next.planPath;
  atomicWriteJson(plan.planPath, next);
  return { ...next, planPath: plan.planPath };
}

function checkpointRunState(plan, status, application, options = {}) {
  const saved = saveRunState(plan, { status, application });
  if (typeof options.onCheckpoint === 'function') options.onCheckpoint(saved);
  return saved;
}

function deadlineGuard(startedAt, options = {}) {
  const now = options.clock || Date.now;
  const rollbackAfterMs = Math.max(1000, Number(options.rollbackAfterMs || DEFAULT_ROLLBACK_AFTER_MS) || DEFAULT_ROLLBACK_AFTER_MS);
  if (now() - startedAt >= rollbackAfterMs) throw new Error('Convergence maintenance deadline reached');
}

async function rollbackPartialApplication(plan, application, options = {}) {
  const legacyManifestPath = application.legacyArchive?.manifestPath;
  const restoredLegacy = legacyManifestPath && fs.existsSync(legacyManifestPath)
    ? (options.restoreLegacyArchive || restoreLegacyArchive)(legacyManifestPath)
    : { ok: true, skipped: true, reason: 'no_legacy_archive' };
  const restoredArchive = application.archiveRunId
    ? await (options.restoreArchiveRun || restoreArchiveRun)(application.archiveRunId, { materialize: false, now: options.now })
    : { ok: true, skipped: true, reason: 'no_archive_run' };
  const materialized = restoredArchive.restored?.length > 0
    ? (options.materializeMemoryViews || materializeMemoryViews)({
        force: true,
        scheduleEmbeddingBackfill: false,
        source: 'memory_v3_convergence_failed_restore'
      })
    : { ok: true, skipped: true, reason: 'no_restored_events' };
  return { restoredArchive, restoredLegacy, materialized };
}

async function applyConvergencePlan(input, options = {}) {
  const plan = readConvergencePlan(input);
  if (plan.status === 'applied') return { ...plan, ok: true, alreadyApplied: true };
  if (plan.status !== 'planned') return { ok: false, reason: `run_${plan.status || 'invalid'}`, runId: plan.runId };
  if (options.verifyGates !== false && plan.preflight?.ok !== true) {
    return { ok: false, reason: 'preflight_gates_failed', runId: plan.runId, planPath: plan.planPath };
  }
  if (options.verifySources !== false && !verifySourceManifest(plan)) {
    return { ok: false, reason: 'source_files_changed', runId: plan.runId, planPath: plan.planPath };
  }

  const deps = options.deps || {};
  const migrationEvents = loadLegacyCandidates(deps);
  const migrationInputHash = hashJson(migrationEvents.map((event) => event.id));
  if (migrationInputHash !== plan.migration.inputHash) {
    return { ok: false, reason: 'migration_input_changed', runId: plan.runId, planPath: plan.planPath };
  }
  const existingEvents = (deps.loadMemoryEvents || loadMemoryEvents)();
  const existingIds = new Set(existingEvents.map((event) => normalizeText(event.id)).filter(Boolean));
  const nodes = (deps.loadMemoryNodes || loadMemoryNodes)();
  const futureNodes = futureMemoryNodes(nodes, migrationEvents, existingIds);
  if (buildStrictArchiveInputHash(futureNodes) !== plan.archive.inputHash) {
    return { ok: false, reason: 'archive_input_changed', runId: plan.runId, planPath: plan.planPath };
  }
  const maintenanceWindow = options.verifyMaintenanceWindow === false
    ? { ok: true, skipped: true, reason: 'disabled' }
    : (deps.inspectMaintenanceWindow || inspectMaintenanceWindow)(options.maintenanceWindow);
  if (maintenanceWindow.ok !== true) {
    return {
      ok: false,
      reason: 'maintenance_window_not_ready',
      runId: plan.runId,
      planPath: plan.planPath,
      maintenanceWindow
    };
  }

  const clock = options.clock || Date.now;
  const startedAt = clock();
  const application = {
    startedAt: new Date(startedAt).toISOString(),
    maintenanceWindow,
    migration: null,
    archiveRunId: `${plan.runId}-archive`,
    archive: null,
    materialized: null,
    embeddingBackfill: null,
    lancedb: null,
    legacyArchive: null
  };
  let runState = plan;
  try {
    runState = checkpointRunState(runState, 'applying', application, options);
    deadlineGuard(startedAt, options);
    application.migration = await (deps.migrateLegacyVectorMemoryToV3 || migrateLegacyVectorMemoryToV3)({
      events: migrationEvents,
      skipMaterialize: true
    });
    if (application.migration?.ok === false) throw new Error('Legacy memory incremental import failed');
    runState = checkpointRunState(runState, 'applying', application, options);
    deadlineGuard(startedAt, options);
    application.archive = await (deps.applyStrictArchiveRun || applyStrictArchiveRun)({
      runId: application.archiveRunId,
      nodes: futureNodes,
      materialize: false,
      scheduleEmbeddingBackfill: false,
      now: options.now
    });
    if (application.archive?.ok === false) throw new Error('Strict memory archive run failed');
    runState = checkpointRunState(runState, 'applying', application, options);
    deadlineGuard(startedAt, options);
    const materialized = (deps.materializeMemoryViews || materializeMemoryViews)({
      force: true,
      scheduleEmbeddingBackfill: false,
      source: 'memory_v3_convergence'
    });
    if (materialized?.ok === false || materialized?.deferred === true) throw new Error('Memory V3 materialization failed');
    application.materialized = materialized?.stats || null;
    runState = checkpointRunState(runState, 'applying', application, options);
    deadlineGuard(startedAt, options);
    application.embeddingBackfill = await backfillAllMemoryEmbeddings({ ...options, ...(deps.embedding || {}) });
    if (application.embeddingBackfill.ok === false || Number(application.embeddingBackfill.remaining || 0) > 0) {
      throw new Error('Memory embedding backfill incomplete');
    }
    runState = checkpointRunState(runState, 'applying', application, options);
    deadlineGuard(startedAt, options);
    application.lancedb = await reconcileLanceDb({ ...options, ...(deps.lancedb || {}) });
    if (application.lancedb.ok !== true) throw new Error('LanceDB reconciliation gate failed');
    runState = checkpointRunState(runState, 'applying', application, options);
    deadlineGuard(startedAt, options);
    application.legacyArchive = {
      manifestPath: plan.legacyArchive.manifestPath,
      status: 'pending'
    };
    runState = checkpointRunState(runState, 'applying', application, options);
    application.legacyArchive = options.archiveLegacy === false
      ? { ok: true, skipped: true, reason: 'disabled' }
      : (deps.archiveLegacyFiles || archiveLegacyFiles)({
          manifest: {
            version: 1,
            kind: 'memory_vector_legacy_archive',
            createdAt: plan.createdAt,
            dataDir: plan.legacyArchive.dataDir,
            targetDir: plan.legacyArchive.targetDir,
            manifestPath: plan.legacyArchive.manifestPath,
            entries: plan.sourceFiles,
            manifestHash: plan.legacyArchive.manifestHash
          }
    });
    if (application.legacyArchive?.ok === false) throw new Error('Legacy memory archive failed');
    runState = checkpointRunState(runState, 'applying', application, options);
    deadlineGuard(startedAt, options);
    application.completedAt = new Date(clock()).toISOString();
    application.durationMs = Math.max(0, clock() - startedAt);
    const saved = checkpointRunState(runState, 'applied', application, options);
    return { ...saved, ok: true };
  } catch (error) {
    let rollback;
    try {
      rollback = await rollbackPartialApplication(runState, application, { ...options, ...deps });
    } catch (rollbackError) {
      rollback = { ok: false, error: rollbackError.message };
    }
    application.failedAt = new Date(clock()).toISOString();
    application.durationMs = Math.max(0, clock() - startedAt);
    application.error = error.message;
    application.rollback = rollback;
    const saved = checkpointRunState(runState, 'failed', application, options);
    return { ...saved, ok: false, reason: 'application_failed' };
  }
}

async function rollbackConvergenceRun(input, options = {}) {
  const plan = readConvergencePlan(input);
  if (plan.status === 'rolled_back') return { ...plan, ok: true, alreadyRolledBack: true };
  if (!['applying', 'applied', 'failed'].includes(plan.status)) {
    return { ok: false, reason: 'run_not_applied', runId: plan.runId };
  }
  const application = plan.application || {};
  const legacyManifestPath = application.legacyArchive?.manifestPath || plan.legacyArchive?.manifestPath;
  const restoredLegacy = legacyManifestPath && fs.existsSync(legacyManifestPath)
    ? (options.restoreLegacyArchive || restoreLegacyArchive)(legacyManifestPath)
    : { ok: true, skipped: true, reason: 'no_legacy_archive' };
  const restoredArchive = application.archiveRunId
    ? await (options.restoreArchiveRun || restoreArchiveRun)(application.archiveRunId, { materialize: false, now: options.now })
    : { ok: true, skipped: true, reason: 'no_archive_run' };
  const materialized = (options.materializeMemoryViews || materializeMemoryViews)({
    force: true,
    scheduleEmbeddingBackfill: options.scheduleEmbeddingBackfill !== false,
    source: 'memory_v3_convergence_rollback'
  });
  const rolledBackAt = new Date(Number(options.now || Date.now()) || Date.now()).toISOString();
  const rollbackHistory = Array.isArray(plan.rollbackHistory) ? plan.rollbackHistory.slice() : [];
  rollbackHistory.push({ rolledBackAt, restoredArchive, restoredLegacy, materialized: materialized?.stats || null });
  const saved = saveRunState(plan, { status: 'rolled_back', rollbackHistory });
  return { ...saved, ok: restoredArchive.ok !== false && restoredLegacy.ok !== false && materialized?.ok !== false };
}

module.exports = {
  applyConvergencePlan,
  backfillAllMemoryEmbeddings,
  buildConvergencePlan,
  convergenceManifestPath,
  evaluateConvergencePreflight,
  hashJson,
  immutablePlanPayload,
  inspectMaintenanceWindow,
  loadLegacyCandidates,
  readConvergencePlan,
  reconcileLanceDb,
  rollbackConvergenceRun,
  saveConvergencePlan,
  sourceEntriesHash,
  validateLanceDbState,
  verifySourceManifest
};
