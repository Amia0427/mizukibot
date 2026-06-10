const { buildContinuityState } = require('../utils/continuityState');
const { chatHistory, shortTermMemory } = require('../utils/memory');
const {
  buildSharedShortTermContextMessages,
  resolveShortTermSessionKey
} = require('../utils/shortTermMemory');
const { buildShortTermContinuityPrompt } = require('../api/runtimeV2/context/service');

function parseArgs(argv = []) {
  const raw = argv.slice(2);
  const flags = new Set(raw);
  const command = raw.find((item) => !String(item || '').startsWith('--')) || 'state';
  const readValue = (name, fallback = '') => {
    const eq = raw.find((item) => String(item || '').startsWith(`${name}=`));
    if (eq) return String(eq).slice(name.length + 1);
    const idx = raw.indexOf(name);
    if (idx >= 0) return String(raw[idx + 1] || fallback);
    return fallback;
  };
  return {
    command,
    json: flags.has('--json'),
    userId: readValue('--user'),
    sessionKey: readValue('--session'),
    question: readValue('--question', '继续刚才')
  };
}

function runStateDiagnose(args = parseArgs(process.argv)) {
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

function runPromptDiagnose(args = parseArgs(process.argv)) {
  const userId = String(args.userId || '').trim();
  if (!userId) {
    console.error('Usage: npm run diag:continuity -- prompt --user <id> [--session <key>] [--json]');
    process.exit(1);
  }

  const sessionKey = String(args.sessionKey || resolveShortTermSessionKey(userId, {}) || '').trim();
  const context = buildSharedShortTermContextMessages(userId, {}, {
    chatHistory,
    shortTermMemory,
    routeMeta: {},
    sessionKey,
    routePolicyKey: 'direct_chat/diagnose',
    topRouteType: 'direct_chat',
    question: args.question
  });
  const promptText = buildShortTermContinuityPrompt(context);
  const report = {
    schemaVersion: 'continuity_prompt_diagnostic_v1',
    userId,
    sessionKey,
    contextProfile: context.contextProfile || {},
    observability: context.contextObservability || {},
    sharedSessionKeys: context.sharedSessionKeys || [],
    shortTermSummary: context.shortTermSummary || '',
    recentSessionSummaries: context.recentSessionSummaries || [],
    recentHistory: context.recentHistory || [],
    promptText,
    trimReport: {
      reasons: context.contextObservability?.trimReasons || [],
      rawTurnCount: context.contextObservability?.rawTurnCount || 0,
      selectedRawTurnCount: context.contextObservability?.selectedRawTurnCount || 0,
      sessionSummaryCount: context.contextObservability?.sessionSummaryCount || 0
    }
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('=== Short Term Continuity Prompt Diagnose ===');
  console.log(`user=${userId}`);
  console.log(`session=${sessionKey}`);
  console.log(`profile=${report.contextProfile.name || '-'} reason=${report.contextProfile.reason || '-'}`);
  console.log('[trim]');
  console.log(JSON.stringify(report.trimReport, null, 2));
  console.log('[summary]');
  console.log(report.shortTermSummary || '(empty)');
  console.log('[prompt]');
  console.log(promptText || '(empty)');
}

function main() {
  const args = parseArgs(process.argv);
  if (args.command === 'prompt') {
    runPromptDiagnose(args);
    return;
  }
  runStateDiagnose(args);
}

main();
