const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-image-summary-repair-'));
process.env.DATA_DIR = tempRoot;
process.env.IMAGE_MEMORY_INDEX_FILE = path.join(tempRoot, 'image_memory_index.json');
process.env.IMAGE_MEMORY_RECALL_ENABLED = 'true';
process.env.MEMORY_SCOPE_INDEX_FILE = path.join(tempRoot, 'memory_scope_index.json');
process.env.TIMEZONE = 'Asia/Shanghai';

fs.writeFileSync(process.env.MEMORY_SCOPE_INDEX_FILE, JSON.stringify({ version: 1, users: {} }, null, 2));

const badSummary = `[2026-06-04 13:40] ${JSON.stringify({
  id: 'chatcmpl-bad',
  object: 'chat.completion',
  choices: [{
    message: {
      role: 'assistant',
      content: '',
      reasoning_content: '这里是模型推理，不应进入图片记忆。'
    }
  }]
})}`;

fs.writeFileSync(process.env.IMAGE_MEMORY_INDEX_FILE, JSON.stringify({
  version: 1,
  images: {
    today_bad: {
      cacheKey: 'today_bad',
      imageRef: 'cached-image://today_bad',
      createdAt: Date.parse('2026-06-04T13:40:00+08:00'),
      lastSeenAt: Date.parse('2026-06-04T13:41:00+08:00'),
      summary: badSummary,
      observations: [{ observedAt: Date.parse('2026-06-04T13:40:00+08:00'), summary: badSummary }]
    },
    yesterday_bad: {
      cacheKey: 'yesterday_bad',
      imageRef: 'cached-image://yesterday_bad',
      createdAt: Date.parse('2026-06-03T13:40:00+08:00'),
      lastSeenAt: Date.parse('2026-06-03T13:41:00+08:00'),
      summary: badSummary,
      observations: [{ observedAt: Date.parse('2026-06-03T13:40:00+08:00'), summary: badSummary }]
    }
  }
}, null, 2));

const { repairImageMemorySummaries } = require('../scripts/repair-image-memory-summaries');

function readRawIndex() {
  return JSON.parse(fs.readFileSync(process.env.IMAGE_MEMORY_INDEX_FILE, 'utf8'));
}

const dryRun = repairImageMemorySummaries({ day: '2026-06-04' });
assert.strictEqual(dryRun.apply, false);
assert.strictEqual(dryRun.changed, 2);
assert.strictEqual(readRawIndex().images.today_bad.summary.includes('reasoning_content'), true);

const applied = repairImageMemorySummaries({ day: '2026-06-04', apply: true });
assert.strictEqual(applied.apply, true);
assert.strictEqual(applied.changed, 2);

const index = readRawIndex();
assert.strictEqual(index.images.today_bad.summary || '', '');
assert.strictEqual(index.images.today_bad.observations[0].summary || '', '');
assert.strictEqual(index.images.yesterday_bad.summary.includes('reasoning_content'), true);

console.log('imageMemorySummaryRepair.test.js passed');
