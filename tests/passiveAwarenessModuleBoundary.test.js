'use strict';

const assert = require('assert');

const PUBLIC_KEYS = [
  'analyzeConversationWindow',
  'buildCompactPersonaPrompt',
  'buildConversationWindow',
  'buildDecisionPrompt',
  'buildPassiveReplySystemMessages',
  'buildReplyPrompt',
  'cheapRuleGate',
  'classifyPassiveReplyType',
  'decidePresenceAction',
  'detectPassiveAddressee',
  'forcePassiveGroupInterjection',
  'getPresenceConfig',
  'handlePassiveGroupAwareness',
  'isEnabledForGroup',
  'isNoiseText',
  'parseDecision',
  'scoreMessageTrigger',
  'shouldGatePassiveReply',
  'shouldSuppressPresenceAck',
  'shouldSuppressTrivialPresenceReply',
  'trimReplyText'
].sort();

const FACADE_KEYS = {
  gate: [
    'cheapRuleGate',
    'isEnabledForGroup',
    'isNoiseText',
    'scoreMessageTrigger',
    'shouldGatePassiveReply'
  ],
  presence: ['shouldSuppressPresenceAck', 'shouldSuppressTrivialPresenceReply'],
  prompt: ['buildCompactPersonaPrompt', 'buildDecisionPrompt', 'buildReplyPrompt', 'parseDecision'],
  model: ['cheapRuleGate'],
  reply: ['forcePassiveGroupInterjection', 'handlePassiveGroupAwareness', 'trimReplyText']
};

function clearModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

module.exports = (() => {
  const chunkedModulePath = require.resolve('../src/shared/chunkedModule');
  const { runCommonJsChunks } = require(chunkedModulePath);
  const originalChunkedModule = require.cache[chunkedModulePath];
  const modulePaths = [
    '../src/features/passive-awareness',
    '../src/features/passive-awareness/core',
    '../src/features/passive-awareness/force',
    '../src/features/passive-awareness/gate',
    '../src/features/passive-awareness/model-runtime',
    '../src/features/passive-awareness/presence',
    '../src/features/passive-awareness/presence-runtime',
    '../src/features/passive-awareness/prompt',
    '../src/features/passive-awareness/prompt-runtime',
    '../src/features/passive-awareness/model',
    '../src/features/passive-awareness/reply',
    '../core/passiveGroupAwareness'
  ];

  modulePaths.forEach(clearModule);
  require.cache[chunkedModulePath] = {
    id: chunkedModulePath,
    filename: chunkedModulePath,
    loaded: true,
    exports: {
      runCommonJsChunks(baseDir, ownerModule, chunkFiles, options) {
        if (chunkFiles.some((file) => file.startsWith('passiveGroupAwareness.'))) {
          throw new Error('passive-awareness must not execute chunk loader');
        }
        return runCommonJsChunks(baseDir, ownerModule, chunkFiles, options);
      }
    }
  };

  try {
    const passiveAwareness = require('../src/features/passive-awareness');
    const coreFacade = require('../core/passiveGroupAwareness');
    assert.strictEqual(coreFacade, passiveAwareness);
    assert.deepStrictEqual(Object.keys(passiveAwareness).sort(), PUBLIC_KEYS);

    for (const [facadeName, expectedKeys] of Object.entries(FACADE_KEYS)) {
      const facade = require(`../src/features/passive-awareness/${facadeName}`);
      assert.deepStrictEqual(Object.keys(facade).sort(), expectedKeys.slice().sort());
      for (const key of expectedKeys) {
        assert.strictEqual(facade[key], passiveAwareness[key], `${facadeName}.${key}`);
      }
    }
  } finally {
    modulePaths.forEach(clearModule);
    if (originalChunkedModule) require.cache[chunkedModulePath] = originalChunkedModule;
    else delete require.cache[chunkedModulePath];
  }

  console.log('passiveAwarenessModuleBoundary.test.js passed');
})();
