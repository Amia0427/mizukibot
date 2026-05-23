const fs = require('fs');
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

function runCase(item) {
  if (item.job) {
    const intent = detectPostReplyLearningIntent(item.job);
    return {
      id: item.id,
      ok: intent === item.job.learningIntent,
      actual: { learningIntent: intent },
      expected: { learningIntent: item.job.learningIntent }
    };
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
