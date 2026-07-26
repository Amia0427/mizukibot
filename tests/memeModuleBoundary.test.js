'use strict';

const REQUIRE_CACHE_SNAPSHOT = new Map(Object.entries(require.cache));
REQUIRE_CACHE_SNAPSHOT.delete(__filename);

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const MAIN_EXPORTS = [
  'analyzeMemeAsset',
  'cleanupExpiredSessions',
  'consumePendingUploadFromMessage',
  'drainReindexQueue',
  'evaluateMemeGate',
  'getReindexStatus',
  'handleAdminCommand',
  'initializeMemeManager',
  'isSurfaceEnabled',
  'maybeSendMemeFollowup',
  'parseMemeCommand',
  'pickBestAssetForSelection',
  'resolveAssetAnalysis',
  'runMemeTest',
  'selectCategory',
  'startUploadSession'
].sort();

const FACADE_EXPORTS = {
  admin: [
    'cleanupExpiredSessions',
    'consumePendingUploadFromMessage',
    'handleAdminCommand',
    'isSurfaceEnabled',
    'parseMemeCommand',
    'runMemeTest',
    'startUploadSession'
  ],
  'asset-analysis': ['analyzeMemeAsset', 'resolveAssetAnalysis'],
  reindex: ['drainReindexQueue', 'getReindexStatus'],
  selector: ['evaluateMemeGate', 'pickBestAssetForSelection', 'selectCategory'],
  'store-runtime': ['initializeMemeManager']
};

const IMPLEMENTATION_EXPORTS = {
  'admin-runtime': [
    'cleanupExpiredSessions',
    'consumePendingUploadFromMessage',
    'handleAdminCommand',
    'isSurfaceEnabled',
    'parseMemeCommand',
    'runMemeTest',
    'startUploadSession'
  ],
  'asset-analysis-runtime': ['analyzeMemeAsset', 'resolveAssetAnalysis'],
  followup: ['maybeSendMemeFollowup'],
  gate: ['evaluateMemeGate'],
  lifecycle: ['initializeMemeManager'],
  'reindex-runtime': ['drainReindexQueue', 'getReindexStatus'],
  'selector-runtime': ['pickBestAssetForSelection', 'selectCategory']
};

const LEGACY_CHUNKS = [
  'memeManager.admin.chunk.js',
  'memeManager.asset-analysis.chunk.js',
  'memeManager.commands.chunk.js',
  'memeManager.core.chunk.js',
  'memeManager.exports.chunk.js',
  'memeManager.followup.chunk.js',
  'memeManager.gate.chunk.js',
  'memeManager.selector-normalize.chunk.js',
  'memeManager.selector.chunk.js'
];

const SINGLETON_OWNERS = {
  uploadSessions: 'admin-runtime.js',
  followupRuntime: 'runtime-state.js',
  runtimeStoreCache: 'runtime-state.js',
  reindexQueue: 'reindex-runtime.js',
  reindexQueueSet: 'reindex-runtime.js',
  reindexState: 'reindex-runtime.js'
};

const PUBLIC_FACADE_FILES = new Set([
  'admin.js',
  'asset-analysis.js',
  'index.js',
  'reindex.js',
  'selector.js',
  'store-runtime.js'
]);

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

function collectTopLevelVariableNames(filePath) {
  const names = [];
  for (const statement of parseSource(filePath).statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
    }
  }
  return names;
}

function collectRelativeRequires(filePath) {
  const requires = [];
  function visit(node) {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'require'
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0])
      && node.arguments[0].text.startsWith('.')
    ) {
      requires.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(parseSource(filePath));
  return requires;
}

function resolveLocalRequire(sourceFile, specifier) {
  const basePath = path.resolve(path.dirname(sourceFile), specifier);
  const candidates = path.extname(basePath)
    ? [basePath]
    : [`${basePath}.js`, path.join(basePath, 'index.js')];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
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
    if (!state.has(node)) {
      const cycle = visit(node);
      if (cycle) return cycle;
    }
  }
  return null;
}

