'use strict';

const REQUIRE_CACHE_SNAPSHOT = new Map(Object.entries(require.cache));
REQUIRE_CACHE_SNAPSHOT.delete(__filename);

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT_DIR = path.resolve(__dirname, '..');
const VECTOR_DIR = path.join(ROOT_DIR, 'src', 'memory', 'vector');

const MAIN_EXPORTS = [
  'addEpisodeMemory',
  'addMemoryItem',
  'addMemoryItemsBatch',
  'addMemoryItemsBatchAsync',
  'addMemoryItemsBatchWithVectorBackfill',
  'cosineArray',
  'getCoreMemories',
  'getMemoryItems',
  'getMemoryItemsByFilter',
  'getMemoryStats',
  'loadIndex',
  'loadLibrary',
  'rebuildMemoryIndex',
  'rememberExplicitMemory',
  'requestEmbedding',
  'retrieveRelevantMemories',
  'retrieveRelevantMemoriesAsync',
  'retrieveUnifiedMemories',
  'retrieveUnifiedMemoriesAsync',
  'saveIndex',
  'saveLibrary',
  'shouldUseRemoteEmbedding',
  'touchAccessStats'
].sort();

const FACADE_EXPORTS = {
  retrieval: [
    'getCoreMemories',
    'retrieveRelevantMemories',
    'retrieveRelevantMemoriesAsync',
    'retrieveUnifiedMemories',
    'retrieveUnifiedMemoriesAsync'
  ],
  store: [
    'getMemoryItems',
    'getMemoryItemsByFilter',
    'loadIndex',
    'loadLibrary',
    'rebuildMemoryIndex',
    'saveIndex',
    'saveLibrary'
  ],
  write: [
    'addEpisodeMemory',
    'addMemoryItem',
    'addMemoryItemsBatch',
    'addMemoryItemsBatchAsync',
    'addMemoryItemsBatchWithVectorBackfill',
    'rememberExplicitMemory'
  ],
  stats: ['getMemoryStats', 'touchAccessStats']
};

const FACADE_DEPENDENCIES = {
  retrieval: './retrieval-runtime',
  store: './store-runtime',
  write: './write-runtime',
  stats: './stats-runtime'
};

const EMBEDDING_EXPORTS = [
  'calcEmbeddingScore',
  'cosineArray',
  'requestEmbedding',
  'shouldUseRemoteEmbedding'
].sort();

const SHARED_EMBEDDING_EXPORTS = [
  'cosineArray',
  'requestEmbedding',
  'shouldUseRemoteEmbedding'
];

const LEGACY_CHUNKS = [
  'normalize.chunk.js',
  'store.chunk.js',
  'archive-write-helpers.chunk.js',
  'write.chunk.js',
  'scoring-core.chunk.js',
  'scoring-selection.chunk.js',
  'retrieval-stats.chunk.js'
];

const VECTOR_CHUNKS = new Set(LEGACY_CHUNKS);

const IMPLEMENTATION_FUNCTION_COUNTS = {
  'normalization.js': 40,
  'store-runtime.js': 55,
  'write-runtime.js': 28,
  'stats-runtime.js': 2,
  'scoring-core.js': 24,
  'scoring-selection.js': 14,
  'retrieval-runtime.js': 6
};

const SINGLETON_OWNERS = {
  hotStoreRegistry: 'store-runtime.js',
  shardStateHydrated: 'store-runtime.js',
  memoryShardState: 'store-runtime.js',
  writePipelineActive: 'write-runtime.js'
};

const EXPECTED_LOCAL_EDGES = [
  'retrieval-runtime -> normalization',
  'retrieval-runtime -> scoring-core',
  'retrieval-runtime -> scoring-selection',
  'retrieval-runtime -> store-runtime',
  'scoring-core -> normalization',
  'scoring-core -> store-runtime',
  'scoring-selection -> normalization',
  'scoring-selection -> scoring-core',
  'scoring-selection -> stats-runtime',
  'stats-runtime -> normalization',
  'stats-runtime -> scoring-core',
  'stats-runtime -> store-runtime',
  'store-runtime -> normalization',
  'write-runtime -> normalization',
  'write-runtime -> store-runtime'
].sort();

const EXPECTED_TOPOLOGICAL_ORDER = [
  'normalization',
  'store-runtime',
  'write-runtime',
  'scoring-core',
  'stats-runtime',
  'scoring-selection',
  'retrieval-runtime'
];

