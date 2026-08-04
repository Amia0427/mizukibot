'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-convergence-'));
process.env.DATA_DIR = tempRoot;
process.env.PROMPTS_DIR = 'D:\\waifu\\prompts';
process.env.MEMORY_GOVERNANCE_RUNS_DIR = path.join(tempRoot, 'memory-governance', 'runs');

for (const name of ['memory_items.json', 'memory_index.json', 'memory_library.json', 'memory_projection.json']) {
  fs.writeFileSync(path.join(tempRoot, name), '{}', 'utf8');
}
fs.mkdirSync(path.join(tempRoot, 'memory-shards'), { recursive: true });
fs.writeFileSync(path.join(tempRoot, 'memory-shards', 'items.json'), '{}', 'utf8');

const {
  applyConvergencePlan,
  buildConvergencePlan,
  inspectMaintenanceWindow,
  readConvergencePlan,
  rollbackConvergenceRun,
  saveConvergencePlan
} = require('../utils/memory-v3/convergence');

const migrationEvents = [{
  id: 'm3_legacy_pending',
  type: 'migration_bootstrap',
  ts: 10,
  userId: 'u_converge',
  scopeType: 'personal',
  source: 'memory_items',
  sourceKind: 'migration',
  status: 'active',
  memoryKind: 'fact',
  semanticSlot: 'fact',
  canonicalKey: 'same fact',
  text: 'same fact',
  payload: { type: 'fact', fieldKey: 'fact' }
}];
const nodes = [{
  id: 'existing_fact',
  userId: 'u_converge',
  scopeType: 'personal',
  source: 'explicit',
  sourceKind: 'explicit',
  status: 'active',
  type: 'fact',
  fieldKey: 'fact',
  semanticSlot: 'fact',
  canonicalKey: 'same fact',
  text: 'same fact',
  confidence: 1,
  updatedAt: 20
}];
const planDeps = {
  collectLegacyVectorMigrationEvents: () => migrationEvents,
  loadMemoryEvents: () => [],
  loadMemoryNodes: () => nodes
};
const preflight = {
  evaluated: true,
  recallGatePassed: true,
  scopeLeakPassed: true,
  reportHash: 'gate-report-hash'
};

const plan = buildConvergencePlan({
  runId: 'convergence-test',
  now: Date.parse('2026-08-04T03:00:00.000Z'),
  dataDir: tempRoot,
  legacyArchiveTarget: path.join(tempRoot, 'archive', 'convergence-test'),
  preflight,
  deps: planDeps
});
assert.strictEqual(plan.migration.candidateCount, 1);
assert.strictEqual(plan.migration.pendingEventCount, 1);
assert.strictEqual(plan.archive.candidateCount, 1);
assert.strictEqual(plan.archive.candidates[0].sourceId, 'm3_legacy_pending');
assert.strictEqual(plan.preflight.ok, true);
assert.strictEqual(inspectMaintenanceWindow({
  queue: { listJobs: () => [{ jobId: 'processing-job' }] },
  stateFile: path.join(tempRoot, 'missing-worker-state.json')
}).ok, false);

const saved = saveConvergencePlan(plan);
assert.strictEqual(readConvergencePlan(saved.planPath).planHash, plan.planHash);
assert.throws(() => readConvergencePlan({
  ...plan,
  migration: { ...plan.migration, pendingEventCount: 2 }
}), /hash mismatch/);

let migrationCalls = 0;
let archiveCalls = 0;
let materializeCalls = 0;
const applyDeps = {
  ...planDeps,
  migrateLegacyVectorMemoryToV3: async () => {
    migrationCalls += 1;
    return { ok: true, importedCount: 1 };
  },
  applyStrictArchiveRun: async () => {
    archiveCalls += 1;
    return { ok: true, appendedEvents: 1 };
  },
  materializeMemoryViews: () => {
    materializeCalls += 1;
    return { ok: true, stats: { nodes: 1 } };
  },
  embedding: {
    runBackfill: async () => ({ ok: true, embedded: 1, remaining: 0 })
  },
  lancedb: {
    syncLanceDb: async () => ({ ok: true }),
    inspectLanceDb: async () => ({
      ok: true,
      coverage: { memory: { readyButNotSynced: 0, staleTableRows: 0 } },
      storageOverlap: {
        missingVectorRows: { count: 0 },
        vectorOnlyRows: { count: 0 },
        unexpectedVectorRows: { count: 0 },
        recommendedAction: 'none'
      }
    }),
    inspectProjection: () => ({ projectionStale: false })
  }
};

