const path = require('path');
const { createRequire } = require('module');
const { runCommonJsChunks } = require('../../shared/chunkedModule');

const legacyCoreDir = path.resolve(__dirname, '../../../core');
const legacyMemeFile = path.join(legacyCoreDir, 'memeManager.js');
const legacyRequire = createRequire(legacyMemeFile);

module.exports = runCommonJsChunks(legacyCoreDir, module, [
  'memeManager.core.chunk.js',
  'memeManager.selector-normalize.chunk.js',
  'memeManager.gate.chunk.js',
  'memeManager.admin.chunk.js',
  'memeManager.asset-analysis.chunk.js',
  'memeManager.selector.chunk.js',
  'memeManager.commands.chunk.js',
  'memeManager.followup.chunk.js',
  'memeManager.exports.chunk.js',
], { require: legacyRequire, filename: legacyMemeFile });
