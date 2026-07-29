'use strict';

const REQUIRE_CACHE_SNAPSHOT = new Map(Object.entries(require.cache));
REQUIRE_CACHE_SNAPSHOT.delete(__filename);

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT_DIR = path.resolve(__dirname, '..');
const CONTEXT_DIR = path.join(ROOT_DIR, 'src', 'runtime-v2', 'context');
const LEGACY_CONTEXT_DIR = path.join(ROOT_DIR, 'api', 'runtimeV2', 'context');
const LEGACY_CHUNKS = [
  'service-core.chunk.js', 'dynamic-plan.chunk.js', 'cache-blocks.chunk.js',
  'prompt-inputs.chunk.js', 'render-helpers.chunk.js', 'base-dynamic-prompt.chunk.js',
  'base-dynamic-prompt-02.chunk.js', 'dynamic-prompt.chunk.js',
  'dynamic-prompt-02.chunk.js', 'vision.chunk.js'
];
const MAIN_EXPORTS = [
  'buildBaseDynamicPrompt', 'buildDirectedContextPromptSnippet', 'buildDynamicPrompt',
  'buildRoleplayInnerProtocolPromptSnippet', 'buildRoleplayRuntimeContextPromptSnippet',
  'buildShortTermContinuityPrompt', 'buildVisionLiteTextContent', 'buildVisionMessageContent',
  'formatResearchBriefsForPrompt', 'mergeAllowedToolsWithMemoryCli', 'promptLayerCache',
  'shouldBypassHumanizerForPolicy', 'shouldExposeMemoryCli'
].sort();
const FACADE_EXPORTS = {
  cache: ['promptLayerCache'],
  'dynamic-plan': ['buildBaseDynamicPrompt', 'buildDynamicPrompt'],
  'memory-inputs': ['mergeAllowedToolsWithMemoryCli', 'shouldExposeMemoryCli'],
  'prompt-blocks': ['buildDirectedContextPromptSnippet'],
  render: ['buildBaseDynamicPrompt', 'buildDynamicPrompt', 'formatResearchBriefsForPrompt'],
  vision: ['buildVisionMessageContent', 'shouldBypassHumanizerForPolicy']
};
const IMPLEMENTATION_FILES = [
  'normalization.js', 'config.js', 'memory-inputs-core.js', 'continuity.js', 'memory.js',
  'prompt-blocks-runtime.js', 'route-timing.js', 'support.js', 'plan.js', 'cache-runtime.js',
  'prompt-inputs.js', 'base.js', 'render-runtime.js', 'dynamic.js', 'vision-runtime.js'
];
const EXPECTED_EDGES = [
  'base -> cache-runtime', 'base -> config', 'base -> continuity', 'base -> memory', 'base -> memory-inputs-core',
  'base -> normalization', 'base -> plan', 'base -> prompt-blocks-runtime', 'base -> prompt-inputs',
  'base -> route-timing', 'base -> support',
  'cache-runtime -> config', 'cache-runtime -> normalization', 'config -> normalization',
  'continuity -> config', 'continuity -> normalization',
  'dynamic -> base', 'dynamic -> cache-runtime', 'dynamic -> config', 'dynamic -> continuity',
  'dynamic -> memory', 'dynamic -> memory-inputs-core', 'dynamic -> normalization', 'dynamic -> plan',
  'dynamic -> prompt-blocks-runtime', 'dynamic -> prompt-inputs', 'dynamic -> render-runtime',
  'dynamic -> route-timing', 'dynamic -> support',
  'memory -> config', 'memory -> normalization',
  'plan -> config', 'plan -> normalization',
  'prompt-blocks-runtime -> config', 'prompt-blocks-runtime -> normalization',
  'prompt-inputs -> continuity', 'prompt-inputs -> memory', 'prompt-inputs -> normalization', 'prompt-inputs -> plan',
  'prompt-inputs -> route-timing', 'prompt-inputs -> support',
  'render-runtime -> base',
  'route-timing -> config', 'route-timing -> normalization',
  'support -> config', 'support -> normalization',
].sort();
const EXPECTED_TOPOLOGICAL_ORDER = [
  'normalization', 'vision-runtime', 'config', 'memory-inputs-core', 'continuity', 'memory',
  'prompt-blocks-runtime', 'route-timing', 'support', 'plan', 'cache-runtime', 'prompt-inputs',
  'base', 'render-runtime', 'dynamic'
];
const EXPECTED_FUNCTION_OWNERS = Object.fromEntries([
  ['normalization.js', 'normalizeRuntimeTimestampMs normalizeRuntimeDate compactRuntimeLineValue normalizeArray normalizeObject normalizeText hashText'],
  ['config.js', 'getConfig resolveMainReplyAdminPromptContext buildStableSystemPromptFingerprint shouldForceMemoryContextForQuestion'],
  ['memory-inputs-core.js', 'shouldExposeMemoryCli mergeAllowedToolsWithMemoryCli'],
  ['continuity.js', 'buildRelationshipPromptLines buildDirectedContextPromptSnippet buildContinuityStatePromptSnippet summarizeContinuitySignalsForRoleplay resolveCurrentUserForRoleplay buildRoleplayRuntimeContextPromptSnippet buildRoleplayInnerProtocolPromptSnippet formatShortTermMessageLine hasMeaningfulShortTermSummary buildShortTermContinuityPrompt summarizeShortTermContinuityForPrompt'],
  ['memory.js', 'buildMemoryContext buildMemoryContextAsync composePersonaMemoryState renderPersonaMemoryPrompt getMemosPlannerRecallRuntime getMemoryRecallDeduperRuntime getOpenVikingRecallRuntime getOpenVikingDeduperRuntime buildMemoryRecallPolicyPromptSnippet resolveMemosRecallObject resolveMemosRecallText normalizeMemosRecallBlockText normalizeOpenVikingRecallBlockText dedupeMemosRecallForPrompt resolveOpenVikingRecallObject resolveOpenVikingRecallText dedupeOpenVikingRecallForPrompt canonicalMemoryEvidenceText removeDuplicateJournalPromptText resolveMemoryPromptBudgetMs buildFallbackMemoryContext'],
  ['prompt-blocks-runtime.js', 'createPromptBlock createLiveStatePromptBlock estimateLineBlockTokens trimLineSectionFromTail trimLineBlock blocksToMessages serializePromptBlocks'],
  ['route-timing.js', 'sanitizePromptTimingMeta normalizePromptTimingEntry summarizePromptAssemblyTiming createPromptAssemblyTimingCollector recordMemoryContextTimingDetails getRouteMetaGroupId isGroupDirectChatRoute buildGroupDirectChatStyleGuardPrompt'],
  ['support.js', 'buildV2MemoryCliInstruction resolveLiveStateContextFromOptions resolveLiveStateMetaFromOptions shouldInjectLifeScheduler shouldInjectSelfImprovement shouldInjectStyleProfile shouldInjectSocialContext formatResearchBriefsForPrompt'],
  ['plan.js', 'cloneDynamicPromptPlan findPlannerDynamicPromptPlan normalizePlannerBlockDecisions normalizePlannerDynamicContextPlan normalizeDynamicPromptPlan createDynamicContextAudit pushUniqueAuditEntry getPromptBlockPlanIds blockHasUsableContent filterBlocksByPlan ensureGroupDirectPersonaModulePlan planHasBlockDecision planIncludesBlock planSkipsBlock shouldRuntimeAddRetrievedMemoryBlock shouldBlockAmbientMemoryForPlainChat'],
  ['cache-runtime.js', 'splitBlocksByLane buildCacheFriendlyFingerprint buildSessionCacheFingerprint withSoftTimeout prunePromptLayerCache buildPromptCacheKeys getCachedPromptLayer clonePromptBlocks clonePromptMessages clonePromptLayerValue buildPromptSurface dedupePromptBlocks buildPromptBlockFingerprint extractSessionStablePromptBlocks excludePromptBlocks'],
  ['prompt-inputs.js', 'collectPromptInputs'],
  ['base.js', 'buildBaseDynamicPrompt'],
  ['render-runtime.js', 'renderPromptLayers'],
  ['dynamic.js', 'buildDynamicPrompt'],
  ['vision-runtime.js', 'normalizeVisionImageUrls inferVisionChatIntent buildVisionTextPart normalizeVisionEvidenceText buildVisionLiteTextContent buildVisionMessageContent shouldBypassHumanizerForPolicy']
].flatMap(([file, names]) => names.split(' ').map((name) => [name, file])));
const MUST_STAY_LAZY = [
  '../utils/memoryContext', '../utils/personaMemoryState', '../utils/memosPlannerRecall',
  '../utils/memoryRecallDeduper', '../utils/openVikingMemory/recall', '../utils/openVikingMemory/deduper',
  '../utils/recallHeuristics', '../utils/memory-v3/storage', '../utils/memory-v3/materializer',
  '../utils/memory-v3/embeddingIndex', '../utils/lancedbMemoryStore', '../utils/memorySemanticIndex'
];

