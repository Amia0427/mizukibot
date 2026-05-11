const { runCommonJsChunks } = require('../src/shared/chunkedModule');
module.exports = runCommonJsChunks(__dirname, module, [
  'passiveGroupAwareness.core.chunk.js',
  'passiveGroupAwareness.presence.chunk.js',
  'passiveGroupAwareness.prompts.chunk.js',
  'passiveGroupAwareness.model.chunk.js',
  'passiveGroupAwareness.runtime.chunk.js',
  'passiveGroupAwareness.force.chunk.js',
], { require, filename: __filename });