const EXPECTED_EXTERNAL_LEAF_EDGES = [
  'retrieval-runtime -> embedding',
  'scoring-selection -> embedding',
  'write-runtime -> embedding'
].sort();

const EMBEDDING_DEPENDENCIES = [
  '../../../config',
  '../../../utils/memoryEmbeddingClient',
  '../../../utils/memorySemanticIndex'
].sort();

const PUBLIC_VECTOR_FILES = new Set([
  'index.js',
  'retrieval.js',
  'stats.js',
  'store.js',
  'write.js'
]);

const LAZY_REQUIRE_BINDINGS = {
  '../../../utils/memory-v3/recallVerifier': ['normalizeRecallTargetIds'],
  '../../../utils/memory-v3/storage': ['loadMemoryNodes'],
  '../../../utils/memory-v3/materializer': ['materializeMemoryViews'],
  '../../../utils/lancedbMemoryStore': ['buildMemoryVectorRow', 'isLanceDbSyncEnabled', 'syncMemoryRows']
};

const REQUIRED_STATIC_BINDINGS = [
  ['scoring-selection.js', '../../../utils/memoryProjection/conflicts', ['sourceKindRank']],
  ['scoring-selection.js', './embedding', ['calcEmbeddingScore']],
  ['write-runtime.js', './embedding', ['shouldUseRemoteEmbedding']],
  ['retrieval-runtime.js', './embedding', ['shouldUseRemoteEmbedding']],
  ['stats-runtime.js', './scoring-core', ['calcMemoryStrength']]
];

const MODULE_CONTRACT_DIAGNOSTIC_CODES = new Set([
  1192,
  2305,
  2306,
  2459,
  2614,
  2724
]);

const MUST_STAY_LAZY = [
  '../utils/lancedbMemoryStore/index.js',
  '../utils/memory-v3/storage.js',
  '../utils/memory-v3/materializer.js',
  '../utils/memory-v3/recallVerifier.js'
];

function parseSource(filePath) {
  return ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
}

function collectTopLevelFunctionNames(filePath) {
  return parseSource(filePath).statements
    .filter(ts.isFunctionDeclaration)
    .map((statement) => statement.name?.text || '')
    .filter(Boolean);
}

function collectBindingNames(name, names = []) {
  if (ts.isIdentifier(name)) {
    names.push(name.text);
    return names;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) collectBindingNames(element.name, names);
  }
  return names;
}

function collectTopLevelVariableNames(filePath) {
  const names = [];
  for (const statement of parseSource(filePath).statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      collectBindingNames(declaration.name, names);
    }
  }
  return names;
}

function collectRequireCalls(filePath) {
  const source = parseSource(filePath);
  const calls = [];

  function visit(node) {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'require'
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0])
    ) {
      calls.push({ node, source, specifier: node.arguments[0].text });
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return calls;
}

function resolveLocalRequire(sourceFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const basePath = path.resolve(path.dirname(sourceFile), specifier);
  const candidates = path.extname(basePath)
    ? [basePath]
    : [`${basePath}.js`, path.join(basePath, 'index.js')];
  return path.resolve(candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0]);
}

function findAncestorFunction(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return null;
}

function isNonReferenceIdentifier(node) {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node && !ts.isComputedPropertyName(parent.name)) return true;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if (
    (ts.isBreakStatement(parent) || ts.isContinueStatement(parent) || ts.isLabeledStatement(parent))
    && parent.label === node
  ) {
    return true;
  }
  return ts.isDeclarationName(node);
}

function formatDiagnostic(diagnostic) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (!diagnostic.file || diagnostic.start === undefined) {
    return `TS${diagnostic.code}: ${message}`;
  }
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  const file = path.relative(ROOT_DIR, diagnostic.file.fileName).split(path.sep).join('/');
  return `${file}:${position.line + 1}:${position.character + 1} TS${diagnostic.code}: ${message}`;
}

