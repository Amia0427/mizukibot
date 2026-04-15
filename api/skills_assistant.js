/**
 * api/skills_assistant.js
 * Assistant-oriented utility skills.
 * These tools are designed to help with planning, writing and decision making.
 */

function toArray(input) {
  if (Array.isArray(input)) return input.filter(Boolean).map((v) => String(v).trim()).filter(Boolean);
  if (typeof input === 'string') {
    return input
      .split(/[\n,，;；]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizePriority(v) {
  const s = String(v || '').toLowerCase();
  if (['high', 'h', '高', '紧急'].includes(s)) return 'high';
  if (['low', 'l', '低'].includes(s)) return 'low';
  return 'normal';
}

function parseDateLoose(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);

  // 轻量中文相对日期支持
  const now = new Date();
  if (raw.includes('今天')) return now.toISOString().slice(0, 10);
  if (raw.includes('明天')) {
    const t = new Date(now.getTime() + 24 * 3600 * 1000);
    return t.toISOString().slice(0, 10);
  }
  if (raw.includes('后天')) {
    const t = new Date(now.getTime() + 2 * 24 * 3600 * 1000);
    return t.toISOString().slice(0, 10);
  }

  return raw;
}

/**
 * Break down a goal into actionable tasks.
 */
async function assistant_task_breakdown(goal, constraints = '', max_tasks = 8) {
  const g = String(goal || '').trim();
  if (!g) return '请提供 goal。';

  const n = Math.max(3, Math.min(20, Number(max_tasks) || 8));
  const cs = toArray(constraints);

  const phases = [
    '明确目标与成功标准',
    '信息收集与资源准备',
    '执行核心任务',
    '验证结果与补漏',
    '交付与复盘'
  ];

  const tasks = [];
  for (let i = 0; i < n; i++) {
    const phase = phases[Math.min(phases.length - 1, Math.floor((i / n) * phases.length))];
    tasks.push({
      id: i + 1,
      title: `${phase} - 子任务 ${i + 1}`,
      description: `围绕「${g}」执行该子任务，并在完成后记录产出。`,
      estimate_hours: i < 2 ? 1 : 2,
      priority: i < 2 ? 'high' : (i < 5 ? 'normal' : 'low'),
      dependencies: i === 0 ? [] : [i]
    });
  }

  return JSON.stringify({
    goal: g,
    constraints: cs,
    total_tasks: tasks.length,
    tasks
  });
}

/**
 * Build weekly agenda from goals.
 */
async function assistant_weekly_agenda(goals = [], start_date = '', focus_hours_per_day = 3) {
  const gs = toArray(goals);
  if (!gs.length) return '请提供 goals（至少一个）。';

  const start = parseDateLoose(start_date) || new Date().toISOString().slice(0, 10);
  const hours = Math.max(1, Math.min(12, Number(focus_hours_per_day) || 3));

  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const items = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const date = d.toISOString().slice(0, 10);

    const goal = gs[i % gs.length];
    items.push({
      day: dayNames[i],
      date,
      focus_goal: goal,
      deep_work_hours: hours,
      checklist: [
        `推进「${goal}」的关键里程碑`,
        '记录阻塞点与下一步',
        '结束前 10 分钟复盘'
      ]
    });
  }

  return JSON.stringify({
    start_date: start,
    focus_hours_per_day: hours,
    agenda: items
  });
}

/**
 * Turn rough meeting topics into a structured agenda.
 */
async function assistant_meeting_agenda(topic, participants = [], duration_minutes = 45, goals = []) {
  const t = String(topic || '').trim();
  if (!t) return '请提供 topic。';

  const ps = toArray(participants);
  const gs = toArray(goals);
  const duration = Math.max(15, Math.min(240, Number(duration_minutes) || 45));

  const blocks = [
    { section: '背景与目标对齐', minutes: Math.max(5, Math.round(duration * 0.15)) },
    { section: '核心议题讨论', minutes: Math.max(10, Math.round(duration * 0.45)) },
    { section: '决策与行动项', minutes: Math.max(5, Math.round(duration * 0.25)) },
    { section: '风险与下一步', minutes: Math.max(5, duration - Math.max(5, Math.round(duration * 0.15)) - Math.max(10, Math.round(duration * 0.45)) - Math.max(5, Math.round(duration * 0.25))) }
  ];

  return JSON.stringify({
    topic: t,
    participants: ps,
    duration_minutes: duration,
    goals: gs,
    agenda_blocks: blocks,
    expected_outputs: ['决策清单', '责任人分配', '截止时间']
  });
}

/**
 * Draft professional emails by intent.
 */
async function assistant_email_draft(intent, recipient = '', key_points = [], tone = 'professional') {
  const i = String(intent || '').trim();
  if (!i) return '请提供 intent，例如：follow_up / request / update / apology。';

  const to = String(recipient || '').trim() || '对方';
  const points = toArray(key_points);
  const t = String(tone || 'professional').trim();

  const subject = {
    follow_up: '跟进事项更新',
    request: '请求协助',
    update: '进度更新',
    apology: '致歉与改进说明'
  }[i] || '邮件沟通';

  const bodyLines = [
    `${to}，你好：`,
    '',
    `这封邮件是关于「${subject}」。`,
    ...(points.length ? points.map((p, idx) => `${idx + 1}. ${p}`) : ['1. 补充具体背景与诉求']),
    '',
    '如有需要，我可以在今天/明天进一步同步细节。',
    '',
    '谢谢。',
    '此致'
  ];

  return JSON.stringify({
    intent: i,
    tone: t,
    subject,
    draft: bodyLines.join('\n')
  });
}

/**
 * Build a weighted decision matrix and ranking.
 */
async function assistant_decision_matrix(options = [], criteria = [], weights = {}) {
  const ops = toArray(options);
  const cs = toArray(criteria);

  if (ops.length < 2) return '至少提供 2 个 options。';
  if (cs.length < 1) return '至少提供 1 个 criteria。';

  const normalizedWeights = {};
  let totalW = 0;
  for (const c of cs) {
    const wRaw = Number(weights?.[c]);
    const w = Number.isFinite(wRaw) && wRaw > 0 ? wRaw : 1;
    normalizedWeights[c] = w;
    totalW += w;
  }

  // 归一化到 1
  for (const c of cs) normalizedWeights[c] = normalizedWeights[c] / totalW;

  const ranking = ops.map((name, idx) => {
    const scores = {};
    let total = 0;
    for (const c of cs) {
      // 演示分：6~9，避免伪精确
      const s = 6 + ((idx + c.length) % 4);
      scores[c] = s;
      total += s * normalizedWeights[c];
    }
    return {
      option: name,
      scores,
      weighted_score: Number(total.toFixed(4))
    };
  }).sort((a, b) => b.weighted_score - a.weighted_score);

  return JSON.stringify({
    criteria: cs,
    weights: normalizedWeights,
    ranking
  });
}

/**
 * Build a daily brief template.
 */
async function assistant_daily_brief(yesterday = [], today = [], blockers = [], mood = '') {
  const y = toArray(yesterday);
  const t = toArray(today);
  const b = toArray(blockers);
  const m = String(mood || '').trim();

  const brief = {
    date: new Date().toISOString().slice(0, 10),
    yesterday: y,
    today: t,
    blockers: b,
    mood: m || 'neutral',
    ask_for_help: b.length > 0
      ? '请协助解除 blocker，并明确优先级。'
      : '暂无 blocker，可继续推进。'
  };

  return JSON.stringify(brief);
}

module.exports = {
  assistant_task_breakdown,
  assistant_weekly_agenda,
  assistant_meeting_agenda,
  assistant_email_draft,
  assistant_decision_matrix,
  assistant_daily_brief,
  research_question_refiner,
  research_literature_matrix,
  research_experiment_plan,
  research_paper_outline,
  research_peer_review_checklist,
  study_syllabus_plan,
  study_active_recall_quiz,
  study_exam_revision_plan,
  research_abstract_structurer,
  research_intro_paragraph_builder,
  research_result_interpreter,
  study_mistake_diagnosis,
  study_spaced_repetition_plan
};

/**
 * Refine a broad research topic into structured research questions.
 */
async function research_question_refiner(topic, domain = '', constraints = '', expected_output = '') {
  const t = String(topic || '').trim();
  if (!t) return '请提供 topic。';

  const d = String(domain || '').trim() || 'general';
  const cs = toArray(constraints);
  const out = String(expected_output || '').trim() || '论文/报告';

  const questions = [
    `在「${d}」场景下，${t} 的核心问题边界是什么？`,
    `${t} 与已有方法相比，关键差异/创新点是什么？`,
    `如何定义可量化指标来评估 ${t} 的效果与稳定性？`,
    `在资源受限条件下，${t} 的可行最小实验方案是什么？`,
    `${t} 在真实场景落地时的主要风险与缓解策略是什么？`
  ];

  return JSON.stringify({
    topic: t,
    domain: d,
    constraints: cs,
    expected_output: out,
    refined_questions: questions,
    suggested_scope: [
      '限定研究对象与数据来源',
      '明确对照基线',
      '定义评价指标与统计方法'
    ]
  });
}

/**
 * Build a literature comparison matrix template.
 */
async function research_literature_matrix(topic, papers = [], dimensions = []) {
  const t = String(topic || '').trim();
  if (!t) return '请提供 topic。';

  const ps = toArray(papers);
  const dims = toArray(dimensions).length
    ? toArray(dimensions)
    : ['问题定义', '方法', '数据集', '评价指标', '主要结论', '局限性'];

  const rows = (ps.length ? ps : ['Paper A', 'Paper B', 'Paper C']).map((p) => {
    const item = { paper: p };
    for (const d of dims) {
      item[d] = '待填写';
    }
    return item;
  });

  return JSON.stringify({
    topic: t,
    dimensions: dims,
    matrix: rows,
    synthesis_prompts: [
      '哪些工作在同一指标上表现最好？',
      '不同方法的适用前提有何差异？',
      '目前研究空白在哪里？'
    ]
  });
}

/**
 * Generate a practical experiment plan for research execution.
 */
async function research_experiment_plan(hypothesis, variables = [], datasets = [], timeline_days = 14) {
  const h = String(hypothesis || '').trim();
  if (!h) return '请提供 hypothesis。';

  const vars = toArray(variables);
  const ds = toArray(datasets);
  const days = Math.max(3, Math.min(180, Number(timeline_days) || 14));

  const milestones = [
    { day: 1, task: '确定实验目标、指标、对照组' },
    { day: Math.max(2, Math.round(days * 0.25)), task: '完成数据准备与清洗流程' },
    { day: Math.max(3, Math.round(days * 0.5)), task: '执行核心实验并记录日志' },
    { day: Math.max(4, Math.round(days * 0.75)), task: '消融实验与误差分析' },
    { day: days, task: '汇总结论、图表与复现实验脚本' }
  ];

  return JSON.stringify({
    hypothesis: h,
    variables: vars,
    datasets: ds,
    timeline_days: days,
    protocol: {
      controls: ['固定随机种子', '统一评测脚本', '记录环境版本'],
      metrics: ['主指标', '效率指标', '稳健性指标']
    },
    milestones,
    risks: [
      '数据泄漏风险',
      '样本分布偏移',
      '重复实验结果波动'
    ]
  });
}

/**
 * Create a full paper/report outline.
 */
async function research_paper_outline(title, contribution_points = [], target_venue = '', language = 'zh') {
  const ttl = String(title || '').trim();
  if (!ttl) return '请提供 title。';

  const cps = toArray(contribution_points);
  const venue = String(target_venue || '').trim() || '通用学术会议/期刊';
  const lang = String(language || 'zh').trim();

  const sections = [
    { id: 1, section: '摘要', bullets: ['研究背景', '方法概述', '关键结果', '结论与意义'] },
    { id: 2, section: '引言', bullets: ['问题定义', '研究动机', '主要贡献', '文章结构'] },
    { id: 3, section: '相关工作', bullets: ['方法谱系', '差异分析', '研究空白'] },
    { id: 4, section: '方法', bullets: ['符号定义', '模型/算法流程', '复杂度分析'] },
    { id: 5, section: '实验', bullets: ['数据与设置', '对比基线', '主结果', '消融与可视化'] },
    { id: 6, section: '讨论', bullets: ['适用边界', '失败案例', '伦理与风险'] },
    { id: 7, section: '结论', bullets: ['总结', '局限', '未来工作'] }
  ];

  return JSON.stringify({
    title: ttl,
    target_venue: venue,
    language: lang,
    contributions: cps,
    outline: sections
  });
}

/**
 * Build a review checklist before submission.
 */
async function research_peer_review_checklist(manuscript_type = 'paper', strictness = 'normal') {
  const mtype = String(manuscript_type || 'paper').trim();
  const s = normalizePriority(strictness);

  const checklist = [
    '研究问题是否清晰且可验证',
    '实验设置是否可复现（代码/参数/版本）',
    '统计方法是否合理并报告显著性',
    '与 SOTA/强基线是否充分对比',
    '图表标题、坐标轴、单位是否完整',
    '是否披露局限性与潜在偏差',
    '相关工作引用是否全面且最新',
    '结论是否与证据一致不过度外推'
  ];

  return JSON.stringify({
    manuscript_type: mtype,
    strictness: s,
    checklist,
    decision_rules: [
      '高优先级问题未通过前不建议投稿',
      '中优先级问题建议在提交前修复',
      '低优先级问题可作为后续改进项'
    ]
  });
}

/**
 * Create an actionable syllabus/learning roadmap.
 */
async function study_syllabus_plan(subject, level = 'beginner', weeks = 8, weekly_hours = 6) {
  const sub = String(subject || '').trim();
  if (!sub) return '请提供 subject。';

  const lvl = String(level || 'beginner').trim();
  const w = Math.max(1, Math.min(52, Number(weeks) || 8));
  const h = Math.max(1, Math.min(40, Number(weekly_hours) || 6));

  const plan = [];
  for (let i = 1; i <= w; i++) {
    plan.push({
      week: i,
      theme: `${sub} - 模块 ${i}`,
      hours: h,
      goals: ['理解核心概念', '完成练习题', '总结错题与盲点'],
      deliverable: `第 ${i} 周学习小结`
    });
  }

  return JSON.stringify({
    subject: sub,
    level: lvl,
    weeks: w,
    weekly_hours: h,
    roadmap: plan
  });
}

/**
 * Generate active-recall quiz items with explanations.
 */
async function study_active_recall_quiz(topic, points = [], count = 5, difficulty = 'normal') {
  const t = String(topic || '').trim();
  if (!t) return '请提供 topic。';

  const ps = toArray(points);
  const n = Math.max(3, Math.min(30, Number(count) || 5));
  const diff = normalizePriority(difficulty);

  const questions = [];
  for (let i = 0; i < n; i++) {
    const p = ps.length ? ps[i % ps.length] : `${t} 核心知识点 ${i + 1}`;
    questions.push({
      id: i + 1,
      question: `请解释：${p}，并给出一个应用场景。`,
      answer_key: `${p} 的定义 + 关键机制 + 应用示例`,
      difficulty: diff
    });
  }

  return JSON.stringify({
    topic: t,
    difficulty: diff,
    total: n,
    questions
  });
}

/**
 * Build exam revision sprint plan.
 */
async function study_exam_revision_plan(exam_name, days_left = 14, subjects = [], daily_hours = 4) {
  const exam = String(exam_name || '').trim();
  if (!exam) return '请提供 exam_name。';

  const ds = Math.max(1, Math.min(180, Number(days_left) || 14));
  const subs = toArray(subjects);
  const h = Math.max(1, Math.min(16, Number(daily_hours) || 4));

  const schedule = [];
  for (let d = 1; d <= ds; d++) {
    const sub = subs.length ? subs[(d - 1) % subs.length] : `科目${((d - 1) % 3) + 1}`;
    schedule.push({
      day: d,
      subject: sub,
      hours: h,
      blocks: [
        '知识点回顾 40%',
        '真题/练习 40%',
        '错题复盘 20%'
      ]
    });
  }

  return JSON.stringify({
    exam_name: exam,
    days_left: ds,
    daily_hours: h,
    schedule,
    tips: [
      '每 3 天做一次小测',
      '错题优先级高于新题',
      '最后 2 天以回顾框架为主'
    ]
  });
}

/**
 * Structure a paper abstract into IMRaD-like fields.
 */
async function research_abstract_structurer(raw_abstract, max_sentences = 6) {
  const text = String(raw_abstract || '').trim();
  if (!text) return '请提供 raw_abstract。';

  const n = Math.max(3, Math.min(12, Number(max_sentences) || 6));
  const sents = text.split(/(?<=[。！？!?\.])\s*/).filter(Boolean);

  return JSON.stringify({
    max_sentences: n,
    background: sents[0] || '待补充研究背景',
    method: sents[1] || '待补充方法',
    results: sents[2] || '待补充关键结果',
    conclusion: sents[3] || '待补充结论',
    checklist: ['是否有量化结果', '是否说明场景边界', '是否避免过度结论']
  });
}

/**
 * Build intro paragraph blocks from problem-gap-contribution.
 */
async function research_intro_paragraph_builder(problem, gap = '', contributions = [], tone = 'formal') {
  const p = String(problem || '').trim();
  if (!p) return '请提供 problem。';

  const g = String(gap || '').trim() || '现有研究在关键场景仍存在不足';
  const cs = toArray(contributions);

  return JSON.stringify({
    tone: String(tone || 'formal').trim(),
    paragraphs: [
      { part: '背景与重要性', draft: `围绕“${p}”的问题，现有工作已取得进展，但仍有提升空间。` },
      { part: '研究缺口', draft: g },
      { part: '本文贡献', draft: cs.length ? cs.map((x, i) => `${i + 1}) ${x}`).join('；') : '待补充贡献点' }
    ]
  });
}

/**
 * Interpret experiment results with highlights and cautions.
 */
async function research_result_interpreter(metrics = [], baselines = [], observations = '') {
  const ms = toArray(metrics);
  const bs = toArray(baselines);
  const obs = String(observations || '').trim();
  if (!ms.length && !obs) return '请至少提供 metrics 或 observations。';

  const highlights = ms.length
    ? ms.map((m, i) => `指标${i + 1}：${m}，建议与基线做显著性检验`).slice(0, 8)
    : ['建议补充结构化指标后再解读'];

  return JSON.stringify({
    highlights,
    baselines: bs,
    interpretation_template: [
      '先描述现象，再解释原因',
      '给出与基线的绝对/相对提升',
      '报告方差与显著性',
      '明确失败案例与边界条件'
    ],
    notes: obs || '暂无额外观察描述'
  });
}

/**
 * Diagnose mistakes and generate targeted drill plan.
 */
async function study_mistake_diagnosis(subject, mistakes = [], days = 7) {
  const sub = String(subject || '').trim();
  if (!sub) return '请提供 subject。';

  const ms = toArray(mistakes);
  const d = Math.max(1, Math.min(60, Number(days) || 7));
  const tags = [
    { name: '概念不清', rule: /概念|定义|原理/ },
    { name: '计算失误', rule: /计算|粗心|符号/ },
    { name: '审题偏差', rule: /审题|题意|条件/ },
    { name: '步骤遗漏', rule: /步骤|过程|推导/ }
  ];

  const buckets = {};
  for (const t of tags) buckets[t.name] = [];
  for (const m of ms) {
    let hit = false;
    for (const t of tags) {
      if (t.rule.test(m)) {
        buckets[t.name].push(m);
        hit = true;
        break;
      }
    }
    if (!hit) buckets['概念不清'].push(m);
  }

  return JSON.stringify({
    subject: sub,
    days: d,
    category_counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
    action_plan: [
      '优先修复高频错误类型',
      '每次练习后记录错因和改法',
      '隔天进行一次错题回放测试'
    ]
  });
}

/**
 * Generate a spaced-repetition schedule for study items.
 */
async function study_spaced_repetition_plan(items = [], days = 14, intensity = 'normal') {
  const arr = toArray(items);
  if (!arr.length) return '请提供 items。';

  const d = Math.max(3, Math.min(120, Number(days) || 14));
  const inty = normalizePriority(intensity);
  const gaps = inty === 'high' ? [1, 2, 4, 7, 10] : inty === 'low' ? [2, 4, 7, 12] : [1, 3, 6, 10];

  const schedule = arr.slice(0, 100).map((item) => ({
    item,
    reviews: gaps.filter((g) => g <= d).map((g) => ({ day_offset: g, action: '回忆+自测' }))
  }));

  return JSON.stringify({
    days: d,
    intensity: inty,
    schedule
  });
}
