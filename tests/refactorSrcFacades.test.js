const assert = require('assert');

const src = require('../src');

const oldHttp = require('../api/httpClient');
const newHttp = require('../src/model/http');
const newHttpAnthropic = require('../src/model/http/anthropic');
const newHttpCacheControl = require('../src/model/http/cache-control');
const newHttpImages = require('../src/model/http/images');
const newHttpOpenAICompatible = require('../src/model/http/openai-compatible');
const newHttpTransport = require('../src/model/http/transport');
assert.strictEqual(newHttp.prepareRequest, oldHttp.prepareRequest);
assert.strictEqual(newHttp.mapMessagesToAnthropic, oldHttp.mapMessagesToAnthropic);
assert.strictEqual(newHttpAnthropic.mapMessagesToAnthropic, oldHttp.mapMessagesToAnthropic);
assert.strictEqual(typeof newHttpAnthropic.buildAnthropicRequestHeaders, 'function');
assert.strictEqual(typeof newHttpCacheControl.normalizeAnthropicCacheControl, 'function');
assert.strictEqual(typeof newHttpCacheControl.stripCacheControlFields, 'function');
assert.strictEqual(newHttpImages.resolveOpenAICompatibleImagePart, oldHttp.resolveOpenAICompatibleImagePart);
assert.strictEqual(newHttpOpenAICompatible.preprocessOpenAICompatibleMessages, oldHttp.preprocessOpenAICompatibleMessages);
assert.strictEqual(newHttpTransport.postWithRetry, oldHttp.postWithRetry);
assert.strictEqual(newHttpTransport.getAxiosOptions, oldHttp.getAxiosOptions);

const oldRuntimeHost = require('../api/runtimeV2/host');
const newRuntimeHost = require('../src/runtime-v2/host');
assert.strictEqual(newRuntimeHost.createRuntime, oldRuntimeHost.createRuntime);
assert.strictEqual(newRuntimeHost.askAIByGraphV2, oldRuntimeHost.askAIByGraphV2);

const oldVectorMemory = require('../utils/vectorMemory');
const newVectorMemory = require('../src/memory/vector');
const newVectorEmbedding = require('../src/memory/vector/embedding');
const newVectorRetrieval = require('../src/memory/vector/retrieval');
const newVectorStore = require('../src/memory/vector/store');
const newVectorWrite = require('../src/memory/vector/write');
assert.strictEqual(newVectorMemory.retrieveRelevantMemories, oldVectorMemory.retrieveRelevantMemories);
assert.strictEqual(newVectorMemory.addMemoryItem, oldVectorMemory.addMemoryItem);
assert.strictEqual(newVectorEmbedding.requestEmbedding, oldVectorMemory.requestEmbedding);
assert.strictEqual(newVectorEmbedding.shouldUseRemoteEmbedding, oldVectorMemory.shouldUseRemoteEmbedding);
assert.strictEqual(newVectorRetrieval.retrieveUnifiedMemories, oldVectorMemory.retrieveUnifiedMemories);
assert.strictEqual(newVectorStore.loadLibrary, oldVectorMemory.loadLibrary);
assert.strictEqual(newVectorWrite.addMemoryItemsBatch, oldVectorMemory.addMemoryItemsBatch);

const oldPlanning = require('../api/runtimeV2/planning/service');
const newPlanning = require('../src/runtime-v2/planning');
const planningConstants = require('../src/runtime-v2/planning/constants');
const planningClassifiers = require('../src/runtime-v2/planning/classifiers');
const planningPrompt = require('../src/runtime-v2/planning/prompt');
const planningTools = require('../src/runtime-v2/planning/tool-selection');
const planningNormalizer = require('../src/runtime-v2/planning/normalizer');
assert.strictEqual(newPlanning.planRequestV2, oldPlanning.planRequestV2);
assert.strictEqual(planningConstants.PLANNER_DECISION_VERSION, oldPlanning.PLANNER_DECISION_VERSION);
assert.strictEqual(planningClassifiers.prefersMemoryRecall, oldPlanning.prefersMemoryRecall);
assert.strictEqual(planningPrompt.buildPlannerPrompt, oldPlanning.buildPlannerPrompt);
assert.strictEqual(planningTools.pickMinimalToolAllowlist, oldPlanning.pickMinimalToolAllowlist);
assert.strictEqual(planningNormalizer.normalizePlannerDecisionV2, oldPlanning.normalizePlannerDecisionV2);

const oldMemoryCli = require('../utils/memoryCli');
const newMemoryCli = require('../src/memory/cli');
assert.strictEqual(newMemoryCli.runMemoryCli, oldMemoryCli.runMemoryCli);

const passiveAwareness = require('../src/features/passive-awareness');
assert.strictEqual(typeof passiveAwareness.handlePassiveGroupAwareness, 'function');

assert.strictEqual(src.model.http.prepareRequest, oldHttp.prepareRequest);
assert.strictEqual(src.runtimeV2.host.createRuntime, oldRuntimeHost.createRuntime);
assert.strictEqual(src.memory.vector.addMemoryItem, oldVectorMemory.addMemoryItem);

console.log('refactorSrcFacades.test.js passed');