function parse(filePath, text = fs.readFileSync(filePath, 'utf8')) {
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function bindingNames(name, names = []) {
  if (ts.isIdentifier(name)) return names.concat(name.text);
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) bindingNames(element.name, names);
  }
  return names;
}

function topLevelBindings(source) {
  const bindings = new Map();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) bindings.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) bindings.set(name, declaration);
      }
    }
  }
  return bindings;
}

function requireCalls(filePath) {
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
      && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
      calls.push({ node, specifier: node.arguments[0].text });
    }
    ts.forEachChild(node, visit);
  }
  visit(parse(filePath));
  return calls;
}

function resolveLocalRequire(filePath, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(filePath), specifier);
  const candidates = path.extname(base) ? [base] : [`${base}.js`, path.join(base, 'index.js')];
  return path.resolve(candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0]);
}

function isDeclaration(node) {
  const parent = node.parent;
  return ts.isDeclarationName(node)
    || (ts.isPropertyAccessExpression(parent) && parent.name === node)
    || (ts.isPropertyAssignment(parent) && parent.name === node && !ts.isComputedPropertyName(parent.name))
    || (ts.isBindingElement(parent) && parent.propertyName === node)
    || (ts.isQualifiedName(parent) && parent.right === node);
}

function ancestorFunction(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return current;
  }
  return null;
}