function findCycle(graph) {
  const state = new Map();
  const stack = [];

  function visit(node) {
    state.set(node, 1);
    stack.push(node);
    for (const dependency of graph.get(node) || []) {
      if (state.get(dependency) === 1) {
        return [...stack.slice(stack.indexOf(dependency)), dependency];
      }
      if (state.get(dependency) !== 2) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(node, 2);
    return null;
  }

  for (const node of graph.keys()) {
    if (state.has(node)) continue;
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}

function stableDependencyFirstOrder(nodes, graph) {
  const pending = new Set(nodes);
  const ordered = [];
  while (pending.size > 0) {
    const next = nodes.find((node) => (
      pending.has(node)
      && (graph.get(node) || []).every((dependency) => !pending.has(dependency))
    ));
    if (!next) return ordered;
    pending.delete(next);
    ordered.push(next);
  }
  return ordered;
}

function assertFunctionDistribution() {
  const legacyNames = LEGACY_CHUNKS.flatMap((file) => (
    collectTopLevelFunctionNames(path.join(VECTOR_DIR, file))
  ));
  const implementationNames = [];

  assert.strictEqual(legacyNames.length, 169, 'legacy vector function count');
  assert.strictEqual(new Set(legacyNames).size, 169, 'legacy vector function names must be unique');

  for (const [file, expectedCount] of Object.entries(IMPLEMENTATION_FUNCTION_COUNTS)) {
    const names = collectTopLevelFunctionNames(path.join(VECTOR_DIR, file));
    assert.strictEqual(names.length, expectedCount, `${file} top-level function count`);
    implementationNames.push(...names);
  }

  assert.strictEqual(implementationNames.length, 169, 'implementation vector function count');
  assert.strictEqual(new Set(implementationNames).size, 169, 'implementation vector function names must be unique');
  assert.deepStrictEqual(implementationNames.slice().sort(), legacyNames.slice().sort(), 'legacy and implementation function names');
}

function assertSingletonOwnership() {
  const ownerDeclarations = Object.fromEntries(Object.keys(SINGLETON_OWNERS).map((name) => [name, []]));
  const allDeclarations = Object.fromEntries(Object.keys(SINGLETON_OWNERS).map((name) => [name, []]));
  const identifierFiles = Object.fromEntries(Object.keys(SINGLETON_OWNERS).map((name) => [name, new Set()]));
  const forbiddenFunctionProperties = [];

  for (const file of Object.keys(IMPLEMENTATION_FUNCTION_COUNTS)) {
    const filePath = path.join(VECTOR_DIR, file);
    for (const name of collectTopLevelVariableNames(filePath)) {
      if (ownerDeclarations[name]) ownerDeclarations[name].push(file);
    }

    const source = parseSource(filePath);
    assert.ok(!source.text.includes('__pipelineActive'), `${file} must not use __pipelineActive function state`);

    function visit(node) {
      if (ts.isVariableDeclaration(node)) {
        for (const name of collectBindingNames(node.name)) {
          if (Object.hasOwn(allDeclarations, name)) allDeclarations[name].push(file);
        }
      }
      if (ts.isIdentifier(node) && Object.hasOwn(identifierFiles, node.text)) {
        identifierFiles[node.text].add(file);
      }
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'addMemoryItemsBatch'
      ) {
        forbiddenFunctionProperties.push(`${file}:${node.getText(source)}`);
      }
      ts.forEachChild(node, visit);
    }

    visit(source);
  }

  for (const [name, owner] of Object.entries(SINGLETON_OWNERS)) {
    assert.deepStrictEqual(ownerDeclarations[name], [owner], `${name} top-level owner`);
    assert.deepStrictEqual(allDeclarations[name], [owner], `${name} must have exactly one declaration`);
    assert.deepStrictEqual([...identifierFiles[name]], [owner], `${name} references must stay in owner module`);
  }
  assert.deepStrictEqual(forbiddenFunctionProperties, [], 'addMemoryItemsBatch must not carry mutable function state');
}

function assertNoUnknownFreeVariables() {
  const implementationPaths = Object.keys(IMPLEMENTATION_FUNCTION_COUNTS).map((file) => path.join(VECTOR_DIR, file));
  const program = ts.createProgram(implementationPaths, {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    skipLibCheck: true,
    types: ['node']
  });
  const checker = program.getTypeChecker();
  const allowedGlobals = new Set([
    ...Object.getOwnPropertyNames(globalThis),
    'require',
    'module',
    'exports',
    '__dirname',
    '__filename'
  ]);
  const unknown = new Set();
  const moduleContractDiagnostics = [];

  for (const filePath of implementationPaths) {
    const source = program.getSourceFile(filePath);
    assert.ok(source, `${path.basename(filePath)} must be part of the TypeScript program`);
    assert.deepStrictEqual(program.getSyntacticDiagnostics(source), [], `${path.basename(filePath)} syntax diagnostics`);
    moduleContractDiagnostics.push(
      ...program.getSemanticDiagnostics(source)
        .filter((diagnostic) => MODULE_CONTRACT_DIAGNOSTIC_CODES.has(diagnostic.code))
        .map(formatDiagnostic)
    );

    function visit(node) {
      if (
        ts.isIdentifier(node)
        && !isNonReferenceIdentifier(node)
        && !checker.getSymbolAtLocation(node)
        && !allowedGlobals.has(node.text)
      ) {
        unknown.add(node.text);
      }
      ts.forEachChild(node, visit);
    }

    visit(source);
  }

  assert.deepStrictEqual([...unknown].sort(), [], 'implementation unknown free variables');
  assert.strictEqual(
    moduleContractDiagnostics.length,
    0,
    `implementation module contract diagnostics:\n${moduleContractDiagnostics.sort().join('\n')}`
  );
}

function assertDependencyGraph() {
  const implementationFiles = Object.keys(IMPLEMENTATION_FUNCTION_COUNTS);
  const implementationPaths = new Map(implementationFiles.map((file) => [
    path.resolve(VECTOR_DIR, file),
    path.basename(file, '.js')
  ]));
  const embeddingPath = path.resolve(VECTOR_DIR, 'embedding.js');
  const forbiddenPaths = new Set([
    ...[...PUBLIC_VECTOR_FILES].map((file) => path.resolve(VECTOR_DIR, file)),
    ...LEGACY_CHUNKS.map((file) => path.resolve(VECTOR_DIR, file)),
    path.resolve(ROOT_DIR, 'utils', 'vectorMemory.js'),
    path.resolve(ROOT_DIR, 'src', 'memory', 'index.js')
  ]);
  const graph = new Map(EXPECTED_TOPOLOGICAL_ORDER.map((node) => [node, []]));
  const localEdges = new Set();
  const externalLeafEdges = new Set();

  for (const file of implementationFiles) {
    const sourcePath = path.join(VECTOR_DIR, file);
    const sourceName = path.basename(file, '.js');
    for (const call of collectRequireCalls(sourcePath)) {
      const dependencyPath = resolveLocalRequire(sourcePath, call.specifier);
      if (!dependencyPath) continue;
      assert.ok(!forbiddenPaths.has(dependencyPath), `${file} must not depend on ${path.basename(dependencyPath)}`);
      assert.notStrictEqual(path.basename(dependencyPath), 'chunkedModule.js', `${file} must not depend on chunkedModule.js`);

      const dependencyName = implementationPaths.get(dependencyPath);
      if (dependencyName) {
        assert.strictEqual(findAncestorFunction(call.node), null, `${file} -> ${dependencyName} must be a static require`);
        graph.get(sourceName).push(dependencyName);
        localEdges.add(`${sourceName} -> ${dependencyName}`);
      } else if (dependencyPath === embeddingPath) {
        assert.strictEqual(findAncestorFunction(call.node), null, `${file} -> embedding must be a static require`);
        externalLeafEdges.add(`${sourceName} -> embedding`);
      }
    }
  }

  for (const dependencies of graph.values()) dependencies.sort();
  assert.deepStrictEqual([...localEdges].sort(), EXPECTED_LOCAL_EDGES, 'implementation local dependency edges');
  assert.deepStrictEqual([...externalLeafEdges].sort(), EXPECTED_EXTERNAL_LEAF_EDGES, 'implementation embedding edges');
  assert.strictEqual(findCycle(graph), null, 'implementation local dependency graph must be acyclic');
  assert.deepStrictEqual(
    stableDependencyFirstOrder(EXPECTED_TOPOLOGICAL_ORDER, graph),
    EXPECTED_TOPOLOGICAL_ORDER,
    'implementation dependency-first topological order'
  );
}

function assertIndexAndEmbeddingBoundaries() {
  const implementationPaths = new Set(Object.keys(IMPLEMENTATION_FUNCTION_COUNTS).map((file) => path.resolve(VECTOR_DIR, file)));
  const embeddingPath = path.resolve(VECTOR_DIR, 'embedding.js');
  const allowedIndexDependencies = new Set([...implementationPaths, embeddingPath]);
  const indexPath = path.join(VECTOR_DIR, 'index.js');
  const indexSource = parseSource(indexPath);

  for (const call of collectRequireCalls(indexPath)) {
    const dependencyPath = resolveLocalRequire(indexPath, call.specifier);
    assert.ok(dependencyPath && allowedIndexDependencies.has(dependencyPath), `index.js dependency ${call.specifier}`);
    assert.strictEqual(findAncestorFunction(call.node), null, `index.js dependency ${call.specifier} must be static`);
  }

  assert.ok(!indexSource.text.includes('runCommonJsChunks'), 'index.js must not use runCommonJsChunks');
  assert.ok(!indexSource.text.includes('.chunk.js'), 'index.js must not reference legacy chunks');
  let dynamicFunctionUse = false;
  function visitIndex(node) {
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node))
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'Function'
    ) {
      dynamicFunctionUse = true;
    }
    ts.forEachChild(node, visitIndex);
  }
  visitIndex(indexSource);
  assert.strictEqual(dynamicFunctionUse, false, 'index.js must not evaluate dynamic Function code');

  const embeddingCalls = collectRequireCalls(embeddingPath);
  assert.deepStrictEqual(embeddingCalls.map((call) => call.specifier).sort(), EMBEDDING_DEPENDENCIES, 'embedding.js leaf dependencies');
  for (const call of embeddingCalls) {
    assert.strictEqual(findAncestorFunction(call.node), null, `embedding.js dependency ${call.specifier} must be static`);
  }
}

