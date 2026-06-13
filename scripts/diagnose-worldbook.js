const {
  buildPersonaModuleCandidatesAsync,
  selectPersonaModules
} = require('../utils/personaModules');
const {
  buildDynamicFewShotPrompt,
  selectDynamicFewShotExamples
} = require('../utils/fewShotPrompts');
const {
  shouldBuildDynamicFewShot
} = require('../utils/mainReplyPromptMode');
const {
  getWorldbookSessionState
} = require('../utils/personaWorldbookSearch/sessionState');
const {
  getDiagnostics: getWorldbookDbDiagnostics
} = require('../utils/worldbookDb');

function normalizeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseArgs(argv = process.argv) {
  const args = argv.slice(2);
  const options = {
    question: '',
    sessionKey: 'diagnose-worldbook',
    chatType: 'private',
    promptMode: '',
    json: false,
    consume: false
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || '').trim();
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--consume') {
      options.consume = true;
    } else if (arg === '--session' || arg === '--sessionKey') {
      options.sessionKey = normalizeText(args[i + 1], options.sessionKey);
      i += 1;
    } else if (arg.startsWith('--session=')) {
      options.sessionKey = normalizeText(arg.slice('--session='.length), options.sessionKey);
    } else if (arg === '--chatType') {
      options.chatType = normalizeText(args[i + 1], options.chatType);
      i += 1;
    } else if (arg.startsWith('--chatType=')) {
      options.chatType = normalizeText(arg.slice('--chatType='.length), options.chatType);
    } else if (arg === '--promptMode') {
      options.promptMode = normalizeText(args[i + 1]);
      i += 1;
    } else if (arg.startsWith('--promptMode=')) {
      options.promptMode = normalizeText(arg.slice('--promptMode='.length));
    } else if (arg === '--question' || arg === '-q') {
      options.question = normalizeText(args[i + 1]);
      i += 1;
    } else if (arg.startsWith('--question=')) {
      options.question = normalizeText(arg.slice('--question='.length));
    } else if (!arg.startsWith('--')) {
      options.question = normalizeText([options.question, arg].filter(Boolean).join(' '));
    }
  }
  return options;
}

async function diagnoseWorldbook(options = {}) {
  const question = normalizeText(options.question);
  const context = {
    question,
    chatType: normalizeText(options.chatType, 'private'),
    sessionKey: normalizeText(options.sessionKey, 'diagnose-worldbook'),
    mainReplyPromptMode: normalizeText(options.promptMode),
    worldbookEmbeddingHotPath: false,
    worldbookSemanticLimit: 0,
    worldbookSessionConsume: options.consume === true
  };
  const candidates = await buildPersonaModuleCandidatesAsync(context);
  const selection = selectPersonaModules({}, {
    ...context,
    personaModuleCandidates: candidates
  });
  const fewShotContext = {
    question,
    routePolicyKey: 'chat/default',
    topRouteType: 'chat',
    maxExamples: 3,
    mainReplyPromptMode: context.mainReplyPromptMode,
    activeWorldbookIds: selection.activeWorldbookIds,
    preferredExampleIds: selection.linkedExamples
  };
  const dynamicFewShotAllowed = shouldBuildDynamicFewShot(fewShotContext);
  const examples = dynamicFewShotAllowed ? selectDynamicFewShotExamples(fewShotContext) : [];
  const worldbookSearch = candidates.personaWorldbookSearch || {};
  const selectedWorldbookBlocks = selection.selected
    .filter((item) => normalizeText(item.id).startsWith('wb_mizuki_'))
    .map((item) => ({
      id: `persona_module:${item.id}`,
      moduleId: item.id,
      slot: item.slot,
      source: item.path
    }));
  return {
    schemaVersion: 'worldbook_diagnostic_v1',
    question,
    sessionKey: context.sessionKey,
    db: getWorldbookDbDiagnostics({ benchmark: false }),
    worldbookSearch,
    sqlHits: {
      dbFile: worldbookSearch.sql?.dbFile || '',
      primaryRead: worldbookSearch.sql?.primaryRead === true,
      count: Number(worldbookSearch.sql?.ftsCandidates || 0) + Number(worldbookSearch.sql?.lexicalCandidates || 0),
      candidates: Number(worldbookSearch.sql?.lexicalCandidates || 0),
      selected: Number(worldbookSearch.selected || 0)
    },
    ftsHits: {
      available: worldbookSearch.sql?.ftsAvailable === true,
      count: Number(worldbookSearch.sql?.ftsCandidates || 0),
      reason: normalizeText(worldbookSearch.sql?.ftsReason)
    },
    semanticHits: {
      enabled: worldbookSearch.embedding?.enabled === true,
      count: Number(worldbookSearch.embedding?.semanticCandidates || 0),
      hotPathUsed: worldbookSearch.embedding?.hotPathUsed === true,
      fallbackReason: normalizeText(worldbookSearch.embedding?.fallbackReason)
    },
    sessionHits: {
      count: Number(worldbookSearch.sessionState?.active?.length || 0),
      activated: normalizeArray(worldbookSearch.sessionState?.activated).map((item) => item.moduleId).filter(Boolean),
      active: normalizeArray(worldbookSearch.sessionState?.active).map((item) => item.moduleId).filter(Boolean)
    },
    finalInjectedBlocks: selectedWorldbookBlocks,
    candidates: normalizeArray(candidates)
      .filter((item) => normalizeText(item.id).startsWith('wb_mizuki_'))
      .map((item) => ({
        id: item.id,
        score: Number(item.worldbookScore || 0) || 0,
        candidateScore: Number(item.candidateScore || 0) || 0,
        matchMode: normalizeText(item.worldbookMatchMode || item.matchMode),
        reason: normalizeText(item.worldbookReason || item.reason),
        slot: item.slot,
        activationState: item.activationState || null,
        linkedExamples: normalizeArray(item.linkedExamples || item.exampleIds)
      })),
    selected: selection.selected.map((item) => ({
      id: item.id,
      slot: item.slot,
      activationState: item.activationState || null,
      linkedExamples: normalizeArray(item.linkedExamples || item.exampleIds)
    })),
    skipped: normalizeArray(selection.selectionReason?.skipped),
    activeWorldbookIds: selection.activeWorldbookIds,
    linkedExamples: selection.linkedExamples,
    dynamicFewShot: {
      allowed: dynamicFewShotAllowed,
      exampleIds: examples.map((item) => item.id),
      prompt: dynamicFewShotAllowed ? buildDynamicFewShotPrompt(fewShotContext) : ''
    },
    sessionState: getWorldbookSessionState(context.sessionKey)
  };
}

function printText(result = {}) {
  console.log(`question: ${result.question || ''}`);
  console.log(`session: ${result.sessionKey || ''}`);
  console.log(`selected: ${result.selected.map((item) => item.id).join(', ') || 'none'}`);
  console.log(`few-shot: ${result.dynamicFewShot.exampleIds.join(', ') || 'none'}`);
  console.table(result.candidates.map((item) => ({
    id: item.id,
    score: item.score,
    mode: item.matchMode,
    slot: item.slot,
    state: item.activationState?.state || '',
    examples: item.linkedExamples.join(',')
  })));
}

async function run(options = parseArgs()) {
  if (!options.question) {
    console.error('Usage: node scripts/diagnose-worldbook.js --question "M5 文化祭发生了什么" [--json] [--session s1]');
    process.exitCode = 1;
    return;
  }
  const result = await diagnoseWorldbook(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printText(result);
}

if (require.main === module) {
  run().then(() => {
    process.exit(process.exitCode || 0);
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  diagnoseWorldbook,
  parseArgs,
  run
};
