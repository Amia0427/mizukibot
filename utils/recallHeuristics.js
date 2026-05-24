function sanitizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

const RECALL_FACETS = new Set([
  'preference',
  'identity',
  'relationship',
  'recent_continuity',
  'task_or_plan',
  'group_context',
  'broad_recall',
  'default_continuity'
]);

function isConversationalNoop(text = '') {
  const normalized = sanitizeText(text).toLowerCase();
  if (!normalized) return false;
  if (normalized.length <= 6 && /^(ok|okay|k|kk|yes|no|好|嗯|收到|晚安|早安)$/i.test(normalized)) {
    return true;
  }
  return /^(谢谢|感谢|辛苦了|收到|好的|好滴|ok|okay|nice|cool|哈哈|hhh|233|晚安|早安|拜拜|bye|晚点聊|回头说)[!！?？~]*$/i.test(normalized);
}

function isConversationRecapQuery(text = '') {
  const q = sanitizeText(text).toLowerCase();
  if (!q) return false;
  if (/(今天天气|今天.{0,8}(天气|气温|下雨|温度|股价|股票|行情|新闻|日期|星期|几点)|today.{0,12}(weather|temperature|stock|news|date|time))/i.test(q)) {
    return false;
  }
  if (/(今天|今日).{0,10}(和你|我们|我).{0,14}(说|聊|讲|提).{0,10}(什么|啥|哪些|过|了|的)/i.test(q)) return true;
  if (/(今天|今日).{0,10}(聊天|对话|说的|聊的|说过|聊过).{0,10}(总结|回顾|复述|说一下|讲一下|什么|啥|哪些)/i.test(q)) return true;
  if (/(总结|回顾|复述|说一下|讲一下).{0,12}(今天|今日).{0,14}(聊天|对话|说的|聊的|说过|聊过|说了什么|聊了什么|说了啥|聊了啥|和你说|和你聊|我们说|我们聊)/i.test(q)) return true;
  if (/(刚刚|刚才|刚).{0,10}(我|我们).{0,10}(说|聊|讲|提).{0,10}(什么|啥|了|过|的)/i.test(q)) return true;
  if (/(我|我们).{0,10}(刚刚|刚才|刚).{0,10}(说|聊|讲|提).{0,10}(什么|啥|了|过|的)/i.test(q)) return true;
  if (/(what did (?:i|we) (?:just )?(?:say|talk about|discuss)|what (?:were|did) we (?:just )?(?:talking about|discuss)|recap (?:today|our chat|the chat))/i.test(q)) return true;
  return false;
}

function isRecentPersonalActivityRecallQuery(text = '') {
  const q = sanitizeText(text).toLowerCase();
  if (!q) return false;
  if (/(今天天气|今天.{0,8}(天气|气温|下雨|温度|股价|股票|行情|新闻|日期|星期|几点)|today.{0,12}(weather|temperature|stock|news|date|time))/i.test(q)) {
    return false;
  }
  const recent = '(?:今天|今日|刚刚|刚才|刚)';
  const actor = '(?:我|我们)?';
  const activity = '(?:打|玩|听|看|刷|做|去了|去过|去|发|发过|提到|说过|聊过|买|吃|喝|练|跑|测|试)';
  const objectQuestion = '(?:哪些|哪几|哪几个|哪几张|哪几首|哪首|什么|啥)';
  const objectNoun = '(?:歌|曲|谱|图|图片|照片|东西|内容|题|游戏|本|活动|记录)?';
  const patterns = [
    new RegExp(`${recent}.{0,8}${actor}.{0,8}${activity}.{0,10}${objectQuestion}${objectNoun}`, 'i'),
    new RegExp(`${actor}.{0,8}${recent}.{0,8}${activity}.{0,10}${objectQuestion}${objectNoun}`, 'i'),
    new RegExp(`${recent}.{0,8}${actor}.{0,8}${objectQuestion}${objectNoun}.{0,8}${activity}`, 'i'),
    new RegExp(`${actor}.{0,8}${recent}.{0,8}${objectQuestion}${objectNoun}.{0,8}${activity}`, 'i'),
    /(?:我|我们|俺|咱).{0,8}(?:打过|打了|玩过|玩了|听过|听了|看过|看了|刷过|刷了|做过|做了|去过|发过|发了|提到过|说过|聊过|买过|买了|吃过|吃了|喝过|喝了|练过|练了|测过|测了|试过|试了).{0,10}(?:哪些|哪几|哪几个|哪几张|哪几首|哪首|什么|啥)(?:歌|曲|谱|图|图片|照片|东西|内容|题|游戏|本|活动|记录)?/i,
    /(?:我|我们|俺|咱).{0,8}(?:哪些|哪几|哪几个|哪几张|哪几首|哪首|什么|啥)(?:歌|曲|谱|图|图片|照片|东西|内容|题|游戏|本|活动|记录)?.{0,10}(?:打过|打了|玩过|玩了|听过|听了|看过|看了|刷过|刷了|做过|做了|去过|发过|发了|提到过|说过|聊过|买过|买了|吃过|吃了|喝过|喝了|练过|练了|测过|测了|试过|试了)/i
  ];
  return patterns.some((pattern) => pattern.test(q));
}

