const path = require('path');
const { createRequire } = require('module');
const { runCommonJsChunks } = require('../../shared/chunkedModule');

const legacyContextDir = path.resolve(__dirname, '../../../api/runtimeV2/context');
const legacyContextFile = path.join(legacyContextDir, 'service.js');
const legacyRequire = createRequire(legacyContextFile);

module.exports = runCommonJsChunks(legacyContextDir, module, [
  'service-core.chunk.js',
  'dynamic-plan.chunk.js',
  'cache-blocks.chunk.js',
  'prompt-inputs.chunk.js',
  'render-helpers.chunk.js',
  'base-dynamic-prompt.chunk.js',
  'base-dynamic-prompt-02.chunk.js',
  'dynamic-prompt.chunk.js',
  'dynamic-prompt-02.chunk.js',
  'vision.chunk.js',
], { require: legacyRequire, filename: legacyContextFile });
