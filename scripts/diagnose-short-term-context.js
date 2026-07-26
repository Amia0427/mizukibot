const { chatHistory, shortTermMemory } = require('../utils/memory');
const {
  buildSharedShortTermContextMessages,
  resolveShortTermSessionKey
} = require('../utils/shortTermMemory');
const {
  estimateMessagesTokens,
  estimateTokens
} = require('../utils/contextBudget');

function parseArgs(argv = process.argv) {
  const raw = argv.slice(2);
  const flags = new Set(raw);
  const readValue = (name, fallback = '') => {
    const eq = raw.find((item) => String(item || '').startsWith(`${name}=`));
    if (eq) return String(eq).slice(name.length + 1);
    const index = raw.indexOf(name);
    return index >= 0 ? String(raw[index + 1] || fallback) : fallback;
  };

  return {
    json: flags.has('--json'),
    userId: readValue('--user') || readValue('--user-id'),
    sessionKey: readValue('--session') || readValue('--session-key'),
    groupId: readValue('--group') || readValue('--group-id'),
    channelId: readValue('--channel') || readValue('--channel-id'),
    question: readValue('--question', '继续刚才'),
    includeSiblingSessions: !flags.has('--current-only')
  };
}

function buildRouteMeta(args = {}) {
  return {
    ...(args.groupId ? { groupId: args.groupId } : {}),
    ...(args.channelId ? { channelId: args.channelId } : {})
  };
}

function buildDiagnostic(args = parseArgs()) {
  const userId = String(args.userId || '').trim();
  if (!userId) {
    throw new Error('Usage: node scripts/diagnose-short-term-context.js --user <id> [--session <key>] [--json]');
  }

  const routeMeta = buildRouteMeta(args);
  const sessionKey = String(args.sessionKey || resolveShortTermSessionKey(userId, routeMeta) || '').trim();
  const context = buildSharedShortTermContextMessages(userId, {}, {
    chatHistory,
    shortTermMemory,
    routeMeta,
    sessionKey,
    question: args.question,
    includeSiblingSessions: args.includeSiblingSessions,
    suppressScopeLog: args.json === true
  });
  const recentHistory = Array.isArray(context.recentHistory) ? context.recentHistory : [];
  const summaryText = String(context.shortTermSummary || '').trim();

  return {
    schemaVersion: 'short_term_context_diagnostic_v1',
    userId,
    sessionKey,
    contextProfile: context.contextProfile || {},
    scope: context.shortTermScope || {},
    sharedSessionCount: Array.isArray(context.sharedSessionKeys) ? context.sharedSessionKeys.length : 0,
    sharedSessionKeys: context.sharedSessionKeys || [],
    observability: context.contextObservability || {},
    estimatedTokens: {
      recentHistory: estimateMessagesTokens(recentHistory),
      shortTermSummary: estimateTokens(summaryText),
      total: estimateMessagesTokens(recentHistory) + estimateTokens(summaryText)
    },
    contentShape: {
      recentHistoryMessages: recentHistory.length,
      recentSessionSummaries: Array.isArray(context.recentSessionSummaries) ? context.recentSessionSummaries.length : 0,
      shortTermSummaryChars: summaryText.length,
      openLoops: Array.isArray(context.shortTermState?.openLoops) ? context.shortTermState.openLoops.length : 0,
      assistantCommitments: Array.isArray(context.shortTermState?.assistantCommitments) ? context.shortTermState.assistantCommitments.length : 0,
      userConstraints: Array.isArray(context.shortTermState?.userConstraints) ? context.shortTermState.userConstraints.length : 0
    }
  };
}

function printText(report = {}) {
  console.log('=== Short Term Context Diagnose ===');
  console.log(`user=${report.userId}`);
  console.log(`session=${report.sessionKey}`);
  console.log(`profile=${report.contextProfile?.name || '-'} reason=${report.contextProfile?.reason || '-'}`);
  console.log(`scope=${report.scope?.mode || '-'} sharedSessions=${report.sharedSessionCount}`);
  console.log(`tokens=${report.estimatedTokens?.total || 0} recent=${report.estimatedTokens?.recentHistory || 0} summary=${report.estimatedTokens?.shortTermSummary || 0}`);
  console.log('[contentShape]');
  console.log(JSON.stringify(report.contentShape || {}, null, 2));
  console.log('[observability]');
  console.log(JSON.stringify(report.observability || {}, null, 2));
  console.log('[sharedSessionKeys]');
  console.log((report.sharedSessionKeys || []).join('\n') || '(none)');
}

function main() {
  try {
    const args = parseArgs();
    const report = buildDiagnostic(args);
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printText(report);
  } catch (error) {
    console.error(error?.message || error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildDiagnostic,
  parseArgs
};
