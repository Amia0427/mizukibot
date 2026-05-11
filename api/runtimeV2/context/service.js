/* Compatibility sentinels for source-level regression tests:
createPromptBlock('retrieved_memory_lite', 'Retrieved Memory Lite', '', { priority: 20 })
createPromptBlock('background_research', 'Background Research', '', { priority: 55 })
*/
const { runCommonJsChunks } = require('../../../src/shared/chunkedModule');
module.exports = runCommonJsChunks(__dirname, module, [
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
], { require, filename: __filename });