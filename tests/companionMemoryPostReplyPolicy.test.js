'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-companion-memory-post-reply-'));
process.env.API_KEY = process.env.API_KEY || 'test-key';
process.env.DATA_DIR = tempRoot;
process.env.COMPANION_MEMORY_SETTINGS_FILE = path.join(tempRoot, 'companion-memory-settings.json');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.POST_REPLY_VECTOR_MAINTENANCE_ENABLED = 'false';
process.env.POST_REPLY_MEMORY_QUALITY_AUDIT_ENABLED = 'false';
process.env.MEMORY_PROFILE_MAINTENANCE_ENABLED = 'false';

module.exports = (async () => {
  const { getCompanionMemoryService } = require('../src/features/companion-memory/runtime');
  getCompanionMemoryService().setAutoMemoryEnabled('memory-off-user', false);

  const memoryExtraction = require('../api/memoryExtraction');
  const dailyJournal = require('../utils/dailyJournal');
  const memoryV3 = require('../utils/memory-v3');
  const calls = [];
  const originals = {
    learnSomethingNew: memoryExtraction.learnSomethingNew,
    extractPostReplyEnrichment: memoryExtraction.extractPostReplyEnrichment,
    appendDailyJournalEntry: dailyJournal.appendDailyJournalEntry,
    appendVersionedMemoryUpdate: memoryV3.appendVersionedMemoryUpdate
  };

  memoryExtraction.learnSomethingNew = async (...args) => {
    calls.push({ type: 'memory', options: args[3] || {} });
  };
  memoryExtraction.extractPostReplyEnrichment = async () => {
    calls.push({ type: 'enrich' });
    return {};
  };
  dailyJournal.appendDailyJournalEntry = async () => {
    calls.push({ type: 'journal' });
  };
  memoryV3.appendVersionedMemoryUpdate = async () => {
    calls.push({ type: 'turn_summary' });
  };

  try {
    const { processPostReplyJob } = require('../utils/postReplyWorker/processJob');
    await processPostReplyJob({
      userId: 'memory-off-user',
      question: '普通私聊',
      finalReply: '普通回复',
      topRouteType: 'direct_chat',
      routeMeta: { chatType: 'private' },
      tasks: { memoryLearning: true, dailyJournal: true },
      phase: 'core'
    });
    assert.strictEqual(calls.filter((item) => item.type === 'memory').length, 1);
    assert.strictEqual(calls.find((item) => item.type === 'memory').options.conversationVariablesOnly, true);
    assert.strictEqual(calls.filter((item) => item.type === 'journal').length, 1);
    assert.strictEqual(calls.filter((item) => item.type === 'turn_summary').length, 0);

    calls.length = 0;
    await processPostReplyJob({
      userId: 'memory-off-user',
      question: '请记住我喜欢短回复',
      finalReply: '记住了',
      topRouteType: 'direct_chat',
      routeMeta: { chatType: 'private' },
      tasks: { memoryLearning: true },
      phase: 'core'
    });
    assert.strictEqual(calls.filter((item) => item.type === 'memory').length, 1);
    assert.strictEqual(calls.find((item) => item.type === 'memory').options.conversationVariablesOnly, false);
    assert.strictEqual(calls.filter((item) => item.type === 'turn_summary').length, 0);

    calls.length = 0;
    await processPostReplyJob({
      userId: 'memory-off-user',
      question: '普通群聊',
      finalReply: '普通回复',
      topRouteType: 'direct_chat',
      routeMeta: { chatType: 'group', groupId: 'group-1' },
      tasks: { memoryLearning: true },
      phase: 'core'
    });
    assert.strictEqual(calls.filter((item) => item.type === 'memory').length, 0);

    calls.length = 0;
    await processPostReplyJob({
      userId: 'memory-off-user',
      question: 'enrich question',
      finalReply: 'enrich reply',
      turns: [{ question: 'enrich question', finalReply: 'enrich reply' }],
      tasks: { enrich: true },
      phase: 'enrich'
    });
    assert.strictEqual(calls.filter((item) => item.type === 'enrich').length, 0);

    console.log('companionMemoryPostReplyPolicy.test.js passed');
  } finally {
    memoryExtraction.learnSomethingNew = originals.learnSomethingNew;
    memoryExtraction.extractPostReplyEnrichment = originals.extractPostReplyEnrichment;
    dailyJournal.appendDailyJournalEntry = originals.appendDailyJournalEntry;
    memoryV3.appendVersionedMemoryUpdate = originals.appendVersionedMemoryUpdate;
  }
})();
