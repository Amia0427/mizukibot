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

function classifyRecallFacet(question = '') {
  const q = sanitizeText(question).toLowerCase();
  if (!q) return 'default_continuity';
  if (/(continue|continue with|resume|pick back up|next step|next steps|what should we do next|plan|task|todo|roadmap|继续|接着|接上|计划|任务|待办|推进)/i.test(q)) return 'task_or_plan';
  if (/(where did we leave off|what were we(?: just)? talking about|what were we doing|what was the thing from before|from before|earlier|previously|last time|continuity|recent|上次|刚才|刚刚|聊到哪|做到哪|接上)/i.test(q)) return 'recent_continuity';
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
  isMemoryContinuationQuestion,
  sanitizeText,
  shouldBiasToContinuity,
  shouldPrioritizeMemoryProbe
};
