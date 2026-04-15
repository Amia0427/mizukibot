// ========================= [可复制粘贴开始] api/tools_batch2.js =========================
/**
 * 第二批工具（Batch 2）
 * - 不依赖新三方包
 * - 返回字符串或 JSON.stringify 结果，兼容你现有 tool 回传链路
 */

const { URL } = require('url');

/**
 * 工具1：URL 风险检查（轻量规则）
 */
async function url_safety_check(url) {
  const raw = String(url || '').trim();
  if (!raw) return '请提供要检测的链接。';

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    return JSON.stringify({
      ok: false,
      risk_level: 'high',
      reasons: ['URL 格式不合法'],
      suggestions: ['确认链接是否完整（包含 http/https）']
    });
  }

  const reasons = [];
  let score = 0;

  // 1) 协议检查
  if (parsed.protocol !== 'https:') {
    score += 2;
    reasons.push('链接不是 HTTPS，存在被中间人篡改风险');
  }

  // 2) 短链/可疑域名特征
  const host = parsed.hostname.toLowerCase();
  const suspiciousHosts = ['bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'ow.ly'];
  if (suspiciousHosts.includes(host)) {
    score += 2;
    reasons.push('短链域名，真实跳转目标不透明');
  }

  // 3) 文件后缀风险
  const path = parsed.pathname.toLowerCase();
  const riskyExt = ['.exe', '.msi', '.bat', '.cmd', '.scr', '.ps1', '.apk', '.ipa', '.js'];
  if (riskyExt.some(ext => path.endsWith(ext))) {
    score += 3;
    reasons.push('下载文件后缀存在执行风险');
  }

  // 4) 钓鱼关键词（粗略）
  const full = `${host}${parsed.pathname}${parsed.search}`.toLowerCase();
  const phishingWords = ['login', 'verify', 'security', 'bank', 'wallet', 'password', '验证码', '登录'];
  const hit = phishingWords.filter(w => full.includes(w));
  if (hit.length >= 2) {
    score += 2;
    reasons.push(`疑似账号诱导关键词较多：${hit.slice(0, 4).join(', ')}`);
  }

  // 5) IP直连域名（无域名信誉）
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    score += 2;
    reasons.push('使用 IP 直连而非域名，可信度偏低');
  }

  let risk_level = 'low';
  if (score >= 5) risk_level = 'high';
  else if (score >= 3) risk_level = 'medium';

  return JSON.stringify({
    ok: true,
    url: raw,
    host,
    risk_level,
    score,
    reasons: reasons.length ? reasons : ['未发现明显风险特征'],
    suggestions: [
      '不要在陌生页面输入账号密码/验证码',
      '下载文件前先杀毒扫描',
      '涉及转账操作请二次确认官方域名'
    ]
  });
}

/**
 * 工具2：JSON 校验与修复建议
 * - 支持简单“去代码块”与“单引号转双引号”的尝试
 */
async function json_validate(text) {
  let raw = String(text || '').trim();
  if (!raw) return '请提供 JSON 文本。';

  // 去 markdown 包裹
  raw = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  // 直接解析
  try {
    const obj = JSON.parse(raw);
    return JSON.stringify({
      valid: true,
      repaired: false,
      type: Array.isArray(obj) ? 'array' : typeof obj,
      keys: obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.keys(obj) : [],
      message: 'JSON 合法'
    });
  } catch (e1) {
    // 简单修复策略：单引号 -> 双引号、去末尾逗号
    const repaired = raw
      .replace(/'/g, '"')
      .replace(/,\s*([}\]])/g, '\$1');

    try {
      const obj2 = JSON.parse(repaired);
      return JSON.stringify({
        valid: true,
        repaired: true,
        type: Array.isArray(obj2) ? 'array' : typeof obj2,
        keys: obj2 && typeof obj2 === 'object' && !Array.isArray(obj2) ? Object.keys(obj2) : [],
        message: '原始 JSON 非法，但已自动修复',
        repaired_preview: repaired.slice(0, 500)
      });
    } catch (e2) {
      return JSON.stringify({
        valid: false,
        repaired: false,
        error: e1.message,
        suggestions: [
          '检查键名和字符串是否使用双引号',
          '删除对象/数组末尾多余逗号',
          '确认括号 {} [] 配对完整'
        ],
        raw_preview: raw.slice(0, 500)
      });
    }
  }
}

/**
 * 工具3：学习卡片生成（Q/A）
 */
async function study_card_generator(topic, points = '', count = 5) {
  const t = String(topic || '').trim();
  if (!t) return '请提供学习主题 topic。';

  const n = Math.max(1, Math.min(20, Number(count) || 5));
  const pts = String(points || '')
    .split(/[；;。.\n、,，]/)
    .map(s => s.trim())
    .filter(Boolean);

  const seed = pts.length ? pts : [
    `${t} 的定义`,
    `${t} 的关键特征`,
    `${t} 的常见误区`,
    `${t} 的应用场景`,
    `${t} 的复习重点`
  ];

  const cards = [];
  for (let i = 0; i < n; i++) {
    const p = seed[i % seed.length];
    cards.push({
      id: i + 1,
      question: `【${t}】请解释：${p}`,
      answer: `可从“概念-机制-例子-易错点”四步作答：先定义，再说明原理，给1个例子，最后补充常见误区。`,
      tags: [t, 'study', 'qa-card']
    });
  }

  return JSON.stringify({
    topic: t,
    total: cards.length,
    cards
  });
}

/**
 * 工具4：会议纪要结构化
 */
async function meeting_minutes_struct(text) {
  const raw = String(text || '').trim();
  if (!raw) return '请提供会议记录文本。';

  // 按行切分
  const lines = raw.split('\n').map(s => s.trim()).filter(Boolean);

  // 轻量规则提取
  const actionKeywords = ['负责', '跟进', '完成', '提交', '截止', '下周', '明天', '今天', '安排'];
  const riskKeywords = ['风险', '阻塞', '延期', '冲突', '不足', '问题'];
  const decisionKeywords = ['决定', '确认', '通过', '采用', '结论'];

  const actions = [];
  const risks = [];
  const decisions = [];

  for (const line of lines) {
    if (actionKeywords.some(k => line.includes(k))) actions.push(line);
    if (riskKeywords.some(k => line.includes(k))) risks.push(line);
    if (decisionKeywords.some(k => line.includes(k))) decisions.push(line);
  }

  const summary = lines.slice(0, 4).join('；').slice(0, 200);

  return JSON.stringify({
    summary: summary || '无明显摘要',
    decisions: decisions.slice(0, 8),
    action_items: actions.slice(0, 12).map((item, i) => ({
      id: i + 1,
      item,
      owner: '待指派',
      deadline: '待确认'
    })),
    risks: risks.slice(0, 8),
    next_steps: [
      '确认 action owner 与 deadline',
      '把阻塞项升级到负责人',
      '下次会议回顾完成率'
    ]
  });
}

module.exports = {
  url_safety_check,
  json_validate,
  study_card_generator,
  meeting_minutes_struct
};
// ========================= [可复制粘贴结束] api/tools_batch2.js =========================
