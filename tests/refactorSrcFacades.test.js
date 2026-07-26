const assert = require('assert');

const src = require('../src');

const newHttp = require('../src/model/http');
const newHttpAnthropic = require('../src/model/http/anthropic');
const newHttpCacheControl = require('../src/model/http/cache-control');
const newHttpImages = require('../src/model/http/images');
const newHttpOpenAICompatible = require('../src/model/http/openai-compatible');
const newHttpTransport = require('../src/model/http/transport');

const newRuntimeHost = require('../src/runtime-v2/host');

const newVectorMemory = require('../src/memory/vector');
const newVectorEmbedding = require('../src/memory/vector/embedding');
const newVectorRetrieval = require('../src/memory/vector/retrieval');
const newVectorStore = require('../src/memory/vector/store');
const newVectorWrite = require('../src/memory/vector/write');

const newPlanning = require('../src/runtime-v2/planning');
const planningConstants = require('../src/runtime-v2/planning/constants');
const planningClassifiers = require('../src/runtime-v2/planning/classifiers');
const planningPrompt = require('../src/runtime-v2/planning/prompt');
const planningTools = require('../src/runtime-v2/planning/tool-selection');
const planningNormalizer = require('../src/runtime-v2/planning/normalizer');

const newMemoryCli = require('../src/memory/cli');

function assertFunctions(target, names) {
  for (const name of names) {
    assert.strictEqual(typeof target[name], 'function', `${name} must be exported`);
  }
}

assertFunctions(newHttp, [
  'prepareRequest',
  'mapMessagesToAnthropic',
  'resolveOpenAICompatibleImagePart',
  'preprocessOpenAICompatibleMessages',
  'postWithRetry',
  'getAxiosOptions'
]);
assertFunctions(newHttpAnthropic, ['mapMessagesToAnthropic', 'buildAnthropicRequestHeaders']);
assertFunctions(newHttpCacheControl, ['normalizeAnthropicCacheControl', 'stripCacheControlFields']);
assertFunctions(newHttpImages, ['resolveOpenAICompatibleImagePart']);
assertFunctions(newHttpOpenAICompatible, ['preprocessOpenAICompatibleMessages']);
assertFunctions(newHttpTransport, ['postWithRetry', 'getAxiosOptions']);
assert.strictEqual(newHttp.mapMessagesToAnthropic, newHttpAnthropic.mapMessagesToAnthropic);
assert.strictEqual(newHttp.resolveOpenAICompatibleImagePart, newHttpImages.resolveOpenAICompatibleImagePart);
assert.strictEqual(newHttp.preprocessOpenAICompatibleMessages, newHttpOpenAICompatible.preprocessOpenAICompatibleMessages);
assert.strictEqual(newHttp.postWithRetry, newHttpTransport.postWithRetry);
assert.strictEqual(newHttp.getAxiosOptions, newHttpTransport.getAxiosOptions);
assert.deepStrictEqual(newHttpCacheControl.normalizeAnthropicCacheControl('1h'), {
  type: 'ephemeral',
  ttl: '1h'
});
assert.deepStrictEqual(
  newHttpCacheControl.stripCacheControlFields({ name: 'x', cache_control: {}, cache: true }),
  { name: 'x' }
);

assertFunctions(newRuntimeHost, [
  'applyRuntimeReplyOutput',
  'createRuntime',
  'askAIByGraphV2',
  'getRuntime',
  'resetRuntime'
]);
const runtimeOptions = {};
assert.strictEqual(newRuntimeHost.applyRuntimeReplyOutput({
  output: {
    displayReply: '<think>hidden</think> visible',
    persistedReplyText: ' persisted ',
    reasoningText: ' raw '
  }
}, runtimeOptions), 'visible');
assert.strictEqual(runtimeOptions.persistedReplyText, 'persisted');
assert.strictEqual(runtimeOptions.reasoningText, 'raw');

assertFunctions(newVectorMemory, ['retrieveRelevantMemories', 'addMemoryItem']);
assertFunctions(newVectorEmbedding, ['requestEmbedding', 'shouldUseRemoteEmbedding']);
assertFunctions(newVectorRetrieval, ['retrieveUnifiedMemories']);
assertFunctions(newVectorStore, ['loadLibrary']);
assertFunctions(newVectorWrite, ['addMemoryItemsBatch']);

assertFunctions(newPlanning, ['planRequestV2', 'sanitizePlan']);
assert.strictEqual(planningConstants.PLANNER_DECISION_VERSION, 'planner_decision_v2');
assertFunctions(planningClassifiers, ['prefersMemoryRecall']);
assert.strictEqual(planningClassifiers.prefersMemoryRecall('你还记得昨天聊了什么吗'), true);
assert.strictEqual(planningClassifiers.prefersMemoryRecall('把这句话翻译成英文'), false);
assertFunctions(planningPrompt, ['buildPlannerPrompt']);
assertFunctions(planningTools, ['pickMinimalToolAllowlist']);
assertFunctions(planningNormalizer, ['normalizePlannerDecisionV2']);

assertFunctions(newMemoryCli, ['runMemoryCli']);

const passiveAwareness = require('../src/features/passive-awareness');
assertFunctions(passiveAwareness, ['handlePassiveGroupAwareness']);

assertFunctions(src.model.http, ['prepareRequest']);
assertFunctions(src.runtimeV2.host, ['createRuntime']);
assertFunctions(src.memory.vector, ['addMemoryItem']);
assert.strictEqual(src.model.http.prepareRequest, newHttp.prepareRequest);
assert.strictEqual(src.runtimeV2.host.createRuntime, newRuntimeHost.createRuntime);
assert.strictEqual(src.memory.vector.addMemoryItem, newVectorMemory.addMemoryItem);

console.log('refactorSrcFacades.test.js passed');
