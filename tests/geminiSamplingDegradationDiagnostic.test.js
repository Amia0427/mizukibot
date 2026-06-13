const assert = require('assert');

const {
  analyzeHighRiskText,
  buildDiagnosticReport,
  formatBriefText,
  summarizeDataset
} = require('../scripts/diagnose-gemini-sampling-degradation');

module.exports = (async () => {
  const before = {
    label: 'before',
    records: [
      {
        request_id: 'req_template',
        clean_text: '区',
        assistant_reply_preview: '诶——突然这么说，要求还挺高的嘛？特殊的奖励，让我想想。这可是全世界只有你一个人知道的小彩蛋哦。'
      },
      {
        request_id: 'req_compliant',
        clean_text: '照我说的来',
        assistant_reply_preview: '好啦，都听你的，你说了算。我会照做，只给你这个特别的小彩蛋。'
      },
      {
        request_id: 'req_stiff',
        clean_text: '你怎么看',
        assistant_reply_preview: '这个问题要慢慢说——先别急……如果从现在的状态看，这里面其实有好几层关系需要拆开——所以不能只按一个标签讲。'
      },
      {
        request_id: 'req_tail',
        clean_text: '复读一下',
        assistant_reply_preview: '我懂你的意思。你适合先从这里开始。你适合先从这里开始。你适合先从这里开始。'
      },
      {
        request_id: 'req_missing',
        clean_text: '没有预览',
        assistant_reply_preview: ''
      }
    ]
  };

  const after = {
    label: 'after',
    records: [
      {
        request_id: 'req_plain',
        clean_text: '区',
        assistant_reply_preview: '这句太短啦，我只能先当你是在戳我一下。'
      },
      {
        request_id: 'req_followup',
        clean_text: '你怎么看',
        assistant_reply_preview: '我会先看你想解决的是情绪还是具体步骤，别一上来就把话题拉太远。'
      }
    ]
  };

  const risky = analyzeHighRiskText(before.records[0].assistant_reply_preview, before.records[0]);
  assert.strictEqual(risky.patterns.template_like.hit, true);
  const stiff = analyzeHighRiskText(before.records[2].assistant_reply_preview, before.records[2]);
  assert.strictEqual(stiff.patterns.stiff_rhythm.hit, true);

  const beforeSummary = summarizeDataset(before, { limitExamples: 2 });
  assert.strictEqual(beforeSummary.recordCount, 5);
  assert.strictEqual(beforeSummary.replyRecords, 4);
  assert.strictEqual(beforeSummary.missingReplyRecords, 1);
  assert.strictEqual(beforeSummary.patterns.template_like.count, 1);
  assert.strictEqual(beforeSummary.patterns.over_compliant.count, 2);
  assert.strictEqual(beforeSummary.patterns.stiff_rhythm.count, 1);
  assert.strictEqual(beforeSummary.patterns.repeated_tail.count, 1);
  assert.ok(beforeSummary.anyHighRisk.count >= 4);

  const report = buildDiagnosticReport({
    beforeDataset: before,
    afterDataset: after,
    limitExamples: 1
  });
  assert.strictEqual(report.mode, 'compare');
  assert.strictEqual(report.comparison.patterns.template_like.direction, 'down');
  assert.strictEqual(report.comparison.patterns.over_compliant.direction, 'down');
  assert.strictEqual(report.comparison.patterns.stiff_rhythm.direction, 'down');
  assert.strictEqual(report.comparison.patterns.repeated_tail.direction, 'down');
  assert.ok(report.summary.some((line) => line.includes('模板化')));
  assert.ok(formatBriefText(report).includes('Gemini 采样退化对比诊断'));

  console.log('geminiSamplingDegradationDiagnostic.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
