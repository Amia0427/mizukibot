const assert = require('assert');

const src = require('../src');

const oldHttp = require('../api/httpClient');
const newHttp = require('../src/model/http');
assert.strictEqual(newHttp.prepareRequest, oldHttp.prepareRequest);
assert.strictEqual(newHttp.mapMessagesToAnthropic, oldHttp.mapMessagesToAnthropic);

const oldRuntimeHost = require('../api/runtimeV2/host');
const newRuntimeHost = require('../src/runtime-v2/host');
assert.strictEqual(newRuntimeHost.createRuntime, oldRuntimeHost.createRuntime);
assert.strictEqual(newRuntimeHost.askAIByGraphV2, oldRuntimeHost.askAIByGraphV2);

const oldVectorMemory = require('../utils/vectorMemory');
const newVectorMemory = require('../src/memory/vector');
assert.strictEqual(newVectorMemory.retrieveRelevantMemories, oldVectorMemory.retrieveRelevantMemories);
assert.strictEqual(newVectorMemory.addMemoryItem, oldVectorMemory.addMemoryItem);

const oldMemoryCli = require('../utils/memoryCli');
const newMemoryCli = require('../src/memory/cli');
assert.strictEqual(newMemoryCli.runMemoryCli, oldMemoryCli.runMemoryCli);

const passiveAwareness = require('../src/features/passive-awareness');
assert.strictEqual(typeof passiveAwareness.handlePassiveGroupAwareness, 'function');

assert.strictEqual(src.model.http.prepareRequest, oldHttp.prepareRequest);
assert.strictEqual(src.runtimeV2.host.createRuntime, oldRuntimeHost.createRuntime);
assert.strictEqual(src.memory.vector.addMemoryItem, oldVectorMemory.addMemoryItem);

console.log('refactorSrcFacades.test.js passed');