function isRecentRecallQuery(text = '') {
  return isConversationRecapQuery(text) || isRecentPersonalActivityRecallQuery(text);
}

function classifyRecallFacet(question = '') {
  const q = sanitizeText(question).toLowerCase();
  if (!q) return 'default_continuity';
  if (isRecentRecallQuery(q)) return 'recent_continuity';
  if (/(where did we leave off|what were we(?: just)? talking about|what were we doing|what was the thing from before|from before|earlier|previously|last time|continuity|recent|上次|刚才|刚刚|聊到哪|做到哪|接上)/i.test(q)) return 'recent_continuity';
  if (/(continue|continue with|resume|pick back up|next step|next steps|what should we do next|plan|task|todo|roadmap|继续|接着|接上|计划|任务|待办|推进)/i.test(q)) return 'task_or_plan';
  if (/(喜欢|不喜欢|偏好|爱好|口味|习惯|风格|like|likes|prefer|preference|favorite|favourite|dislike|hobby)/i.test(q)) return 'preference';
  if (/(我是谁|身份|设定|画像|人设|总结|印象|identity|who am i|profile|summary|impression)/i.test(q)) return 'identity';
  if (/(关系|相处|熟悉|朋友|friend|relationship|stage)/i.test(q)) return 'relationship';
  if (/(群|群里|频道|channel|group|大家|上下文|群友|群内)/i.test(q)) return 'group_context';
  if (/(回想|想起来|记得什么|都记得什么|全部记忆|anything|all memory|broad recall)/i.test(q)) return 'broad_recall';
  return 'default_continuity';
}

function getFacetSourceWeights(facet = 'default_continuity') {
  const base = {
    recent: 1,
    profile: 1,
    personal: 1,
    task: 1,
    group: 1,
    style: 1,
    jargon: 1,
    journal: 1
  };
  switch (facet) {
    case 'preference':
      return { ...base, profile: 1.44, personal: 1.28, recent: 1.16, task: 0.92, group: 0.86, style: 0.9, jargon: 0.76, journal: 0.94 };
    case 'identity':
      return { ...base, profile: 1.5, personal: 1.18, recent: 1.06, task: 0.86, group: 0.84, style: 0.88, jargon: 0.74, journal: 0.92 };
    case 'relationship':
      return { ...base, profile: 1.34, personal: 1.18, recent: 1.18, task: 0.92, group: 0.98, style: 0.9, jargon: 0.82, journal: 0.94 };
    case 'recent_continuity':
      return { ...base, recent: 1.94, task: 1.36, journal: 1.32, personal: 1.1, group: 0.98, profile: 0.72, style: 0.72, jargon: 0.72 };
    case 'task_or_plan':
      return { ...base, recent: 1.48, task: 1.74, journal: 1.28, personal: 1.12, profile: 0.78, group: 0.9, style: 0.76, jargon: 0.72 };
    case 'group_context':
      return { ...base, group: 1.48, jargon: 1.34, recent: 1.16, personal: 0.96, profile: 0.82, task: 0.9, style: 0.84, journal: 0.96 };
    case 'broad_recall':
      return { ...base, recent: 1.28, profile: 1.16, personal: 1.12, task: 1.1, group: 0.98, style: 0.86, jargon: 0.84, journal: 1.06 };
    default:
      return { ...base, recent: 1.62, task: 1.42, journal: 1.22, personal: 1.12, group: 0.98, profile: 0.76, style: 0.8, jargon: 0.78 };
  }
}