function assertFacadeBoundaries() {
  for (const [facadeName, expectedDependency] of Object.entries(FACADE_DEPENDENCIES)) {
    const file = `${facadeName}.js`;
    const calls = collectRequireCalls(path.join(VECTOR_DIR, file));
    assert.deepStrictEqual(
      calls.map((call) => call.specifier),
      [expectedDependency],
      `${file} dependencies`
    );
    assert.strictEqual(findAncestorFunction(calls[0].node), null, `${file} dependency must be static`);
  }
}

function collectDestructuredRequireBindings(call, label) {
  const declaration = call.parent;
  assert.ok(ts.isVariableDeclaration(declaration), `${label} must use a variable declaration`);
  assert.ok(ts.isObjectBindingPattern(declaration.name), `${label} must use object destructuring`);
  return declaration.name.elements.map((element) => (
    element.propertyName?.text || element.name.text
  )).sort();
}

function assertRequiredStaticBindings() {
  for (const [file, specifier, expectedBindings] of REQUIRED_STATIC_BINDINGS) {
    const filePath = path.join(VECTOR_DIR, file);
    const matches = collectRequireCalls(filePath).filter((call) => call.specifier === specifier);
    assert.strictEqual(matches.length, 1, `${file} ${specifier} require count`);
    assert.strictEqual(findAncestorFunction(matches[0].node), null, `${file} ${specifier} must be static`);
    assert.deepStrictEqual(
      collectDestructuredRequireBindings(matches[0].node, `${file} ${specifier}`),
      expectedBindings.slice().sort(),
      `${file} ${specifier} bindings`
    );
  }
}

