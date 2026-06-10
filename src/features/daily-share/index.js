const path = require('path');
const { createRequire } = require('module');
const { runCommonJsChunks } = require('../../shared/chunkedModule');

const legacyCoreDir = path.resolve(__dirname, '../../../core');
const legacyDailyShareFile = path.join(legacyCoreDir, 'dailyShareEngine.js');
const legacyRequire = createRequire(legacyDailyShareFile);

module.exports = runCommonJsChunks(legacyCoreDir, module, [
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
], { require: legacyRequire, filename: legacyDailyShareFile });
