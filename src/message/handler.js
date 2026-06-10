const path = require('path');
const { createRequire } = require('module');
const { runCommonJsChunks } = require('../shared/chunkedModule');

const legacyCoreDir = path.resolve(__dirname, '../../core');
const legacyMessageHandlerFile = path.join(legacyCoreDir, 'messageHandler.js');
const legacyRequire = createRequire(legacyMessageHandlerFile);

module.exports = runCommonJsChunks(legacyCoreDir, module, [
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
  'messageHandler.exports.chunk.js',
], { require: legacyRequire, filename: legacyMessageHandlerFile });
