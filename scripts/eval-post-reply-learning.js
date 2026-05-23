const fs = require('fs');
const path = require('path');
const {
  detectPostReplyLearningIntent
} = require('../utils/postReplyWorker/learningIntent');
const {
  createEnrichQualityGate
} = require('../utils/postReplyWorker/enrichQualityGate');

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
  if (item.enrich) {
    const gate = createEnrichQualityGate({
      userId: 'u_eval',
      groupId: 'g_eval',
      evidence: [{ turnId: 't_eval', userText: 'q', assistantText: 'r' }],
      maxWrites: 4
    });
    const result = gate.assess(item.enrich);
    return {
      id: item.id,
      ok: result.allow === item.expected.allow && result.reason === item.expected.reason,
      actual: { allow: result.allow, reason: result.reason },
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
