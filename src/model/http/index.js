const { runCommonJsChunks } = require('../../shared/chunkedModule');

module.exports = runCommonJsChunks(__dirname, module, [
  'runtime-core.chunk.js',
  'images.chunk.js',
  'openai-compatible.chunk.js',
  'request-shaping.chunk.js',
  'prepare.chunk.js',
  'post-retry.chunk.js',
  'stream-retry.chunk.js',
], { require, filename: __filename });