function assertImplementationStructure() {
  const rootDir = path.resolve(__dirname, '..');
  const legacyDir = path.join(rootDir, 'core');
  const implementationDir = path.join(rootDir, 'src', 'features', 'meme');
  const implementationFiles = fs.readdirSync(implementationDir, { withFileTypes: true })
    .filter((entry) => (
      entry.isFile()
      && entry.name.endsWith('.js')
      && !PUBLIC_FACADE_FILES.has(entry.name)
    ))
    .map((entry) => entry.name)
    .sort();
  const legacyNames = LEGACY_CHUNKS.flatMap((file) => (
    collectTopLevelFunctionNames(path.join(legacyDir, file))
  ));
  const implementationNames = implementationFiles.flatMap((file) => (
    collectTopLevelFunctionNames(path.join(implementationDir, file))
  ));

  assert.strictEqual(legacyNames.length, 93, 'legacy function count');
  assert.strictEqual(new Set(legacyNames).size, 93, 'legacy function names must be unique');
  assert.strictEqual(implementationFiles.length, 10, 'implementation file count');
  assert.strictEqual(implementationNames.length, 93, 'implementation function count');
  assert.strictEqual(new Set(implementationNames).size, 93, 'implementation function names must be unique');
  assert.deepStrictEqual(implementationNames.slice().sort(), legacyNames.slice().sort());

  const singletonDeclarations = Object.fromEntries(
    Object.keys(SINGLETON_OWNERS).map((name) => [name, []])
  );
  for (const file of implementationFiles) {
    for (const name of collectTopLevelVariableNames(path.join(implementationDir, file))) {
      if (singletonDeclarations[name]) singletonDeclarations[name].push(file);
    }
  }
  for (const [name, owner] of Object.entries(SINGLETON_OWNERS)) {
    assert.deepStrictEqual(singletonDeclarations[name], [owner], `${name} owner`);
  }

  const graphFiles = [...implementationFiles, 'index.js'];
  const graphPaths = new Map(graphFiles.map((file) => [
    path.resolve(implementationDir, file),
    file
  ]));
  const publicFacadePaths = new Set(
    [...PUBLIC_FACADE_FILES].map((file) => path.resolve(implementationDir, file))
  );
  const graph = new Map(graphFiles.map((file) => [file, []]));

  for (const file of graphFiles) {
    const sourcePath = path.join(implementationDir, file);
    for (const specifier of collectRelativeRequires(sourcePath)) {
      const dependencyPath = path.resolve(resolveLocalRequire(sourcePath, specifier));
      const dependencyName = graphPaths.get(dependencyPath);
      if (implementationFiles.includes(file)) {
        assert.ok(
          !publicFacadePaths.has(dependencyPath),
          `${file} must not depend on ${path.basename(dependencyPath)}`
        );
      }
      if (dependencyName) graph.get(file).push(dependencyName);
    }
  }

  assert.strictEqual(findCycle(graph), null, 'meme local dependency graph must be acyclic');
}

function clearModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

function restoreRequireCache(snapshot) {
  const loadedDuringTest = Object.keys(require.cache)
    .filter((cacheKey) => !snapshot.has(cacheKey));
  for (const cacheKey of loadedDuringTest) delete require.cache[cacheKey];
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
  const modulePaths = [
    '../src/features',
    '../src/features/meme',
    '../src/features/meme/admin',
    '../src/features/meme/asset-analysis',
    '../src/features/meme/reindex',
    '../src/features/meme/selector',
    '../src/features/meme/store-runtime',
    '../core/memeManager'
  ];

  modulePaths.forEach(clearModule);
  require.cache[chunkedModulePath] = {
    id: chunkedModulePath,
    filename: chunkedModulePath,
    loaded: true,
    exports: {
      runCommonJsChunks(baseDir, ownerModule, chunkFiles, options) {
        if (chunkFiles.some((file) => /^memeManager\..+\.chunk\.js$/.test(file))) {
          throw new Error('meme must not execute chunk loader');
        }
        return runCommonJsChunks(baseDir, ownerModule, chunkFiles, options);
      }
    }
  };

  try {
    const main = require('../src/features/meme');
    const coreFacade = require('../core/memeManager');
    const features = require('../src/features');

    assert.deepStrictEqual(Object.keys(main).sort(), MAIN_EXPORTS);
    for (const name of MAIN_EXPORTS) {
      assert.strictEqual(typeof main[name], 'function', `main.${name}`);
      assert.strictEqual(coreFacade[name], main[name], `core.${name}`);
    }
    assert.strictEqual(coreFacade, main);
    assert.strictEqual(features.meme, main);

    for (const [facadeName, expectedKeys] of Object.entries(FACADE_EXPORTS)) {
      const facade = require(`../src/features/meme/${facadeName}`);
      assert.deepStrictEqual(Object.keys(facade).sort(), expectedKeys.slice().sort());
      for (const name of expectedKeys) {
        assert.strictEqual(facade[name], main[name], `${facadeName}.${name}`);
      }
    }

    for (const [implementationName, expectedKeys] of Object.entries(IMPLEMENTATION_EXPORTS)) {
      const implementation = require(`../src/features/meme/${implementationName}`);
      for (const name of expectedKeys) {
        assert.strictEqual(main[name], implementation[name], `${implementationName}.${name}`);
      }
    }

    assertImplementationStructure();
  } finally {
    restoreRequireCache(REQUIRE_CACHE_SNAPSHOT);
  }

  console.log('memeModuleBoundary.test.js passed');
})();
