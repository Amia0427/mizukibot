const assert = require('assert');

const { createHumanizeNode } = require('../api/runtimeV2/nodes/humanize');

module.exports = (async () => {
  const deltas = [];
  const humanizeNode = createHumanizeNode({
    normalizeObject: (value, fallback = {}) => (value && typeof value === 'object' ? value : fallback),
    createEvent: (type, payload = {}) => ({ type, ...payload }),
    isReviewMode: () => false,
    isReplyFailure: () => false,
    isHumanizerEnabledImpl: () => true,
    shouldBypassHumanizerForPolicy: () => false,
    ensureOutputStream: () => ({ hadOutput: false, completed: false, fallbackToNonStream: false, mode: 'none' }),
    mirrorStreamingFlags: (_output, text) => ({ hadOutput: Boolean(text) }),
    getMaxSegments: () => 3,
    runHumanizerImpl: async () => {
      const error = new Error('humanizer stalled');
      error.reason = 'humanizer_first_token_timeout';
      error.humanizerFirstTokenTimeout = true;
      throw error;
    },
    saveAndEmit: (state) => state
  });

  const result = await humanizeNode({
    request: {
      question: 'hi',
      streaming: true,
      onDelta(text, fullText) {
        deltas.push({ text, fullText });
      }
    },
    memory: {},
    execution: { latencyDecision: { humanizeMode: 'force' } },
    output: {
      draftReply: '原始回复。',
      stream: { hadOutput: false }
    },
    events: []
  });

  assert.strictEqual(result.output.finalReply, '原始回复。');
  assert.strictEqual(result.output.stream.humanizerTimedOut, true);
  assert.strictEqual(result.output.stream.fallbackToNonStream, false);
  assert.strictEqual(result.execution.humanizerFirstTokenTimeout, true);
  assert.deepStrictEqual(deltas, [{ text: '原始回复。', fullText: '原始回复。' }]);
  assert.ok(result.events.some((event) => event.type === 'humanizer_first_token_timeout'));

  const longGroupDraft = '最先要记的是役和振听。然后你要理解立直的条件。还有一个坑是副露之后很多门清役会消失。推荐路线是先打雀魂低段，再复盘系统提示，最后再补番种表。';
  const groupDeltas = [];
  const groupResult = await humanizeNode({
    request: {
      question: 'hi',
      streaming: true,
      topRouteType: 'direct_chat',
      routeMeta: { groupId: '1092700300' },
      onDelta(text, fullText) {
        groupDeltas.push({ text, fullText });
      }
    },
    memory: {},
    execution: { latencyDecision: { humanizeMode: 'force' } },
    output: {
      draftReply: longGroupDraft,
      stream: { hadOutput: false }
    },
    events: []
  });

  assert.strictEqual(groupResult.output.stream.humanizerTimedOut, true);
  assert.ok(groupResult.output.finalReply.length < longGroupDraft.length);
  assert.strictEqual(groupDeltas.length, 1);
  assert.strictEqual(groupDeltas[0].text, groupResult.output.finalReply);

  console.log('runtimeHumanizeNode.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
