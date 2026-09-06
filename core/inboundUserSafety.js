const {
  cheapParseMessageEntry,
  resolveContinuousEntryDetails
} = require('./continuousMessagePreprocessor');
const { containsBotCue } = require('./messageDirectedContext');
const {
  detectExplicitBadFaithRequest,
  detectExplicitHarmfulRequest
} = require('./router/safety');
const { checkGroupReplySensitiveText } = require('../utils/groupReplySensitiveGuard');

const AUTOMATIC_BLOCK_DURATION_MS = 15 * 60 * 1000;
const AUTOMATIC_BLOCK_NOTICE = '您已被瑞希临时封禁，请十五分钟后再来';
const AUTOMATIC_BLOCK_SOURCE = 'automatic_safety';
const MAX_WINDOW_MESSAGES = 5;
const MAX_TRACKED_USERS = 10_000;
const STATE_PRUNE_INTERVAL_MS = 60 * 1000;

const VIOLENT_ACTION_PATTERN = /(杀(?:了|掉)?|打死|砍死|捅死|炸死|枪杀|勒死|掐死|弄死|宰了|灭口|毁容|伤害|殴打|暴打|痛打|kill|murder|stab|shoot|strangle|hurt|beat)/i;
const VIOLENT_INTENT_PATTERN = /(?:我要|我会|我准备|我打算|我计划|我马上|我现在(?:就|要)|我迟早|我就要|我一定要|我就|我想(?:马上|现在|直接|要)?|我.{0,12}(?:后|完)(?:就|要|会|准备|打算|计划|想)|找人|叫人|让人|教唆|怂恿|威胁|有种|敢.{0,8}就|再.{0,8}就|不然|否则|去|给我|i(?:'m| am)? going to|i will|i want to|threaten).{0,12}(?:杀(?:了|掉)?|打死|砍死|捅死|炸死|枪杀|勒死|掐死|弄死|宰了|灭口|毁容|伤害|殴打|暴打|痛打|kill|murder|stab|shoot|strangle|hurt|beat)/i;
const REAL_TARGET_PATTERN = /(你们?|瑞希|毛毛|机器人|bot|他(?:们)?|她(?:们)?|那个人|某人|别人|群友|管理员|用户|老师|同学|同事|前任|女友|男友|人家|someone|somebody|him|her|them|you|the bot)/i;
const BOT_TARGET_PATTERN = /(你们?|瑞希|毛毛|机器人|bot|you|the bot)/i;
const DIRECT_VIOLENT_PATTERNS = Object.freeze([
  /(?:杀(?:了|掉)?|打死|砍死|捅死|炸死|枪杀|勒死|掐死|弄死|宰了|灭口|毁容|伤害|殴打|暴打|痛打).{0,8}(?:你们?|瑞希|毛毛|机器人|他(?:们)?|她(?:们)?|那个人|某人|别人|群友|管理员|用户|老师|同学|同事|前任|女友|男友)/i,
  /(?:kill|murder|stab|shoot|strangle|hurt|beat).{0,12}(?:you|him|her|them|someone|somebody|the bot)/i,
  /(?:你们?|瑞希|毛毛|机器人|他(?:们)?|她(?:们)?|那个人|某人|别人|群友|管理员|用户|老师|同学|同事|前任|女友|男友).{0,12}(?:杀(?:了|掉)?|打死|砍死|捅死|炸死|枪杀|勒死|掐死|弄死|宰了|灭口|毁容|伤害|殴打|暴打|痛打)/i,
  /(?:you|him|her|them|someone|somebody|the bot).{0,16}(?:kill|murder|stab|shoot|strangle|hurt|beat)/i
]);

const NEGATED_ACTION_PREFIX_PATTERN = /(?:(?:不想|不愿|不会|不能|不打算|不要|别|勿|请勿|请不要|不是要|并非要|未曾)[^。！？!?；;，,]{0,8}|(?:没有|没)\s*)$/i;
const PREVENTIVE_ACTION_PREFIX_PATTERN = /(?:禁止|制止|阻止|避免|防止|拒绝|停止|停下|劝阻|举报|报告|报警|投诉)[^。！？!?；;，,]{0,12}$/i;
const REPORTED_ACTION_PREFIX_PATTERN = /(?:引用|转发|转述|据说|(?:有人|他|她)说(?!完)(?:过|道|称)?|原文|内容是|翻译|news|report|quote|quoted|reported)[^。！？!?；;，,]{0,16}$/i;
const SEQUENCE_BOUNDARY_PATTERN = /(?:结束(?:后|了)|之后|然后|接着|随后)/gi;
const SEXUAL_EXEMPT_PATTERN = /(科普|知识|解释|为什么|定义|医学|生理|教育|研究|讨论|新闻|报道|小说|故事|剧情|创作|角色扮演|虚构|台词|翻译|science|education|medical|explain|research|news|novel|story|roleplay|fiction|translate)/i;
const SEXUAL_EXPLICIT_PATTERN = /(强奸|轮奸|性交|做爱|口交|肛交|自慰|裸照|裸体|脱光|性器官|阴茎|阴道|乳房|摸.{0,8}(?:胸|屁股)|舔(?:胸|阴|脚)|操你|草你|干你|睡你|上你|rape|sex|blowjob|nudes?|naked|penis|vagina|breasts?|masturbat)/i;
const SEXUAL_DIRECTION_PATTERN = /(我要|我想|让我|给我|发给我|看看|看一下|脱光|脱衣|露出|摸|亲|舔|操|草|干|睡|上|强奸|口交|肛交|send me|show me|i want|let me|touch|kiss|lick|rape|fuck)/i;
const SEXUAL_PERSONAL_DIRECTION_PATTERN = /(?:我要|我想|让我|给我|发给我|看看|看一下|脱光|脱衣|露出|摸|亲|舔|操|草|干|睡|上|send me|show me|i want|let me|touch|kiss|lick|fuck)/i;
const SEXUAL_DIRECTED_PATTERNS = Object.freeze([
  /(?:强奸|轮奸|性交|做爱|口交|肛交|自慰|摸|舔|操|草|干|睡|上|rape|sex|blowjob|masturbat).{0,12}(?:你们?|瑞希|毛毛|机器人|bot|他(?:们)?|她(?:们)?|那个人|某人|别人|群友|管理员|用户|someone|somebody|him|her|them|you|the bot)/i,
  /(?:你们?|瑞希|毛毛|机器人|bot|他(?:们)?|她(?:们)?|那个人|某人|别人|群友|管理员|用户|someone|somebody|him|her|them|you|the bot).{0,12}(?:强奸|轮奸|性交|做爱|口交|肛交|自慰|裸照|裸体|脱光|性器官|阴茎|阴道|乳房|摸|舔|操|草|干|睡|上|rape|sex|blowjob|nudes?|naked|penis|vagina|breasts?|masturbat)/i
]);

const ABUSE_TERM = '(?:傻逼|煞笔|智障|废物|垃圾(?!(?:(?:的|相关的?|有关的?|方面的?)\\s*)?(?:分类|回收|处理|桶|站|车|邮件|短信|内容|数据|文件|箱|袋|场|焚烧|填埋|清运))|白痴|蠢货|笨蛋|脑残|神经病|弱智|狗东西|畜生|滚蛋|闭嘴|去死|恶心|欠揍|没用|破机器人|坏机器人)';
const TARGETED_ABUSE_PATTERNS = Object.freeze([
  new RegExp(`(?:你们?|瑞希(?:你)?|毛毛(?:你)?|机器人|bot|他(?:们)?|她(?:们)?|群友|管理员|用户)[,，:：!！?？\\s]*(?:(?:这个|就是|真是|是个|怎么这么|也太|可真是?|好|很|真|给我|他妈的?)\\s*)?${ABUSE_TERM}`, 'i'),
  /(?:傻逼|煞笔|智障|废物|白痴|蠢货|笨蛋|脑残|神经病|弱智|狗东西|畜生)[,，:：!！?？\s]*(?:你们?|瑞希|毛毛|机器人|bot)/i,
  /(?:瑞希|毛毛|你们?|机器人|bot).{0,4}(?:你算什么东西|有种你就|不服来|来打我啊)/i,
  /(?:you|the bot).{0,12}(?:idiot|moron|stupid|trash|useless|shut up|fuck off)/i
]);

function normalizeReviewText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function collectReviewTexts(entry = {}) {
  const values = [
    entry.text,
    entry.replyContext?.text,
    entry.forwardSummaryText
  ];
  const texts = [];
  const seen = new Set();
  for (const value of values) {
    const text = normalizeReviewText(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    texts.push(text);
  }
  return texts;
}

function matchesAnyText(texts, predicate) {
  return texts.some((text) => predicate(text));
}

function splitIntoShortClauses(value = '') {
  const text = normalizeReviewText(value);
  if (!text) return [];

  const clauses = [];
  let current = '';
  let closingQuote = '';
  const quotePairs = new Map([
    ['“', '”'],
    ['‘', '’'],
    ['「', '」'],
    ['『', '』'],
    ['《', '》'],
    ['"', '"']
  ]);
  const pushClause = (quoted) => {
    const clause = normalizeReviewText(current);
    if (clause) clauses.push({ text: clause, quoted });
    current = '';
  };

  for (const char of text) {
    if (!closingQuote && quotePairs.has(char)) {
      pushClause(false);
      closingQuote = quotePairs.get(char);
      current = char;
      continue;
    }
    current += char;
    if (closingQuote && char === closingQuote) {
      pushClause(true);
      closingQuote = '';
      continue;
    }
    if (!closingQuote && /[。！？!?；;，,：:\n]/.test(char)) pushClause(false);
  }
  pushClause(Boolean(closingQuote));

  return clauses.flatMap((clause) => {
    const parts = clause.text.split(SEQUENCE_BOUNDARY_PATTERN);
    return parts
      .map((textPart) => ({ text: normalizeReviewText(textPart), quoted: clause.quoted }))
      .filter((part) => part.text);
  });
}

function isPolitical(texts) {
  return matchesAnyText(texts, (text) => checkGroupReplySensitiveText(text).blocked);
}

function isMalicious(texts) {
  return matchesAnyText(texts, (text) => (
    detectExplicitHarmfulRequest(text).matched
    || detectExplicitBadFaithRequest(text).matched
  ));
}

function hasSuppressedActionContext(clause = '', actionPattern) {
  const actionMatch = actionPattern.exec(clause);
  if (!actionMatch) return false;
  const prefix = clause.slice(0, actionMatch.index);
  let relevantPrefix = prefix;
  for (const boundaryMatch of prefix.matchAll(SEQUENCE_BOUNDARY_PATTERN)) {
    relevantPrefix = prefix.slice(boundaryMatch.index + boundaryMatch[0].length);
  }
  return NEGATED_ACTION_PREFIX_PATTERN.test(relevantPrefix)
    || PREVENTIVE_ACTION_PREFIX_PATTERN.test(relevantPrefix)
    || REPORTED_ACTION_PREFIX_PATTERN.test(relevantPrefix);
}

function isDirectedViolentThreat(text = '') {
  return splitIntoShortClauses(text).some(({ text: clause, quoted }) => {
    if (!VIOLENT_ACTION_PATTERN.test(clause) || !REAL_TARGET_PATTERN.test(clause)) return false;
    if (quoted || hasSuppressedActionContext(clause, VIOLENT_ACTION_PATTERN)) return false;
    if (!VIOLENT_INTENT_PATTERN.test(clause)) return false;
    return DIRECT_VIOLENT_PATTERNS.some((pattern) => pattern.test(clause));
  });
}

function isDirectedSexualHarassment(text = '') {
  return splitIntoShortClauses(text).some(({ text: clause, quoted }) => {
    if (!SEXUAL_EXPLICIT_PATTERN.test(clause)
      || !SEXUAL_DIRECTION_PATTERN.test(clause)
      || !REAL_TARGET_PATTERN.test(clause)
      || !SEXUAL_DIRECTED_PATTERNS.some((pattern) => pattern.test(clause))) {
      return false;
    }
    if (quoted || hasSuppressedActionContext(clause, SEXUAL_EXPLICIT_PATTERN)) return false;
    return !SEXUAL_EXEMPT_PATTERN.test(clause)
      || BOT_TARGET_PATTERN.test(clause)
      || SEXUAL_PERSONAL_DIRECTION_PATTERN.test(clause);
  });
}

function isTargetedAbuse(text = '') {
  return TARGETED_ABUSE_PATTERNS.some((pattern) => pattern.test(text));
}

function createDecision({ blocked, reasonCode = '', severity = 'none', windowSize }) {
  return {
    blocked,
    reasonCode,
    severity,
    windowSize
  };
}

function createInboundUserSafetyReviewer(options = {}) {
  const windows = new Map();
  let lastPrunedAt = 0;
  const configuredMaxUsers = Number(options.maxTrackedUsers);
  const maxTrackedUsers = Number.isFinite(configuredMaxUsers)
    ? Math.max(1, Math.floor(configuredMaxUsers))
    : MAX_TRACKED_USERS;
  const parseEntry = options.cheapParseMessageEntry || cheapParseMessageEntry;
  const resolveEntryDetails = options.resolveContinuousEntryDetails || resolveContinuousEntryDetails;

  async function prepareEntry(msg, { actionClient, effectiveBotQQ } = {}) {
    const entry = parseEntry(msg, { effectiveBotQQ });
    const currentText = entry.text;
    try {
      await resolveEntryDetails(entry, {
        actionClient,
        effectiveBotQQ,
        ensureCachedImageRef: async () => ({ ok: false }),
        resolveReply: true,
        resolveForward: true,
        resolveCards: false
      });
    } catch (_) {
      entry.text = currentText;
    }
    entry.text = currentText;
    return entry;
  }

  function isBotConversation({ entry = {}, chatType = '', botQQ = '' } = {}) {
    if (String(chatType).trim().toLowerCase() === 'private') return true;
    if (entry.mentionedBot === true) return true;
    const normalizedBotQQ = String(botQQ || '').trim();
    const replySenderId = String(entry.replyContext?.senderId || '').trim();
    return Boolean(normalizedBotQQ && replySenderId === normalizedBotQQ)
      || containsBotCue(entry.text);
  }

  function pruneState(state, now) {
    state.messages = state.messages
      .filter((item) => now - item.timestamp < AUTOMATIC_BLOCK_DURATION_MS);
    for (const [messageId, timestamp] of state.seenMessageIds) {
      if (now - timestamp >= AUTOMATIC_BLOCK_DURATION_MS) state.seenMessageIds.delete(messageId);
    }
  }

  function pruneExpiredStates(now) {
    for (const [key, state] of windows) {
      pruneState(state, now);
      if (state.messages.length === 0 && state.seenMessageIds.size === 0) windows.delete(key);
    }
  }

  function maybePruneExpiredStates(now) {
    if (now - lastPrunedAt < STATE_PRUNE_INTERVAL_MS && windows.size < maxTrackedUsers) return;
    pruneExpiredStates(now);
    lastPrunedAt = now;
  }

  function createState(now) {
    return {
      messages: [],
      seenMessageIds: new Map(),
      lastSeenAt: now
    };
  }

  function getState(key, now) {
    maybePruneExpiredStates(now);
    let state = windows.get(key);
    if (state) {
      pruneState(state, now);
      return state;
    }

    if (windows.size >= maxTrackedUsers) {
      let oldestKey = '';
      let oldestTimestamp = Number.POSITIVE_INFINITY;
      for (const [candidateKey, candidateState] of windows) {
        if (candidateState.lastSeenAt < oldestTimestamp) {
          oldestKey = candidateKey;
          oldestTimestamp = candidateState.lastSeenAt;
        }
      }
      if (oldestKey) windows.delete(oldestKey);
    }
    state = createState(now);
    windows.set(key, state);
    return state;
  }

  function recordMessage({ userId, entry, now, abusive }) {
    const key = String(userId || '').trim();
    const state = getState(key, now);
    const messageId = String(entry?.messageId || '').trim();
    const duplicate = Boolean(messageId) && state.seenMessageIds.has(messageId);
    if (!duplicate) {
      if (messageId) {
        state.seenMessageIds.set(messageId, now);
      }
      state.messages.push({ messageId, timestamp: now, abusive });
    }
    state.messages = state.messages.slice(-MAX_WINDOW_MESSAGES);
    state.lastSeenAt = now;
    return state.messages;
  }

  function review({ userId, entry = {}, now = Date.now() } = {}) {
    const texts = collectReviewTexts(entry);
    const abusive = matchesAnyText(texts, isTargetedAbuse);
    const window = recordMessage({ userId, entry, now, abusive });

    if (isPolitical(texts)) {
      return createDecision({
        blocked: true,
        reasonCode: 'political',
        severity: 'high',
        windowSize: window.length
      });
    }
    if (isMalicious(texts)) {
      return createDecision({
        blocked: true,
        reasonCode: 'malicious',
        severity: 'high',
        windowSize: window.length
      });
    }
    if (matchesAnyText(texts, isDirectedViolentThreat)) {
      return createDecision({
        blocked: true,
        reasonCode: 'violent_threat',
        severity: 'high',
        windowSize: window.length
      });
    }
    if (matchesAnyText(texts, isDirectedSexualHarassment)) {
      return createDecision({
        blocked: true,
        reasonCode: 'sexual_harassment',
        severity: 'high',
        windowSize: window.length
      });
    }

    const abuseCount = window.filter((item) => item.abusive).length;
    if (abusive && abuseCount >= 2) {
      return createDecision({
        blocked: true,
        reasonCode: 'repeated_abuse',
        severity: 'medium',
        windowSize: window.length
      });
    }
    if (abusive) {
      return createDecision({
        blocked: false,
        reasonCode: 'repeated_abuse',
        severity: 'low',
        windowSize: window.length
      });
    }
    return createDecision({
      blocked: false,
      windowSize: window.length
    });
  }

  function reset() {
    windows.clear();
    lastPrunedAt = 0;
  }

  return {
    prepareEntry,
    isBotConversation,
    review,
    reset
  };
}

module.exports = {
  AUTOMATIC_BLOCK_DURATION_MS,
  AUTOMATIC_BLOCK_NOTICE,
  AUTOMATIC_BLOCK_SOURCE,
  createInboundUserSafetyReviewer
};
