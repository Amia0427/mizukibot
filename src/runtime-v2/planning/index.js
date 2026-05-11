const { runCommonJsChunks } = require('../../shared/chunkedModule');

module.exports = runCommonJsChunks(__dirname, module, [
  'runtime-core.chunk.js',
  'dynamic-plan.chunk.js',
  'tool-gating.chunk.js',
  'tool-selection.chunk.js',
  'rule-decision.chunk.js',
  'prompt-normalizer.chunk.js',
  'caller.chunk.js',
  'legacy.chunk.js',
], { require, filename: __filename });
