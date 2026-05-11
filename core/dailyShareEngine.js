const { runCommonJsChunks } = require('../src/shared/chunkedModule');
module.exports = runCommonJsChunks(__dirname, module, [
  'dailyShareEngine.core.chunk.js',
  'dailyShareEngine.schedule.chunk.js',
  'dailyShareEngine.qzone-prompt.chunk.js',
  'dailyShareEngine.memory-plan.chunk.js',
  'dailyShareEngine.memory-evidence.chunk.js',
  'dailyShareEngine.memory-prefetch.chunk.js',
  'dailyShareEngine.window.chunk.js',
  'dailyShareEngine.runtime.chunk.js',
  'dailyShareEngine.runtime-02.chunk.js',
  'dailyShareEngine.exports.chunk.js',
], { require, filename: __filename });