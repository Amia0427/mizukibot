const assert = require('assert');

const {
  collectLocalMemoryTexts,
  dedupeMemosRecallAgainstMemoryContext,
  findDuplicateReason,
  normalizeMemosItems
} = require('../utils/memoryRecallDeduper');

(() => {
  const memoryContext = {
    memoryForPrompt: '[RelevantEvidence]\n用户偏好直接给结论，再补关键细节。\n\n[TaskMemory]\n当前项目要求并行开发时不要覆盖他人改动。',
    promptRetrievedMemoryText: '用户偏好直接给结论，再补关键细节。',
    segments: {
      retrievedMemory: [
        { role: 'system', content: '当前项目要求并行开发时不要覆盖他人改动。' }
      ]
    }
  };

  const localTexts = collectLocalMemoryTexts(memoryContext);
  assert.ok(localTexts.some((text) => text.includes('直接给结论')));
  assert.strictEqual(findDuplicateReason('用户偏好直接给结论，再补关键细节。', localTexts), 'normalized_hash');
  assert.ok(findDuplicateReason('用户偏好先直接给结论，然后再补关键细节。', localTexts));

  const recall = {
    query: '继续项目',
    used: true,
    promptText: '[MemOSRecall]\n1. 用户偏好直接给结论，再补关键细节。\n2. 用户使用 MemOS 做远端记忆召回。',
    items: [
      { id: 'dup', text: '用户偏好直接给结论，再补关键细节。' },
      { id: 'fresh', text: '用户使用 MemOS 做远端记忆召回。' }
    ],
    diagnostics: {
      serverName: 'memos-api-mcp'
    }
  };

  const deduped = dedupeMemosRecallAgainstMemoryContext(recall, memoryContext, { maxChars: 500 });
  assert.strictEqual(deduped.used, true);
  assert.deepStrictEqual(deduped.items.map((item) => item.id), ['fresh']);
  assert.ok(deduped.promptText.includes('[MemOSRecall]'));
  assert.ok(!deduped.promptText.includes('直接给结论'));
  assert.strictEqual(deduped.diagnostics.dedupe.removed, 1);
  assert.strictEqual(deduped.diagnostics.dedupe.removedItems[0].reason, 'normalized_hash');

  const allDuplicate = dedupeMemosRecallAgainstMemoryContext({
    query: '继续项目',
    used: true,
    items: [
      { id: 'dup', text: '当前项目要求并行开发时不要覆盖他人改动。' }
    ]
  }, memoryContext);
  assert.strictEqual(allDuplicate.used, false);
  assert.strictEqual(allDuplicate.rejectedReason, 'deduped_by_local_memory');
  assert.strictEqual(allDuplicate.promptText, '');

  const promptOnly = normalizeMemosItems({
    promptText: '[MemOSRecall]\n1. 用户偏好直接给结论。\n2. 用户喜欢简短回答。'
  });
  assert.strictEqual(promptOnly.length, 2);
  assert.strictEqual(promptOnly[0].text, '用户偏好直接给结论。');

  console.log('memoryRecallDeduper.test.js passed');
})();