function findCycle(graph) {
  const seen = new Map();
  const stack = [];
  function visit(node) {
    seen.set(node, 1);
    stack.push(node);
    for (const dependency of graph.get(node) || []) {
      if (seen.get(dependency) === 1) return [...stack.slice(stack.indexOf(dependency)), dependency];
      if (seen.get(dependency) !== 2) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    seen.set(node, 2);
    return null;
  }
  for (const node of graph.keys()) {
    if (!seen.has(node)) {
      const cycle = visit(node);
      if (cycle) return cycle;
    }
  }
  return null;
}

function topologicalOrder(nodes, graph) {
  const pending = new Set(nodes);
  const ordered = [];
  while (pending.size) {
    const next = nodes.find((node) => pending.has(node) && (graph.get(node) || []).every((dependency) => !pending.has(dependency)));
    if (!next) return ordered;
    pending.delete(next);
    ordered.push(next);
  }
  return ordered;
}

function assertLegacyBaseline() {
  const chunkTexts = LEGACY_CHUNKS.map((file) => fs.readFileSync(path.join(LEGACY_CONTEXT_DIR, file), 'utf8'));
  const chunkOffsets = [];
  let offset = 0;
  for (let index = 0; index < LEGACY_CHUNKS.length; index += 1) {
    chunkOffsets.push(offset);
    offset += chunkTexts[index].length + 1;
  }
  const source = parse('runtime-context-legacy-combined.js', chunkTexts.join('\n'));
  assert.deepStrictEqual(source.parseDiagnostics, [], 'legacy combined syntax diagnostics');
  const functions = source.statements.filter((statement) => ts.isFunctionDeclaration(statement) && statement.name);
  const variables = source.statements.filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .flatMap((declaration) => bindingNames(declaration.name));
  const bindings = topLevelBindings(source);
  assert.strictEqual(functions.length, 110, 'legacy top-level function count');
  assert.strictEqual(variables.length, 5, 'legacy top-level variable count');
  assert.strictEqual(bindings.size, 115, 'legacy unique top-level binding count');
  const locations = new Map();
  for (const [name, declaration] of bindings) {
    const position = declaration.getStart(source);
    const chunkIndex = chunkOffsets.findLastIndex((chunkOffset) => chunkOffset <= position);
    const relativePosition = position - chunkOffsets[chunkIndex];
    const priorText = chunkTexts[chunkIndex].slice(0, relativePosition);
    const line = priorText.split('\n').length;
    const column = relativePosition - priorText.lastIndexOf('\n');
    locations.set(name, `${LEGACY_CHUNKS[chunkIndex]}:${line}:${column}`);
  }
  bindings.locations = locations;
  return bindings;
}

function assertImplementationStructure(legacyBindings) {
  const implementationPaths = IMPLEMENTATION_FILES.map((file) => path.join(CONTEXT_DIR, file));
  implementationPaths.forEach((filePath) => {
    const source = fs.readFileSync(filePath, 'utf8');
    assert.ok(!/Object\.definePropert(?:y|ies)\s*\(/.test(source), path.basename(filePath) + ' must not hide exports');
  });
  implementationPaths.forEach((filePath) => assert.ok(fs.existsSync(filePath), `missing implementation module ${path.basename(filePath)}`));
  assert.deepStrictEqual(
    Object.keys(EXPECTED_FUNCTION_OWNERS).sort(),
    [...legacyBindings]
      .filter(([, declaration]) => ts.isFunctionDeclaration(declaration))
      .map(([name]) => name)
      .sort(),
    'legacy function owner mapping must be complete'
  );
  const owners = new Map([...legacyBindings.keys()].map((name) => [name, []]));
  const promptLayerCacheOwners = [];
  for (const filePath of implementationPaths) {
    for (const [name, declaration] of topLevelBindings(parse(filePath))) {
      if (name === 'promptLayerCache') promptLayerCacheOwners.push(path.basename(filePath));
      if (!owners.has(name)) continue;
      const point = parse(filePath).getLineAndCharacterOfPosition(declaration.getStart());
      owners.get(name).push(`${path.basename(filePath)}:${point.line + 1}:${point.character + 1}`);
    }
  }
  for (const [name, locations] of owners) {
    assert.strictEqual(locations.length, 1, `legacy binding ${name} must have one implementation owner: ${locations.join(', ')}`);
    const expectedOwner = EXPECTED_FUNCTION_OWNERS[name];
    if (expectedOwner) {
      const actualOwner = locations[0].split(':')[0];
      assert.strictEqual(
        actualOwner,
        expectedOwner,
        `${name} owner mismatch: legacy ${legacyBindings.locations.get(name)} -> new ${locations[0]}, expected ${expectedOwner}`
      );
    }
  }
  assert.deepStrictEqual(promptLayerCacheOwners, ['cache-runtime.js'], 'promptLayerCache must be owned by cache-runtime.js');

  const program = ts.createProgram(implementationPaths, { allowJs: true, checkJs: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10, skipLibCheck: true, types: ['node'] });
  const checker = program.getTypeChecker();
  const allowed = new Set([...Object.getOwnPropertyNames(globalThis), 'require', 'module', 'exports', '__dirname', '__filename']);
  const unknown = new Set();
  for (const filePath of implementationPaths) {
    const source = program.getSourceFile(filePath);
    assert.deepStrictEqual(program.getSyntacticDiagnostics(source), [], `${path.basename(filePath)} syntax diagnostics`);
    function visit(node) {
      if (ts.isIdentifier(node) && !isDeclaration(node) && !checker.getSymbolAtLocation(node) && !allowed.has(node.text)) unknown.add(node.text);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepStrictEqual([...unknown].sort(), [], 'implementation unknown free variables');

  const namesByPath = new Map(implementationPaths.map((filePath) => [path.resolve(filePath), path.basename(filePath, '.js')]));
  const forbidden = new Set([
    path.join(CONTEXT_DIR, 'index.js'),
    path.join(CONTEXT_DIR, 'prompt-blocks.js'),
    path.join(CONTEXT_DIR, 'render.js'),
    ...LEGACY_CHUNKS.map((file) => path.join(LEGACY_CONTEXT_DIR, file)),
    path.join(ROOT_DIR, 'src', 'shared', 'chunkedModule.js')
  ].map((filePath) => path.resolve(filePath)));
  const graph = new Map(EXPECTED_TOPOLOGICAL_ORDER.map((name) => [name, []]));
  const edges = new Set();
  for (const filePath of implementationPaths) {
    const sourceName = path.basename(filePath, '.js');
    for (const call of requireCalls(filePath)) {
      const dependency = resolveLocalRequire(filePath, call.specifier);
      if (!dependency) continue;
      assert.ok(!forbidden.has(dependency), `${sourceName} must not require ${path.basename(dependency)}`);
      const dependencyName = namesByPath.get(dependency);
      if (!dependencyName) continue;
      assert.strictEqual(ancestorFunction(call.node), null, `${sourceName} -> ${dependencyName} must be static`);
      graph.get(sourceName).push(dependencyName);
      edges.add(`${sourceName} -> ${dependencyName}`);
    }
  }
  assert.deepStrictEqual([...edges].sort(), EXPECTED_EDGES, 'implementation local dependency edges');
  assert.strictEqual(findCycle(graph), null, 'implementation local dependency graph must be acyclic');
  assert.deepStrictEqual(topologicalOrder(EXPECTED_TOPOLOGICAL_ORDER, graph), EXPECTED_TOPOLOGICAL_ORDER, 'implementation dependency-first order');
}

function clearModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

function restoreRequireCache(snapshot) {
  for (const cacheKey of Object.keys(require.cache)) {
    if (!snapshot.has(cacheKey)) delete require.cache[cacheKey];
  }
  for (const [cacheKey, cached] of snapshot) require.cache[cacheKey] = cached;
  assert.deepStrictEqual(Object.keys(require.cache).sort(), [...snapshot.keys()].sort(), 'require cache keys must be restored');
  for (const [cacheKey, cached] of snapshot) assert.strictEqual(require.cache[cacheKey], cached, cacheKey);
}

function assertHeavyModulesStayLazy() {
  for (const modulePath of MUST_STAY_LAZY) {
    assert.strictEqual(require.cache[require.resolve(modulePath)], undefined, `${modulePath} must stay lazy`);
  }
  assert.ok(Object.keys(require.cache).every((cacheKey) => !/[\\/]@lancedb[\\/]lancedb[\\/]/.test(cacheKey)), '@lancedb/lancedb must stay lazy');
}

function assertRuntimeContract(main) {
  assert.deepStrictEqual(Object.keys(main).sort(), MAIN_EXPORTS, 'main export keys');
  assert.strictEqual(require('../api/runtimeV2/context/service'), main, 'service identity');
  assert.strictEqual(require('../api/graphPrompting'), main, 'graphPrompting identity');
  assert.strictEqual(main.promptLayerCache, require('../src/runtime-v2/context/cache').promptLayerCache, 'promptLayerCache identity');
  for (const [facadeName, keys] of Object.entries(FACADE_EXPORTS)) {
    const facade = require(`../src/runtime-v2/context/${facadeName}`);
    assert.deepStrictEqual(Object.keys(facade).sort(), keys.slice().sort(), `${facadeName} keys`);
    for (const key of keys) assert.strictEqual(facade[key], main[key], `${facadeName}.${key} identity`);
  }
}

function assertColdFacadeContracts() {
  const mainPath = require.resolve('../src/runtime-v2/context');
  const servicePath = require.resolve('../api/runtimeV2/context/service');
  const graphPath = require.resolve('../api/graphPrompting');
  for (const [facadeName, keys] of Object.entries(FACADE_EXPORTS)) {
    const snapshot = new Map(Object.entries(require.cache));
    try {
      for (const cacheKey of Object.keys(require.cache)) {
        if (cacheKey.startsWith(CONTEXT_DIR)
          || cacheKey === require.resolve('../api/runtimeV2/context/service')
          || cacheKey === require.resolve('../api/graphPrompting')) {
          delete require.cache[cacheKey];
        }
      }
      const facade = require(`../src/runtime-v2/context/${facadeName}`);
      assert.deepStrictEqual(Object.keys(facade).sort(), keys.slice().sort(), `${facadeName} cold keys`);
      const references = new Map(keys.map((key) => [key, facade[key]]));
      assert.strictEqual(require.cache[mainPath], undefined, facadeName + ' must not load main entrypoint');
      assert.strictEqual(require.cache[servicePath], undefined, facadeName + ' must not load service facade');
      assert.strictEqual(require.cache[graphPath], undefined, facadeName + ' must not load graph facade');
      for (const [key, value] of references) assert.ok(value, `${facadeName}.${key} cold value`);
      const main = require('../src/runtime-v2/context');
      assertRuntimeContract(main);
      for (const [key, value] of references) assert.strictEqual(facade[key], value, `${facadeName}.${key} stable cold reference`);
      for (const key of keys) assert.strictEqual(facade[key], main[key], `${facadeName}.${key} cold identity`);
    } finally {
      restoreRequireCache(snapshot);
    }
  }
}

function assertLintProtocol() {
  const output = childProcess.execFileSync(process.execPath, ['scripts/lint.js', '--report-json'], { cwd: ROOT_DIR, encoding: 'utf8' });
  const report = JSON.parse(output);
  const records = report.chunks.filter((record) => record.coverage === 'legacy-retained-combined');
  assert.strictEqual(records.length, 1, 'one legacy retained combined record');
  assert.strictEqual(records[0].execution, 'not-run', 'legacy chunks must not execute');
  assert.strictEqual(records[0].validation, 'passed', 'legacy retained combined syntax validation');
  assert.deepStrictEqual(records[0].chunks, LEGACY_CHUNKS.map((file) => `api/runtimeV2/context/${file}`), 'legacy retained chunk order');
  const entrypoint = report.entrypoints.find((record) => record.name === 'src/runtime-v2/context');
  assert.deepStrictEqual(entrypoint, {
    name: 'src/runtime-v2/context',
    file: null,
    validation: 'not-run',
    declaredChunks: [],
    missingChunks: [],
    error: null
  }, 'context lint entrypoint must not run');
}

function isRuntimeContextChunkRequest(baseDir, chunkFiles) {
  const legacyBase = path.resolve(LEGACY_CONTEXT_DIR);
  if (path.resolve(baseDir || '') === legacyBase) return true;
  return Array.isArray(chunkFiles) && chunkFiles.some((file) => LEGACY_CHUNKS.includes(path.basename(String(file))));
}

module.exports = (() => {
  const legacyBindings = assertLegacyBaseline();
  const chunkedModulePath = require.resolve('../src/shared/chunkedModule');
  const { runCommonJsChunks } = require(chunkedModulePath);
  require.cache[chunkedModulePath] = {
    id: chunkedModulePath,
    filename: chunkedModulePath,
    loaded: true,
    exports: {
      runCommonJsChunks(baseDir, ownerModule, chunkFiles, options) {
        if (isRuntimeContextChunkRequest(baseDir, chunkFiles)) throw new Error('runtime-context must not execute chunk loader');
        return runCommonJsChunks(baseDir, ownerModule, chunkFiles, options);
      }
    }
  };

  let failure;
  try {
    [
      '../src/runtime-v2/context', '../src/runtime-v2/context/cache', '../src/runtime-v2/context/dynamic-plan',
      '../src/runtime-v2/context/memory-inputs', '../src/runtime-v2/context/prompt-blocks',
      '../src/runtime-v2/context/render', '../src/runtime-v2/context/vision',
      '../api/runtimeV2/context/service', '../api/graphPrompting', ...MUST_STAY_LAZY
    ].forEach(clearModule);
    for (const cacheKey of Object.keys(require.cache)) {
      if (/[\\/]@lancedb[\\/]lancedb[\\/]/.test(cacheKey)) delete require.cache[cacheKey];
    }
    const main = require('../src/runtime-v2/context');
    assertImplementationStructure(legacyBindings);
    assertHeavyModulesStayLazy();
    assertRuntimeContract(main);
    assertColdFacadeContracts();
    assertLintProtocol();
  } catch (error) {
    failure = error;
  } finally {
    restoreRequireCache(REQUIRE_CACHE_SNAPSHOT);
  }
  if (failure) throw failure;
  console.log('runtimeContextModuleBoundary.test.js passed');
})();
