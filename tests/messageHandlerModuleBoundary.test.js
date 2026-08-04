'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT_DIR = path.resolve(__dirname, '..');
const LEGACY_DIR = path.join(ROOT_DIR, 'core');
const LEGACY_CHUNKS = [
  'messageHandler.imports.chunk.js',
  'messageHandler.prompts.chunk.js',
  'messageHandler.direct-session.chunk.js',
  'messageHandler.route-capture.chunk.js',
  'messageHandler.runtime.chunk.js',
  'messageHandler.runtime-02.chunk.js',
  'messageHandler.runtime-03.chunk.js',
  'messageHandler.runtime-04.chunk.js',
  'messageHandler.runtime-05.chunk.js',
  'messageHandler.runtime-06.chunk.js',
  'messageHandler.exports.chunk.js'
];
const PUBLIC_KEYS = [
  'buildBackgroundAckText',
  'buildCuteRefusalReply',
  'buildQqRichMessagePayload',
  'buildQqRichReplyPrompt',
  'buildSessionStatusReply',
  'buildUnavailableRouteReply',
  'createMessageHandler',
  'createStreamingDispatcher',
  'detectQzonePostDraftMode',
  'getNaturalSplitIndex',
  'parseBackgroundControlCommand',
  'parseQqRichMessage',
  'resolveVisualInputFromContinuousMetaCore',
  'shouldAutoDraftQzonePostRequest',
  'shouldPreferQqRichReply',
  'shouldSendScheduledGreeting',
  'shouldUseToolRoute',
  'stripLeadingCqControlSegments'
].sort();

function parse(filePath, text = fs.readFileSync(filePath, 'utf8')) {
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function collectTopLevelNames(source) {
  const functions = [];
  const variables = [];
  function collectBindingNames(name) {
    if (ts.isIdentifier(name)) {
      variables.push(name.text);
      return;
    }
    for (const element of name.elements) collectBindingNames(element.name);
  }
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      functions.push(statement.name.text);
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      collectBindingNames(declaration.name);
    }
  }
  return { functions, variables };
}

function restoreRequireCache(snapshot) {
  for (const key of Object.keys(require.cache)) {
    if (!snapshot.has(key)) delete require.cache[key];
  }
  for (const [key, value] of snapshot) require.cache[key] = value;
  assert.deepStrictEqual(Object.keys(require.cache).sort(), [...snapshot.keys()].sort());
}

const legacySource = LEGACY_CHUNKS
  .map((file) => fs.readFileSync(path.join(LEGACY_DIR, file), 'utf8'))
  .join('\n');
const implementationPath = path.join(LEGACY_DIR, 'messageHandler.runtime.js');
const legacyBindings = collectTopLevelNames(parse('message-handler-legacy-combined.js', legacySource));
const implementationBindings = collectTopLevelNames(parse(implementationPath));

assert.strictEqual(legacyBindings.functions.length, 46, 'legacy top-level function count');
assert.strictEqual(legacyBindings.variables.length, 160, 'legacy top-level binding count');
assert.strictEqual(new Set(legacyBindings.functions).size, 46, 'legacy function names must be unique');
assert.strictEqual(new Set(legacyBindings.variables).size, 160, 'legacy variable bindings must be unique');
assert.strictEqual(
  new Set([...legacyBindings.functions, ...legacyBindings.variables]).size,
  206,
  'legacy top-level names must be unique'
);
assert.deepStrictEqual(
  implementationBindings.functions.slice().sort(),
  legacyBindings.functions.slice().sort(),
  'implementation function mapping'
);
assert.deepStrictEqual(
  implementationBindings.variables.slice().sort(),
  legacyBindings.variables.slice().sort(),
  'implementation variable mapping'
);

const entrySource = fs.readFileSync(path.join(ROOT_DIR, 'src', 'message', 'handler.js'), 'utf8');
const implementationSource = fs.readFileSync(implementationPath, 'utf8');
assert.ok(!entrySource.includes('runCommonJsChunks'), 'entry must not use chunk loader');
assert.ok(!entrySource.includes('createRequire'), 'entry must not create a legacy require');
assert.ok(!entrySource.includes('.chunk.js'), 'entry must not reference legacy chunks');
assert.ok(!implementationSource.includes('runCommonJsChunks'), 'implementation must not use chunk loader');
assert.ok(!implementationSource.includes('.chunk.js'), 'implementation must not reference legacy chunks');

const lintReport = JSON.parse(childProcess.execFileSync(
  process.execPath,
  ['scripts/lint.js', '--report-json'],
  { cwd: ROOT_DIR, encoding: 'utf8' }
));
const lintRecord = lintReport.chunks.find((record) => (
  record.file === 'core (legacy retained message handler chunks)'
));
assert.ok(lintRecord, 'message handler legacy lint record');
assert.strictEqual(lintRecord.coverage, 'legacy-retained-combined');
assert.strictEqual(lintRecord.execution, 'not-run');
assert.deepStrictEqual(lintRecord.chunks, LEGACY_CHUNKS.map((file) => `core/${file}`));
assert.deepStrictEqual(
  lintReport.entrypoints.find((record) => record.name === 'src/message/handler'),
  {
    name: 'src/message/handler',
    file: null,
    validation: 'not-run',
    declaredChunks: [],
    missingChunks: [],
    error: null
  }
);

const snapshot = new Map(Object.entries(require.cache));
const chunkedModulePath = require.resolve('../src/shared/chunkedModule');
const originalChunkedModule = require.cache[chunkedModulePath];
const handlerPaths = [
  '../src/message/handler',
  '../core/messageHandler',
  '../src/message'
];

try {
  for (const modulePath of handlerPaths) delete require.cache[require.resolve(modulePath)];
  require.cache[chunkedModulePath] = {
    id: chunkedModulePath,
    filename: chunkedModulePath,
    loaded: true,
    exports: {
      runCommonJsChunks() {
        throw new Error('message handler must not execute chunk loader');
      }
    }
  };

  const main = require('../src/message/handler');
  const coreFacade = require('../core/messageHandler');
  const message = require('../src/message');
  assert.deepStrictEqual(Object.keys(main).sort(), PUBLIC_KEYS);
  for (const key of PUBLIC_KEYS) assert.strictEqual(typeof main[key], 'function', key);
  assert.strictEqual(coreFacade, main, 'core facade identity');
  for (const key of PUBLIC_KEYS) assert.strictEqual(coreFacade[key], main[key], `core.${key}`);
  assert.strictEqual(message.createMessageHandler, main.createMessageHandler, 'src message identity');
  assert.strictEqual(message.buildQqRichMessagePayload, main.buildQqRichMessagePayload, 'src message export identity');
} finally {
  if (originalChunkedModule) require.cache[chunkedModulePath] = originalChunkedModule;
  else delete require.cache[chunkedModulePath];
  restoreRequireCache(snapshot);
}

console.log('messageHandlerModuleBoundary.test.js passed');
