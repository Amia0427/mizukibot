const { buildContinuityState } = require('../utils/continuityState');

function parseArgs(argv = []) {
  const flags = new Set(argv.slice(2));
  return {
    json: flags.has('--json')
  };
}

function main() {
  const args = parseArgs(process.argv);
  const request = {
    userId: 'diagnose_continuity_user',
    sessionKey: 'direct:diagnose_continuity_user',
    routeMeta: {},
    question: 'continue from where we left off'
  };

  const shortTermMemory = {
    [request.sessionKey]: {
      summary: 'We were implementing continuity state injection for direct reply and tool-plan synthesis.',
      activeTopic: 'continuity state rollout',
      openLoops: ['wire the automatic continuity probe'],
      assistantCommitments: ['add tests and a smoke template'],
      userConstraints: ['keep it incremental and low-risk'],
      carryOverUserTurn: request.question,
      recentToolResults: ['local tests not run yet']
    }
  };

  const chatHistory = {
    [request.sessionKey]: [
      { role: 'user', content: 'Do方案 1 + 6 and make it executable.' },
      { role: 'assistant', content: 'I will implement the continuity state layer and one automatic probe.' }
    ]
  };

  const result = buildContinuityState({
    request,
    shortTermMemory,
    chatHistory,
    continuityProbeResult: {
      digest: ['Recent continuity: continuity state layer + auto probe plan approved']
    }
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('=== Continuity State Diagnose ===');
  console.log('[payload]');
  console.log(JSON.stringify(result.payload, null, 2));
  console.log('[text]');
  console.log(result.text);
  console.log('[hasSufficientEvidence]');
  console.log(String(result.hasSufficientEvidence));
}

main();