function assertLazyNativeRequires() {
  const writePath = path.join(VECTOR_DIR, 'write-runtime.js');
  const requireCalls = collectRequireCalls(writePath);
  for (const [specifier, expectedBindings] of Object.entries(LAZY_REQUIRE_BINDINGS)) {
    const matches = requireCalls.filter((call) => call.specifier === specifier);
    assert.strictEqual(matches.length, 1, `${specifier} require count`);
    const call = matches[0].node;
    assert.ok(findAncestorFunction(call), `${specifier} must be required inside its consumer function`);
    assert.deepStrictEqual(
      collectDestructuredRequireBindings(call, specifier),
      expectedBindings.slice().sort(),
      `${specifier} call-time bindings`
    );
  }
}

function assertImplementationStructure() {
  assertFunctionDistribution();
  assertSingletonOwnership();
  assertNoUnknownFreeVariables();
  assertDependencyGraph();
  assertIndexAndEmbeddingBoundaries();
  assertFacadeBoundaries();
  assertRequiredStaticBindings();
  assertLazyNativeRequires();
}

function isVectorChunkSet(chunkFiles) {
  if (!Array.isArray(chunkFiles) || chunkFiles.length !== VECTOR_CHUNKS.size) return false;
  const chunks = new Set(chunkFiles);
  return chunks.size === VECTOR_CHUNKS.size
    && [...VECTOR_CHUNKS].every((chunkFile) => chunks.has(chunkFile));
}

function clearModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

function assertHeavyModulesStayLazy() {
  for (const modulePath of MUST_STAY_LAZY) {
    assert.strictEqual(require.cache[require.resolve(modulePath)], undefined, `${modulePath} must stay lazy`);
  }
  assert.ok(
    Object.keys(require.cache).every((cacheKey) => !/[\\/]@lancedb[\\/]lancedb[\\/]/.test(cacheKey)),
    '@lancedb/lancedb must stay lazy'
  );
}

