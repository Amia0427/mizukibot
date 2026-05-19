const REPAIR_COMMAND = 'node scripts/repair-memory-vector-index.js --apply --compact';
const JOURNAL_BACKFILL_COMMAND = 'node scripts/backfill-memory-v3-embeddings.js --resume --source journal --limit 100 --sync-after';
const MEMORY_BACKFILL_COMMAND = 'node scripts/backfill-memory-v3-embeddings.js --resume --source memory --limit 100 --sync-after';
const RECALL_EVAL_COMMAND = 'npm run diag:memory -- recall --limit 50';
const MATERIALIZE_COMMAND = 'npm run memory:v3:migrate';

function countDrift(coverage = {}) {
  const memory = coverage.memory || {};
  const worldbook = coverage.worldbook || {};
  const staleTableRows = (
    (Number(memory.staleTableRows || 0) || 0)
    + (Number(worldbook.staleTableRows || 0) || 0)
  );
  const readyButNotSynced = (
    (Number(memory.readyButNotSynced || 0) || 0)
    + (Number(worldbook.readyButNotSynced || 0) || 0)
  );
  return { staleTableRows, readyButNotSynced };
}

function buildMemoryIndexHealthGate(input = {}) {
  const coverage = input.coverage || {};
  const projectionFreshness = input.projectionFreshness || {};
  const drift = countDrift(coverage);
  const projectionStale = projectionFreshness.projectionStale === true;
  const mustReconcileFirst = drift.staleTableRows > 0 || drift.readyButNotSynced > 0;
  const nextBackfillCommand = input.nextBackfillCommand || JOURNAL_BACKFILL_COMMAND;
  const reasons = [];
  if (projectionStale) reasons.push(projectionFreshness.projectionStaleReason || 'projection_stale');
  if (drift.staleTableRows > 0) reasons.push('stale_table_rows');
  if (drift.readyButNotSynced > 0) reasons.push('ready_but_not_synced');

  let nextSafeCommand = nextBackfillCommand;
  if (projectionStale) nextSafeCommand = MATERIALIZE_COMMAND;
  else if (mustReconcileFirst) nextSafeCommand = REPAIR_COMMAND;

  return {
    canBackfill: !projectionStale && !mustReconcileFirst,
    mustReconcileFirst,
    mustMaterializeFirst: projectionStale,
    projectionStale,
    staleTableRows: drift.staleTableRows,
    readyButNotSynced: drift.readyButNotSynced,
    nextSafeCommand,
    reasons
  };
}

function buildRecommendedActions(healthGate = {}, coverage = {}, options = {}) {
  const actions = [];
  const nextBackfillCommand = options.nextBackfillCommand || healthGate.nextSafeCommand || JOURNAL_BACKFILL_COMMAND;
  if (healthGate.mustMaterializeFirst) {
    actions.push({
      action: 'materialize',
      command: MATERIALIZE_COMMAND,
      required: true
    });
  }
  if (healthGate.mustReconcileFirst) {
    actions.push({
      action: 'reconcile',
      command: REPAIR_COMMAND,
      required: true
    });
  }
  const memoryPending = Number(coverage.memory?.pendingRows || 0) || 0;
  if (memoryPending > 0) {
    actions.push({
      action: 'backfill',
      command: nextBackfillCommand,
      required: healthGate.canBackfill === true
    });
  }
  actions.push({
    action: 'recall_eval',
    command: RECALL_EVAL_COMMAND,
    required: false
  });
  return actions;
}

module.exports = {
  JOURNAL_BACKFILL_COMMAND,
  MATERIALIZE_COMMAND,
  MEMORY_BACKFILL_COMMAND,
  RECALL_EVAL_COMMAND,
  REPAIR_COMMAND,
  buildMemoryIndexHealthGate,
  buildRecommendedActions,
  countDrift
};