function getFacetPerSourceLimit(facet = 'default_continuity') {
  const base = {
    recent: 2,
    task: 2,
    journal: 2,
    personal: 2,
    group: 2,
    profile: 2,
    style: 1,
    jargon: 1
  };
  switch (facet) {
    case 'preference':
    case 'identity':
    case 'relationship':
      return { ...base, profile: 3, personal: 2, recent: 2, task: 1, journal: 1 };
    case 'recent_continuity':
      return { ...base, recent: 4, task: 3, journal: 3, personal: 2, profile: 1 };
    case 'task_or_plan':
      return { ...base, recent: 3, task: 4, journal: 3, personal: 2, profile: 1 };
    case 'group_context':
      return { ...base, group: 3, jargon: 2, recent: 2, profile: 1, task: 1 };
    default:
      return { ...base, recent: 4, task: 3, journal: 3, personal: 2, profile: 1 };
  }
}

function shouldBiasToContinuity(facet = '') {
  return facet === 'recent_continuity' || facet === 'task_or_plan' || facet === 'default_continuity';
}

function isMemoryContinuationQuestion(text = '') {
  const normalized = sanitizeText(text);
  if (!normalized || isConversationalNoop(normalized)) return false;
  if (/^(你觉得|你认为|你喜不喜欢|你喜歡|你怎么看|觉得.*好听吗|觉得.*怎么样|what do you think|how do you feel)/i.test(normalized)) {
    return false;
  }
  if (isRecentRecallQuery(normalized)) return true;
  const facet = classifyRecallFacet(normalized);
  return facet !== 'group_context' || /(继续|上次|最近群里|刚刚|刚才|context|上下文)/i.test(normalized);
}

function shouldPrioritizeMemoryProbe(route = {}) {
  const cleanText = sanitizeText(route?.cleanText || route?.rawText || '');
  if (!cleanText) return false;
  if (isConversationalNoop(cleanText)) return false;
  if (String(route?.facets?.domain || '').trim() === 'time') return false;
  const sourceScope = String(route?.facets?.sourceScope || '').trim().toLowerCase();
  const freshness = String(route?.facets?.freshness || '').trim().toLowerCase();
  const chatMode = String(route?.meta?.chatMode || '').trim().toLowerCase();
  if (chatMode === 'image_qa' || chatMode === 'image_summary') return false;
  if (freshness === 'latest' || sourceScope === 'web' || sourceScope === 'live') return false;
  if (/^(search|look up|find|google|latest|news|official|docs?|documentation|官网|查一下|搜索)/i.test(cleanText)) return false;
  if (Boolean(route?.intent?.needsMemory)) return true;
  return isMemoryContinuationQuestion(cleanText);
}

module.exports = {
  RECALL_FACETS,
  classifyRecallFacet,
  getFacetPerSourceLimit,
  getFacetSourceWeights,
  isConversationalNoop,
  isConversationRecapQuery,
  isRecentPersonalActivityRecallQuery,
  isRecentRecallQuery,
  isMemoryContinuationQuestion,
  sanitizeText,
  shouldBiasToContinuity,
  shouldPrioritizeMemoryProbe
};
