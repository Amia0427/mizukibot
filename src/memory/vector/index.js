const { runCommonJsChunks } = require('../../shared/chunkedModule');

module.exports = runCommonJsChunks(__dirname, module, [
  'normalize.chunk.js',
  'store.chunk.js',
  'archive-write-helpers.chunk.js',
  'write.chunk.js',
  'scoring-core.chunk.js',
  'scoring-selection.chunk.js',
  'retrieval-stats.chunk.js',
], { require, filename: __filename });