function assertSingleCachedModule(modulePath, label) {
  const resolved = require.resolve(modulePath);
  assert.ok(require.cache[resolved], `${label} must be loaded`);
  const realPath = fs.realpathSync(resolved);
  const instances = Object.keys(require.cache).filter((cacheKey) => {
    try {
      return fs.realpathSync(cacheKey) === realPath;
    } catch (_) {
      return false;
    }
  });
  assert.strictEqual(instances.length, 1, `${label} must have one resolved cache instance`);
  assert.strictEqual(require(resolved), require(resolved), `${label} must preserve singleton identity`);
}

function assertFacadeIdentity(main, facadeName, expectedKeys) {
  const facade = require(`../src/memory/vector/${facadeName}`);
  assert.deepStrictEqual(Object.keys(facade).sort(), expectedKeys.slice().sort());
  for (const name of expectedKeys) {
    assert.strictEqual(facade[name], main[name], `${facadeName}.${name}`);
  }
}

function restoreRequireCache(snapshot) {
  for (const cacheKey of Object.keys(require.cache)) {
    if (!snapshot.has(cacheKey)) delete require.cache[cacheKey];
  }
  for (const [cacheKey, cachedModule] of snapshot) {
    require.cache[cacheKey] = cachedModule;
  }

  assert.deepStrictEqual(Object.keys(require.cache).sort(), [...snapshot.keys()].sort());
  for (const [cacheKey, cachedModule] of snapshot) {
    assert.strictEqual(require.cache[cacheKey], cachedModule, cacheKey);
  }
}

module.exports = (() => {
  const chunkedModulePath = require.resolve('../src/shared/chunkedModule');
  const { runCommonJsChunks } = require(chunkedModulePath);
  require.cache[chunkedModulePath] = {
    id: chunkedModulePath,
    filename: chunkedModulePath,
    loaded: true,
    exports: {
      runCommonJsChunks(baseDir, ownerModule, chunkFiles, options) {
        if (isVectorChunkSet(chunkFiles)) {
          throw new Error('memory-vector must not execute chunk loader');
        }
        return runCommonJsChunks(baseDir, ownerModule, chunkFiles, options);
      }
    }
  };

  let failure;
  try {
    assertImplementationStructure();

    const testedModules = [
      '../src',
      '../src/memory',
      '../src/memory/vector',
      '../src/memory/vector/embedding',
      '../src/memory/vector/retrieval',
      '../src/memory/vector/stats',
      '../src/memory/vector/store',
      '../src/memory/vector/write',
      '../utils/vectorMemory',
      ...Object.keys(IMPLEMENTATION_FUNCTION_COUNTS).map((file) => `../src/memory/vector/${file}`),
      '../utils/memorySemanticIndex',
      '../utils/memoryEmbeddingClient',
      ...MUST_STAY_LAZY
    ];
    testedModules.forEach(clearModule);
    for (const cacheKey of Object.keys(require.cache)) {
      if (/[\\/]@lancedb[\\/]lancedb[\\/]/.test(cacheKey)) delete require.cache[cacheKey];
    }

    const main = require('../src/memory/vector');
    assertHeavyModulesStayLazy();
    assertSingleCachedModule('../utils/memorySemanticIndex', 'memorySemanticIndex');
    assertSingleCachedModule('../utils/memoryEmbeddingClient', 'memoryEmbeddingClient');

    assert.deepStrictEqual(Object.keys(main).sort(), MAIN_EXPORTS);
    for (const name of MAIN_EXPORTS) {
      assert.strictEqual(typeof main[name], 'function', `main.${name}`);
    }
    assert.strictEqual(Object.hasOwn(main, 'calcEmbeddingScore'), false);

    assert.strictEqual(require('../utils/vectorMemory'), main);
    assert.strictEqual(require('../src/memory').vector, main);
    assert.strictEqual(require('../src').memory.vector, main);

    for (const [facadeName, expectedKeys] of Object.entries(FACADE_EXPORTS)) {
      assertFacadeIdentity(main, facadeName, expectedKeys);
    }

    const embedding = require('../src/memory/vector/embedding');
    assert.deepStrictEqual(Object.keys(embedding).sort(), EMBEDDING_EXPORTS);
    for (const name of SHARED_EMBEDDING_EXPORTS) {
      assert.strictEqual(embedding[name], main[name], `embedding.${name}`);
    }
  } catch (error) {
    failure = error;
  } finally {
    restoreRequireCache(REQUIRE_CACHE_SNAPSHOT);
  }

  if (failure) throw failure;
  console.log('memoryVectorModuleBoundary.test.js passed');
})();
