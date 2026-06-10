const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  detectPostReplyLearningIntent
} = require('../utils/postReplyWorker/learningIntent');
const {
  createEnrichQualityGate
} = require('../utils/postReplyWorker/enrichQualityGate');
const {
  trimTurnsForEnrichBudget
} = require('../utils/postReplyWorker/enrichPhase');
const {
  createPostReplyJobQueue
} = require('../utils/postReplyJobQueue');
const {
  createPostReplyLearningRollback
} = require('../utils/memoryGovernance/postReplyRollback');
const {
  normalizeStringArray,
  normalizeText,
  nowTs
} = require('../utils/memoryGovernance/common');

function parseArgs(argv = []) {
  const out = { caseId: 'all' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--case') out.caseId = String(argv[i + 1] || 'all').trim() || 'all';
  }
  return out;
}

function readCases(filePath) {
  return String(fs.readFileSync(filePath, 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sortedUnique(value = []) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .sort();
}

function valueMatches(actual, expected) {
  if (Array.isArray(expected)) {
    return JSON.stringify(sortedUnique(actual)) === JSON.stringify(sortedUnique(expected));
  }
  if (expected && typeof expected === 'object') {
    return Object.entries(expected).every(([key, value]) => valueMatches(actual?.[key], value));
  }
  return actual === expected;
}

function expectedMatches(actual = {}, expected = {}) {
  return Object.entries(expected)
    .filter(([key, value]) => !valueMatches(actual?.[key], value))
    .map(([key]) => key);
}

function evaluateJobEffects(job = {}, learningIntent = '') {
  const tasks = job.tasks && typeof job.tasks === 'object' ? job.tasks : {};
  const enabledTaskKeys = Object.entries(tasks)
    .filter(([, enabled]) => enabled === true)
    .map(([key]) => key);
  const writes = [];
  const drops = [];
  if (learningIntent === 'explicit') writes.push('explicit');
  if (tasks.selfImprovement === true) writes.push('self_improvement');
  const profileExtractorRelevant = tasks.memoryLearning === true
    || tasks.dailyJournal === true
    || enabledTaskKeys.length === 0;
  if (learningIntent !== 'explicit' && profileExtractorRelevant) {
    drops.push('profile_extractor');
  }
  return { writes, drops };
}

function runJobCase(item = {}) {
  const intent = detectPostReplyLearningIntent(item.job);
  const actual = {
    learningIntent: intent,
    ...evaluateJobEffects(item.job, intent)
  };
  const expected = {
    learningIntent: item.job.learningIntent,
    ...(item.expected || {})
  };
  const mismatches = expectedMatches(actual, expected);
  return {
    id: item.id,
    ok: mismatches.length === 0,
    actual,
    expected,
    mismatches
  };
}

function runRollbackCase(item = {}) {
  const spec = item.rollback || {};
  let library = {
    version: 2,
    items: Array.isArray(spec.memoryItems) ? JSON.parse(JSON.stringify(spec.memoryItems)) : []
  };
  let events = Array.isArray(spec.selfImprovementEvents) ? JSON.parse(JSON.stringify(spec.selfImprovementEvents)) : [];
  const rollback = createPostReplyLearningRollback({
    createSnapshot: () => 'eval-snapshot',
    loadLibrary: () => library,
    normalizeStringArray,
    normalizeText,
    nowTs,
    rebuildMemoryIndex: () => {},
    saveLibrary: (next) => {
      library = next;
    },
    saveProjection: () => {},
    readSelfImprovementEvents: () => events,
    recomputeSelfImprovementPatterns: (nextEvents) => ({
      events: nextEvents,
      patterns: [],
      promotedRules: [],
      skillGuides: []
    }),
    writeSelfImprovementEvents: (nextEvents) => {
      events = nextEvents;
    },
    writeSelfImprovementPatterns: () => {},
    writeSelfImprovementPromotedRules: () => {},
    writeSelfImprovementSkillGuides: () => {}
  }).rollbackPostReplyLearning;

  const criteria = spec.criteria || {};
  const dryRun = rollback({
    ...criteria,
    dryRun: true
  });
  const applied = rollback({
    ...criteria,
    dryRun: false,
    reason: normalizeText(criteria.reason) || 'eval_rollback'
  });
  const actual = {
    dryRunMatched: dryRun.matched,
    changed: applied.changed,
    memoryMatched: applied.memory?.matched || 0,
    selfImprovementMatched: applied.selfImprovement?.matched || 0,
    memoryCategories: applied.memory?.summary?.byCategory || {},
    selfImprovementCategories: applied.selfImprovement?.summary?.byCategory || {},
    archivedMemoryIds: library.items
      .filter((memory) => String(memory.status || '').trim() === 'archived')
      .map((memory) => memory.id),
    archivedSelfImprovementIds: events
      .filter((event) => String(event.status || '').trim() === 'archived')
      .map((event) => event.id)
  };
  const expected = item.expected || {};
  const mismatches = expectedMatches(actual, expected);
  return {
    id: item.id,
    ok: mismatches.length === 0,
    actual,
    expected,
    mismatches
  };
}

function runRecoveryCase(item = {}) {
  const spec = item.recovery || {};
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-post-reply-eval-recovery-'));
  const queue = createPostReplyJobQueue({ queueDir });
  for (const job of Array.isArray(spec.jobs) ? spec.jobs : []) {
    queue.enqueue(job);
  }
  const claimed = queue.claimNextJob(new Date(spec.claimAt || Date.now()), {
    leaseOwner: spec.leaseOwner || 'eval-worker',
    leaseMs: spec.leaseMs || 60000
  });
  const recovered = queue.recoverStaleProcessingJobs({
    now: spec.recoverAt,
    staleBefore: spec.staleBefore || spec.recoverAt
  });
  const actual = {
    claimedJobId: claimed?.jobId || '',
    recovered: recovered.length,
    recoveredJobId: recovered[0]?.jobId || '',
    leaseOwner: recovered[0]?.leaseOwner || '',
    queued: queue.listJobs(['queued']).length,
    processing: queue.listJobs(['processing']).length,
    failed: queue.listJobs(['failed']).length
  };
  const expected = item.expected || {};
  const mismatches = expectedMatches(actual, expected);
  return {
    id: item.id,
    ok: mismatches.length === 0,
    actual,
    expected,
    mismatches
  };
}

function runCase(item) {
  if (item.job) {
    return runJobCase(item);
  }
  if (item.budget) {
    const result = trimTurnsForEnrichBudget(item.budget.turns, item.budget.options || {});
    const expected = item.expected || {};
    const ok = Object.entries(expected).every(([key, value]) => {
      if (key === 'turnIds') return JSON.stringify(result.turns.map((turn) => turn.turnId)) === JSON.stringify(value);
      return result[key] === value;
    });
    return {
      id: item.id,
      ok,
      actual: {
        truncated: result.truncated,
        selectedTurns: result.selectedTurns,
        turnIds: result.turns.map((turn) => turn.turnId),
        chars: result.chars
      },
      expected
    };
  }
  if (item.enrich) {
    const gate = createEnrichQualityGate({
      userId: item.context?.userId ?? 'u_eval',
      groupId: item.context?.groupId ?? 'g_eval',
      evidence: item.context?.evidence ?? [{ turnId: 't_eval', userText: 'q', assistantText: 'r' }],
      maxWrites: item.context?.maxWrites ?? 4
    });
    const candidates = Array.isArray(item.enrich) ? item.enrich : [item.enrich];
    const results = candidates.map((candidate) => gate.assess(candidate));
    const result = results[results.length - 1] || { allow: false, reason: 'empty_case' };
    return {
      id: item.id,
      ok: result.allow === item.expected.allow && result.reason === item.expected.reason,
      actual: { allow: result.allow, reason: result.reason, results: results.map(({ allow, reason }) => ({ allow, reason })) },
      expected: item.expected
    };
  }
  if (item.rollback) {
    return runRollbackCase(item);
  }
  if (item.recovery) {
    return runRecoveryCase(item);
  }
  return {
    id: item.id,
    ok: false,
    actual: { reason: 'unsupported_case_shape' },
    expected: item.expected || {}
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const casesPath = path.join(__dirname, '..', 'artifacts', 'post-reply-eval', 'cases.jsonl');
  const cases = readCases(casesPath)
    .filter((item) => args.caseId === 'all' || item.id === args.caseId);
  const results = cases.map(runCase);
  const failed = results.filter((item) => !item.ok);
  for (const result of results) {
    console.log(JSON.stringify(result));
  }
  if (failed.length > 0) {
    console.error(`post-reply eval failed: ${failed.length}/${results.length}`);
    process.exit(1);
  }
  console.log(`post-reply eval passed: ${results.length}/${results.length}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  runCase
};
