const path = require('path');
const { createRequire } = require('module');
const { runCommonJsChunks } = require('../../shared/chunkedModule');

const legacyCoreDir = path.resolve(__dirname, '../../../core');
const legacyPassiveFile = path.join(legacyCoreDir, 'passiveGroupAwareness.js');
const legacyRequire = createRequire(legacyPassiveFile);

module.exports = runCommonJsChunks(legacyCoreDir, module, [
  'passiveGroupAwareness.core.chunk.js',
  'passiveGroupAwareness.presence.chunk.js',
  'passiveGroupAwareness.prompts.chunk.js',
  'passiveGroupAwareness.model.chunk.js',
  'passiveGroupAwareness.runtime.chunk.js',
  'passiveGroupAwareness.force.chunk.js',
], { require: legacyRequire, filename: legacyPassiveFile });
