const assert = require('assert');

const {
  containsMemoryMarker,
  summarizePromptMarkerCounts,
  summarizeRequest
} = require('../utils/modelCallTracker/requestSummary');

module.exports = (() => {
  const request = {
    model: 'gpt-5.4',
    stream: false,
    messages: [
      { role: 'system', content: 'persona system' },
      { role: 'system', content: '[RetrievedMemoryLite]\n之前说先查 prompt。' },
      { role: 'system', content: '[DailyJournal]\n2026-05-21 继续排查。' },
      { role: 'system', content: '[ShortTermContinuity]\nUser: 看超时 fallback。' },
      { role: 'system', content: '[MemOSRecall]\nplanner evidence。' },
      { role: 'user', content: '现在情况怎样' }
    ]
  };

  const summary = summarizeRequest(request);
  assert.strictEqual(summary.message_count, 6);
  assert.strictEqual(summary.memory_injected, true);
  assert.strictEqual(summary.prompt_integrity.has_system_prompt, true);
  assert.strictEqual(summary.prompt_integrity.system_message_count, 5);
  assert.strictEqual(summary.prompt_integrity.has_retrieved_memory, true);
  assert.strictEqual(summary.prompt_integrity.has_daily_journal, true);
  assert.strictEqual(summary.prompt_integrity.has_short_term_continuity, true);
  assert.strictEqual(summary.prompt_integrity.has_memos_recall, true);

  const markers = summarizePromptMarkerCounts(request.messages.map((item) => item.content).join('\n'));
  assert.strictEqual(markers.retrieved_memory, 1);
  assert.strictEqual(markers.daily_journal, 1);
  assert.strictEqual(markers.short_term_continuity, 1);
  assert.strictEqual(markers.memos_recall, 1);
  assert.strictEqual(containsMemoryMarker('[RetrievedMemoryLite]\nfoo'), true);

  console.log('modelCallPromptIntegrity.test.js passed');
})();
