const {
  isConversationRecapQuery,
  isRecentPersonalActivityRecallQuery
} = require('../recallHeuristics');
const {
  isExplicitRememberText
} = require('./learningIntent');

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function isAdditionalConversationRecapText(text = '') {
  const value = normalizeText(text).toLowerCase();
  if (!value) return false;
  if (/(今天|今日).{0,8}(天气|气温|下雨|温度|股价|股票|行情|新闻|日期|星期|几点)/i.test(value)) {
    return false;
  }
  return /(?:总结|回顾|复述|说一下|讲一下|讲讲|说说).{0,16}(?:昨天|前天|最近|这几天|这两天|今天|今日|刚才|刚刚).{0,18}(?:聊|说|讲|提|对话|聊天|发生|干了|做了|发了|玩了|打了)/i.test(value)
    || /(?:昨天|前天|最近|这几天|这两天|今天|今日|刚才|刚刚).{0,18}(?:我|我们|咱|俺|和你).{0,16}(?:聊|说|讲|提|对话|聊天).{0,12}(?:什么|啥|哪些|总结|回顾|说一下|讲一下|说说)/i.test(value);
}

function isPostReplyRecapText(text = '') {
  const value = normalizeText(text);
  if (!value) return false;
  if (isExplicitRememberText(value)) return false;
  if (/(聊到哪|做到哪|进行到哪|进展到哪|where did we leave off|pick back up|resume)/i.test(value)) {
    return false;
  }
  return isConversationRecapQuery(value)
    || isRecentPersonalActivityRecallQuery(value)
    || isAdditionalConversationRecapText(value);
}

function isPostReplyRecapTurn(turn = {}, fallback = {}) {
  const item = normalizeObject(turn, {});
  const evidence = normalizeObject(item.evidence, {});
  const question = normalizeText(item.question || evidence.userText || fallback.question);
  if (!question) return false;
  return isPostReplyRecapText(question);
}

function filterPostReplyRecapTurns(turns = []) {
  const keptTurns = [];
  const skippedTurns = [];
  for (const turn of normalizeArray(turns)) {
    if (isPostReplyRecapTurn(turn)) {
      skippedTurns.push(turn);
    } else {
      keptTurns.push(turn);
    }
  }
  return {
    turns: keptTurns,
    skippedTurns,
    skippedCount: skippedTurns.length
  };
}

function isPostReplyRecapJob(job = {}) {
  const turns = normalizeArray(job.turns);
  if (turns.length > 0) {
    const latest = turns[turns.length - 1];
    return isPostReplyRecapTurn(latest, job);
  }
  return isPostReplyRecapText(job.question);
}

function buildPostReplyJobWithoutRecapTurns(job = {}) {
  const turns = normalizeArray(job.turns);
  if (isPostReplyRecapJob(job)) {
    const filtered = filterPostReplyRecapTurns(turns);
    return {
      job: null,
      skippedCount: Math.max(1, filtered.skippedCount || 0),
      skippedTurns: filtered.skippedTurns.length > 0 ? filtered.skippedTurns : [job]
    };
  }
  if (turns.length === 0) {
    return {
      job,
      skippedCount: 0,
      skippedTurns: []
    };
  }
  const filtered = filterPostReplyRecapTurns(turns);
  if (filtered.skippedCount === 0) {
    return {
      job,
      skippedCount: 0,
      skippedTurns: []
    };
  }
  if (filtered.turns.length === 0) {
    return {
      job: null,
      skippedCount: filtered.skippedCount,
      skippedTurns: filtered.skippedTurns
    };
  }
  const latest = filtered.turns[filtered.turns.length - 1] || {};
  return {
    job: {
      ...job,
      turns: filtered.turns,
      question: latest.question || job.question,
      finalReply: latest.finalReply || job.finalReply
    },
    skippedCount: filtered.skippedCount,
    skippedTurns: filtered.skippedTurns
  };
}

module.exports = {
  buildPostReplyJobWithoutRecapTurns,
  filterPostReplyRecapTurns,
  isPostReplyRecapJob,
  isPostReplyRecapText,
  isPostReplyRecapTurn
};