module.exports = (async () => {
  const applied = await applyConvergencePlan(saved.planPath, {
    archiveLegacy: false,
    deps: applyDeps
  });
  assert.strictEqual(applied.ok, true);
  assert.strictEqual(applied.status, 'applied');
  assert.strictEqual(readConvergencePlan(saved.planPath).status, 'applied');
  assert.strictEqual(migrationCalls, 1);
  assert.strictEqual(archiveCalls, 1);
  assert.strictEqual(materializeCalls, 1);

  const repeated = await applyConvergencePlan(saved.planPath, { deps: applyDeps });
  assert.strictEqual(repeated.alreadyApplied, true);
  assert.strictEqual(migrationCalls, 1);
  assert.strictEqual(archiveCalls, 1);

  const rolledBack = await rollbackConvergenceRun(saved.planPath, {
    restoreArchiveRun: async () => ({ ok: true, restored: [{ id: 'm3_legacy_pending' }] }),
    materializeMemoryViews: () => ({ ok: true, stats: { nodes: 2 } })
  });
  assert.strictEqual(rolledBack.ok, true);
  assert.strictEqual(rolledBack.status, 'rolled_back');
  assert.strictEqual(readConvergencePlan(saved.planPath).status, 'rolled_back');

  const changedPlan = saveConvergencePlan(buildConvergencePlan({
    runId: 'convergence-source-change',
    now: Date.parse('2026-08-04T04:00:00.000Z'),
    dataDir: tempRoot,
    legacyArchiveTarget: path.join(tempRoot, 'archive', 'convergence-source-change'),
    preflight,
    deps: planDeps
  }));
  fs.appendFileSync(path.join(tempRoot, 'memory_items.json'), '\n', 'utf8');
  const rejected = await applyConvergencePlan(changedPlan.planPath, { deps: applyDeps });
  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(rejected.reason, 'source_files_changed');
  assert.strictEqual(migrationCalls, 1);

  const failedPlan = saveConvergencePlan(buildConvergencePlan({
    runId: 'convergence-lancedb-failure',
    now: Date.parse('2026-08-04T05:00:00.000Z'),
    dataDir: tempRoot,
    legacyArchiveTarget: path.join(tempRoot, 'archive', 'convergence-lancedb-failure'),
    preflight,
    deps: planDeps
  }));
  let restoreCalls = 0;
  let legacyArchiveCalls = 0;
  const failed = await applyConvergencePlan(failedPlan.planPath, {
    deps: {
      ...applyDeps,
      restoreArchiveRun: async () => {
        restoreCalls += 1;
        return { ok: true, restored: [{ id: 'm3_legacy_pending' }] };
      },
      archiveLegacyFiles: () => {
        legacyArchiveCalls += 1;
        return { ok: true };
      },
      lancedb: {
        syncLanceDb: async () => ({ ok: true }),
        inspectLanceDb: async () => ({
          ok: true,
          coverage: { memory: { readyButNotSynced: 1, staleTableRows: 0 } },
          storageOverlap: {
            missingVectorRows: { count: 1 },
            vectorOnlyRows: { count: 0 },
            unexpectedVectorRows: { count: 0 },
            recommendedAction: 'run_full_lancedb_reconcile'
          }
        }),
        inspectProjection: () => ({ projectionStale: false })
      }
    }
  });
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.status, 'failed');
  assert.strictEqual(restoreCalls, 1);
  assert.strictEqual(legacyArchiveCalls, 0, 'legacy files must remain in place when the storage gate fails');

  const checkpointPlan = saveConvergencePlan(buildConvergencePlan({
    runId: 'convergence-checkpoints',
    now: Date.parse('2026-08-04T06:00:00.000Z'),
    dataDir: tempRoot,
    legacyArchiveTarget: path.join(tempRoot, 'archive', 'convergence-checkpoints'),
    preflight,
    deps: planDeps
  }));
  const checkpointStatuses = [];
  const checkpointed = await applyConvergencePlan(checkpointPlan.planPath, {
    archiveLegacy: false,
    deps: applyDeps,
    onCheckpoint: (state) => checkpointStatuses.push(state.status)
  });
  assert.strictEqual(checkpointed.ok, true);
  assert.ok(checkpointStatuses.length >= 6);
  assert.ok(checkpointStatuses.slice(0, -1).every((status) => status === 'applying'));
  assert.strictEqual(checkpointStatuses.at(-1), 'applied');

  const deadlinePlan = saveConvergencePlan(buildConvergencePlan({
    runId: 'convergence-deadline-after-archive',
    now: Date.parse('2026-08-04T07:00:00.000Z'),
    dataDir: tempRoot,
    legacyArchiveTarget: path.join(tempRoot, 'archive', 'convergence-deadline-after-archive'),
    preflight,
    deps: planDeps
  }));
  let maintenanceNow = 0;
  let deadlineRestoreCalls = 0;
  const deadlineResult = await applyConvergencePlan(deadlinePlan.planPath, {
    clock: () => maintenanceNow,
    rollbackAfterMs: 1000,
    deps: {
      ...applyDeps,
      archiveLegacyFiles: () => {
        maintenanceNow = 1000;
        return { ok: true };
      },
      restoreArchiveRun: async () => {
        deadlineRestoreCalls += 1;
        return { ok: true, restored: [{ id: 'm3_legacy_pending' }] };
      }
    }
  });
  assert.strictEqual(deadlineResult.ok, false);
  assert.strictEqual(deadlineResult.status, 'failed');
  assert.match(deadlineResult.application.error, /deadline reached/);
  assert.strictEqual(deadlineRestoreCalls, 1);

  const interruptedPlan = saveConvergencePlan(buildConvergencePlan({
    runId: 'convergence-interrupted-state',
    now: Date.parse('2026-08-04T08:00:00.000Z'),
    dataDir: tempRoot,
    legacyArchiveTarget: path.join(tempRoot, 'archive', 'convergence-interrupted-state'),
    preflight,
    deps: planDeps
  }));
  const interruptedState = JSON.parse(fs.readFileSync(interruptedPlan.planPath, 'utf8'));
  interruptedState.status = 'applying';
  interruptedState.application = { archiveRunId: 'convergence-interrupted-state-archive' };
  fs.writeFileSync(interruptedPlan.planPath, JSON.stringify(interruptedState, null, 2), 'utf8');
  const refusedResume = await applyConvergencePlan(interruptedPlan.planPath, { deps: applyDeps });
  assert.strictEqual(refusedResume.ok, false);
  assert.strictEqual(refusedResume.reason, 'run_applying');
  const interruptedRollback = await rollbackConvergenceRun(interruptedPlan.planPath, {
    restoreArchiveRun: async () => ({ ok: true, restored: [] }),
    materializeMemoryViews: () => ({ ok: true, stats: { nodes: 1 } })
  });
  assert.strictEqual(interruptedRollback.ok, true);
  assert.strictEqual(interruptedRollback.status, 'rolled_back');

  console.log('memoryV3Convergence.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
