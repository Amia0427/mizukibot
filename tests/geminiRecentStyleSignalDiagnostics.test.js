const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildGeminiRecentStyleSignalDiagnostic,
  buildGeminiRecentStyleSignalText
} = require('../utils/geminiRecentStyleSignalDiagnostics');

(() => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-gemini-style-diag-'));
  const storePath = path.join(tempDir, 'gemini-recent-style-signals.json');
  const now = Date.parse('2026-06-13T04:00:00.000Z');

  try {
    fs.writeFileSync(storePath, JSON.stringify({
      schemaVersion: 1,
      records: [
        {
          createdAt: '2026-06-13T01:00:00.000Z',
          modelName: 'gemini-3-flash-preview',
          scopeKey: 'group:g1',
          openings: ['诶——'],
          tails: ['呢'],
          stockPhrases: ['犯规', '小彩蛋']
        },
        {
          createdAt: '2026-06-13T02:00:00.000Z',
          modelName: 'gemini-3-flash-preview',
          scopeKey: 'group:g1',
          openings: ['诶——'],
          tails: ['喔'],
          stockPhrases: ['犯规', '特殊奖励']
        },
        {
          createdAt: '2026-06-13T03:00:00.000Z',
          modelName: 'gemini-3-flash-preview',
          scopeKey: 'group:g2',
          openings: ['呜哇'],
          tails: ['呢'],
          stockPhrases: ['秘密小彩蛋', '安全距离']
        }
      ]
    }, null, 2), 'utf8');

    const report = buildGeminiRecentStyleSignalDiagnostic({
      storePath,
      now,
      lookbackRecords: 18,
      limit: 8
    });

    assert.strictEqual(report.schemaVersion, 'gemini_recent_style_signal_diagnostic_v1');
    assert.strictEqual(report.status, 'ok');
    assert.strictEqual(report.summary.totalRecords, 3);
    assert.strictEqual(report.summary.diagnosticRecords, 3);
    assert.strictEqual(report.summary.latestRecordAt, '2026-06-13T03:00:00.000Z');
    assert.strictEqual(report.summary.wouldInjectGeminiRecentStyleGuard, true);

    const opening = report.signals.openings.items[0];
    assert.strictEqual(opening.value, '诶——');
    assert.strictEqual(opening.hitCount, 2);
    assert.strictEqual(opening.lastHitAt, '2026-06-13T02:00:00.000Z');
    assert.strictEqual(opening.triggersGeminiRecentStyleGuard, true);

    const tail = report.signals.tails.items.find((item) => item.value === '呢');
    assert.strictEqual(tail.hitCount, 2);
    assert.strictEqual(tail.lastHitAt, '2026-06-13T03:00:00.000Z');
    assert.strictEqual(tail.triggersGeminiRecentStyleGuard, true);

    const phrase = report.signals.stockPhrases.items.find((item) => item.value === '犯规');
    assert.strictEqual(phrase.hitCount, 2);
    assert.strictEqual(phrase.triggersGeminiRecentStyleGuard, true);

    const text = buildGeminiRecentStyleSignalText(report);
    assert.ok(text.includes('gemini-style-signals: ok records=3 recent=3 guard=would-inject'));
    assert.ok(text.includes('诶—— count=2'));
    assert.ok(text.includes('犯规 count=2'));

    const missing = buildGeminiRecentStyleSignalDiagnostic({
      storePath: path.join(tempDir, 'missing.json'),
      now
    });
    assert.strictEqual(missing.status, 'missing');
    assert.strictEqual(missing.summary.wouldInjectGeminiRecentStyleGuard, false);

    console.log('geminiRecentStyleSignalDiagnostics.test.js passed');
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
})();
