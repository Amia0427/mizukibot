const { runCommonJsChunks } = require('../src/shared/chunkedModule');
module.exports = runCommonJsChunks(__dirname, module, [
  'memeManager.core.chunk.js',
  'memeManager.selector-normalize.chunk.js',
  'memeManager.gate.chunk.js',
  'memeManager.admin.chunk.js',
  'memeManager.asset-analysis.chunk.js',
  'memeManager.selector.chunk.js',
  'memeManager.commands.chunk.js',
  'memeManager.followup.chunk.js',
  'memeManager.exports.chunk.js',
], { require, filename: __filename });