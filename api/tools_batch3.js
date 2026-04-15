// ========================= [可复制粘贴开始] api/tools_batch3.js =========================
/**
 * 第三批工具（Batch 3）
 * 特点：无额外依赖，稳定可用
 */

/**
 * 工具1：从自然语言提取待办
 */
async function extract_todo_from_text(text) {
    const raw = String(text || '').trim();
    if (!raw) return '请提供文本内容。';
  
    const lines = raw.split(/[\n。；;]+/).map(s => s.trim()).filter(Boolean);
  
    const todoKeywords = ['要', '需要', '记得', '安排', '完成', '提交', '复习', '准备', '买', '联系', '跟进'];
    const todos = [];
  
    for (const line of lines) {
      if (todoKeywords.some(k => line.includes(k))) {
        todos.push({
          task: line,
          priority: /尽快|马上|urgent|紧急/.test(line) ? 'high' : 'normal',
          deadline_hint: (line.match(/今天|明天|后天|下周|月底|周[一二三四五六日天]/g) || []).join('、') || '未提及'
        });
      }
    }
  
    if (!todos.length) {
      return JSON.stringify({
        ok: true,
        message: '未提取到明显待办项，可尝试更明确的动词表达。',
        todos: []
      });
    }
  
    return JSON.stringify({
      ok: true,
      total: todos.length,
      todos
    });
  }
  
  /**
   * 工具2：番茄钟学习计划
   */
  async function pomodoro_plan(goal, total_minutes = 120, focus_minutes = 25, break_minutes = 5) {
    const g = String(goal || '').trim();
    if (!g) return '请提供学习目标 goal。';
  
    const total = Math.max(25, Math.min(600, Number(total_minutes) || 120));
    const focus = Math.max(15, Math.min(90, Number(focus_minutes) || 25));
    const brk = Math.max(3, Math.min(30, Number(break_minutes) || 5));
  
    const cycles = Math.max(1, Math.floor(total / (focus + brk)));
    const plan = [];
    let minuteCursor = 0;
  
    for (let i = 1; i <= cycles; i++) {
      plan.push({
        step: plan.length + 1,
        type: 'focus',
        name: `专注第${i}轮`,
        duration_min: focus,
        minute_range: `${minuteCursor}-${minuteCursor + focus}`,
        task: `${g}（第${i}轮）`
      });
      minuteCursor += focus;
  
      if (i < cycles) {
        const thisBreak = (i % 4 === 0) ? Math.min(brk + 10, 20) : brk; // 每4轮长休
        plan.push({
          step: plan.length + 1,
          type: 'break',
          name: i % 4 === 0 ? '长休' : '短休',
          duration_min: thisBreak,
          minute_range: `${minuteCursor}-${minuteCursor + thisBreak}`,
          task: '起身活动、喝水、放松眼睛'
        });
        minuteCursor += thisBreak;
      }
    }
  
    return JSON.stringify({
      goal: g,
      total_minutes: total,
      focus_minutes: focus,
      break_minutes: brk,
      cycles,
      plan
    });
  }
  
  /**
   * 工具3：正则测试器
   */
  async function regex_tester(pattern, text, flags = 'g') {
    const p = String(pattern || '');
    const t = String(text || '');
    const f = String(flags || '').replace(/[^gimsuy]/g, '');
  
    if (!p) return '请提供正则 pattern。';
  
    let reg;
    try {
      reg = new RegExp(p, f);
    } catch (e) {
      return JSON.stringify({
        ok: false,
        error: `正则编译失败：${e.message}`
      });
    }
  
    const matches = [];
    let m;
    if (f.includes('g')) {
      while ((m = reg.exec(t)) !== null) {
        matches.push({
          match: m[0],
          index: m.index,
          groups: m.slice(1)
        });
        if (m[0] === '') reg.lastIndex++; // 防止空匹配死循环
        if (matches.length >= 50) break;
      }
    } else {
      m = reg.exec(t);
      if (m) {
        matches.push({
          match: m[0],
          index: m.index,
          groups: m.slice(1)
        });
      }
    }
  
    return JSON.stringify({
      ok: true,
      pattern: p,
      flags: f,
      total: matches.length,
      matches
    });
  }
  
  /**
   * 工具4：文本统计
   */
  async function text_stats(text, top_n = 8) {
    const raw = String(text || '');
    if (!raw.trim()) return '请提供文本。';
  
    const chars = raw.length;
    const charsNoSpace = raw.replace(/\s/g, '').length;
    const lines = raw.split('\n').length;
    const sentences = (raw.match(/[。！？!?\.]+/g) || []).length || 1;
  
    // 轻量分词（中文按字串，英文按单词）
    const words = raw
      .toLowerCase()
      .replace(/[^\u4e00-\u9fa5a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  
    const stop = new Set(['的', '了', '和', '是', '我', '你', '他', '她', '它', '在', '就', '都', '而', '及', '与', 'the', 'a', 'an', 'to', 'of', 'in', 'on']);
    const freq = new Map();
    for (const w of words) {
      if (stop.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  
    const top = Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, Math.min(30, Number(top_n) || 8)))
      .map(([word, count]) => ({ word, count }));
  
    return JSON.stringify({
      chars,
      chars_no_space: charsNoSpace,
      lines,
      sentences,
      keywords_top: top
    });
  }
  
  /**
   * 工具5：安全数学表达式计算（不使用 eval）
   * 支持 + - * / () 和小数
   */
  async function safe_eval_math(expression) {
    const expr = String(expression || '').trim();
    if (!expr) return '请提供数学表达式。';
  
    // 仅允许数字、运算符、空格、小数点、括号
    if (!/^[\d+\-*/().\s]+$/.test(expr)) {
      return '表达式包含不支持字符。仅支持数字 + - * / () .';
    }
  
    try {
      const result = calculateExpression(expr);
      if (!Number.isFinite(result)) return '计算结果无效（可能除以0）。';
      return JSON.stringify({ expression: expr, result });
    } catch (e) {
      return `计算失败：${e.message}`;
    }
  }
  
  // ---- 简单表达式解析器（Shunting-yard）----
  function calculateExpression(input) {
    const tokens = tokenize(input);
    const output = [];
    const ops = [];
    const prec = { '+': 1, '-': 1, '*': 2, '/': 2 };
  
    for (const tk of tokens) {
      if (typeof tk === 'number') {
        output.push(tk);
      } else if (['+', '-', '*', '/'].includes(tk)) {
        while (ops.length) {
          const top = ops[ops.length - 1];
          if (['+', '-', '*', '/'].includes(top) && prec[top] >= prec[tk]) {
            output.push(ops.pop());
          } else break;
        }
        ops.push(tk);
      } else if (tk === '(') {
        ops.push(tk);
      } else if (tk === ')') {
        while (ops.length && ops[ops.length - 1] !== '(') output.push(ops.pop());
        if (!ops.length) throw new Error('括号不匹配');
        ops.pop();
      }
    }
  
    while (ops.length) {
      const op = ops.pop();
      if (op === '(' || op === ')') throw new Error('括号不匹配');
      output.push(op);
    }
  
    const st = [];
    for (const item of output) {
      if (typeof item === 'number') {
        st.push(item);
      } else {
        const b = st.pop();
        const a = st.pop();
        if (a === undefined || b === undefined) throw new Error('表达式不完整');
        if (item === '+') st.push(a + b);
        else if (item === '-') st.push(a - b);
        else if (item === '*') st.push(a * b);
        else if (item === '/') st.push(a / b);
      }
    }
  
    if (st.length !== 1) throw new Error('表达式解析失败');
    return st[0];
  }
  
  function tokenize(s) {
    const tokens = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) {
        i++;
        continue;
      }
  
      // 处理负号：如果在开头或在 ( 或运算符 后，视为数字符号
      if (c === '-' && (
        tokens.length === 0 ||
        tokens[tokens.length - 1] === '(' ||
        ['+', '-', '*', '/'].includes(tokens[tokens.length - 1])
      )) {
        let j = i + 1;
        let num = '-';
        while (j < s.length && /[\d.]/.test(s[j])) {
          num += s[j];
          j++;
        }
        if (num === '-') throw new Error('负号后缺少数字');
        const n = Number(num);
        if (!Number.isFinite(n)) throw new Error('数字格式错误');
        tokens.push(n);
        i = j;
        continue;
      }
  
      if (/[\d.]/.test(c)) {
        let j = i;
        let num = '';
        while (j < s.length && /[\d.]/.test(s[j])) {
          num += s[j];
          j++;
        }
        const n = Number(num);
        if (!Number.isFinite(n)) throw new Error('数字格式错误');
        tokens.push(n);
        i = j;
        continue;
      }
  
      if (['+', '-', '*', '/', '(', ')'].includes(c)) {
        tokens.push(c);
        i++;
        continue;
      }
  
      throw new Error(`非法字符: ${c}`);
    }
    return tokens;
  }
  
  module.exports = {
    extract_todo_from_text,
    pomodoro_plan,
    regex_tester,
    text_stats,
    safe_eval_math
  };
  // ========================= [可复制粘贴结束] api/tools_batch3.js =========================
  