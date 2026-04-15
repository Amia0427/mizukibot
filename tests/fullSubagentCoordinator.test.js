const assert = require('assert');

const { createMessageFullSubagentCoordinator } = require('../core/messageFullSubagent');

module.exports = (async () => {
  const coordinator = createMessageFullSubagentCoordinator({
    config: {
      SYSTEM_PROMPT: 'sys',
      FULL_SUBAGENT_MAX_WORKERS: 2,
      SUBAGENT_ENABLED: true,
      SUBAGENT_REVIEW_ENABLED: true,
      SUBAGENT_BACKEND: 'command'
    },
    askAIByGraph: async (question) => {
      if (String(question).includes('Return JSON only')) {
        return '{"workerCount":2,"workers":[{"id":"w1","title":"A","objective":"part A"},{"id":"w2","title":"B","objective":"part B"}],"reviewFocus":"merge"}';
      }
      return 'reviewed answer';
    },
    extractJsonSafely: (raw) => JSON.parse(raw),
    cleanToolReplyText: (text) => String(text || '').trim(),
    resolveToolReplyFormattingPreferences: () => ({}),
    buildToolReplyFormatInstruction: () => 'format',
    startSubagentBridgeCall: async (_question, _userInfo, _userId, _customPrompt, _imageUrl, options) => ({
      promise: Promise.resolve(`worker:${options.sessionSuffix}`),
      cancel() {}
    }),
    buildRuntimePromptOverride: (_name, payload) => JSON.stringify(payload)
  });

  const plan = await coordinator.planFullSubagentWorkers({
    question: 'do work',
    userInfo: {},
    userId: 'u1'
  });
  assert.strictEqual(plan.workerCount, 2);

  const multi = await coordinator.executeFullMultiWorkerTaskWithHandle('do work', {}, 'u1', null, {
    backgroundTaskRuntime: {
      markTaskStatus() {}
    },
    looksLikeModelFailureText: () => false,
    shouldContinue: () => true
  });
  const multiReply = await multi.promise;
  assert.ok(String(multiReply).includes('reviewed answer'));

  const fallback = coordinator.buildFullSubagentFallbackReply([
    { worker: { id: 'w1' }, status: 'rejected', output: '', error: 'failed once' }
  ]);
  assert.ok(String(fallback).includes('failed once'));

  console.log('fullSubagentCoordinator.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
