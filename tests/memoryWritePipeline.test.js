const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-write-pipeline-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_WRITE_PIPELINE_ENABLED = 'true';
process.env.MEMORY_EXTRACT_MIN_CONFIDENCE = '0.72';
fs.mkdirSync(tempRoot, { recursive: true });
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));

const { addMemoryItemsBatch, getMemoryItems } = require('../utils/vectorMemory');

const firstIds = addMemoryItemsBatch([{
  userId: 'u_pipeline',
  type: 'fact',
  text: 'prefers concise answers',
  source: 'test',
  sourceKind: 'extractor',
  confidence: 0.9,
  status: 'active'
}]);
assert.strictEqual(firstIds.length, 1, 'first write should persist');

const duplicateIds = addMemoryItemsBatch([{
  userId: 'u_pipeline',
  type: 'fact',
  text: 'prefers concise answers',
  source: 'test',
  sourceKind: 'extractor',
  confidence: 0.95,
  status: 'active'
}]);
assert.strictEqual(duplicateIds.length, 0, 'duplicate write should be skipped');

const lowConfidenceIds = addMemoryItemsBatch([{
  userId: 'u_pipeline',
  type: 'style',
  text: 'maybe likes extremely verbose replies',
  source: 'test',
  sourceKind: 'extractor',
  confidence: 0.3
}]);
assert.strictEqual(lowConfidenceIds.length, 0, 'low confidence write should be skipped');

assert.strictEqual(getMemoryItems('u_pipeline').length, 1, 'only accepted memory should remain');
console.log('memoryWritePipeline.test.js passed');