const INTENT_ALIASES = Object.freeze({
  place: [
    '附近', '周边', '哪里', '哪有', '在哪', '地址', '怎么去', '推荐',
    '餐厅', '饭店', '火锅', '咖啡店', '医院', '药店', '地铁站', '商场', '景点', '酒店', '银行', '超市'
  ],
  weather: ['天气', '气温', '下雨吗', '降温', '温度', '天气怎么样', '湿度', '风力'],
  quiz: ['考考我', '出题', '来题', '来一道题', '测验', '医学题', '刷题'],
  search: ['搜索', '搜一个', '查一个', '帮我找', '帮我搜', '检索', '最新', '新闻', '网页', '资料', '链接'],
  summarize: ['总结', '摘要', '概括', '提炼', '梳理', '总结一个', '概述'],
  notebook: ['笔记', '资料', '知识库', '文档', '记录', '之前记的', '我的资料', '我的笔记'],
  stock: ['股票', '美股', '港股', 'A股', '基金', '加密', '币圈', '股价', '分红', '股息', '观察列表', '投资组合', '行情', '财报'],
  research: ['研究', '论文', '文献', '综述', '实验', '假设', '审稿', 'abstract', 'peer review'],
  productivity: ['计划', '拆解', '待办', 'todo', '番茄钟', '议程', '邮件', '决策矩阵', '复习计划', '周计划']
});

const EXPLICIT_ACT_PATTERN = /(install|run command|execute command|modify file|edit file|write file|save to|append to|delete file|create file|apply change|deploy|restart service|remote operation|ssh into|patch code|修改文件|安装依赖|执行命令|部署|重启服务)/i;

function scoreByAliases(text = '', aliases = []) {
  const t = String(text || '');
  let hit = 0;
  for (const kw of aliases) {
    if (t.includes(kw)) hit += 1;
  }
  if (hit === 0) return 0;
  return Math.min(0.95, 0.42 + (hit - 1) * 0.18);
}

function scorePlaceIntent(text = '') {
  const t = String(text || '');
  let score = 0;
  if (/(附近|周边|哪里|哪有|在哪|地址|怎么去|推荐|nearby|around here|where is|location|address|how to get|recommend)/i.test(t)) score += 0.55;
  if (/(餐厅|饭店|火锅|咖啡店|医院|药店|地铁站|商场|景点|酒店|银行|超市|restaurant|cafe|coffee|hospital|pharmacy|subway|mall|hotel|bank|supermarket)/i.test(t)) score += 0.35;
  if (/(天气|气温|下雨|温度|weather|temperature|rain)/i.test(t) && !/(附近|周边|哪里|哪有|在哪|地址|怎么去|nearby|around here|where is|location|address)/i.test(t)) score -= 0.3;
  return Math.max(0, Math.min(0.98, score));
}

function scoreSearchIntent(text = '') {
  const t = String(text || '');
  let score = scoreByAliases(t, INTENT_ALIASES.search);
  if (/(search|look up|find|google|latest|news|official|docs?|documentation|source|link|links|资料|文档|官网|来源|链接|最新|新闻)/i.test(t)) score += 0.45;
  if (/(附近|周边|地址|地点|nearby|around here|address|location)/i.test(t)) score -= 0.15;
  return Math.max(0, Math.min(0.98, score));
}

function scoreSummarizeIntent(text = '', imageUrl = null) {
  const t = String(text || '');
  let score = scoreByAliases(t, INTENT_ALIASES.summarize);
  if (/(提炼|概括|整理|总结一个|摘要|summari[sz]e|summary|recap|outline|extract the key points)/i.test(t)) score += 0.28;
  if (imageUrl && /(这张图|图片|图里|看图|this image|the image|the picture|photo)/i.test(t)) score += 0.08;
  return Math.max(0, Math.min(0.98, score));
}

function hasInlineContentForTransform(text = '') {
  const t = String(text || '').trim();
  if (!t) return false;
  if (t.length >= 60) return true;
  if (/[，。；：！\n]/.test(t)) return true;
  if (/["'].*["']/.test(t)) return true;
  if (/(下面|以下|这段|这篇|这份|这一段|内容如下|原文|文本如下)/i.test(t)) return true;
  return false;
}

function shouldUseToolBackedSummary(text = '') {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/(my notes|my notebook|notes about|\u6211\u7684\u7b14\u8bb0|\u6211\u7684\u8d44\u6599|\u7b14\u8bb0|\u77e5\u8bc6\u5e93)/i.test(t)) return false;
  return /https?:\/\/|www\.|网页|链接|文章|新闻|视频|文件|pdf|notebook|notes?|文档|资料|网站|rss|youtube/i.test(t);
}

function isSelfContainedProductivityPlan(text = '') {
  const t = String(text || '').trim();
  if (!t) return false;
  if (!/(plan|planning|todo|task|agenda|schedule|roadmap|weekly study plan|计划|待办|议程|拆解|复习计划|学习计划|邮件草稿|决策)/i.test(t)) return false;
  return !/(research|paper|literature|experiment|论文|研究|文献|实验|latest|news|网页|链接|资料|notebook|notes?)/i.test(t);
}

function isTextOnlyPlanRequest(text = '') {
  const t = String(text || '').trim();
  if (!t) return false;
  if (!/(规划|计划|方案|步骤|拆解|怎么做|如何做|roadmap|proposal|strategy|plan|planning|step by step)/i.test(t)) return false;
  return !/(执行|运行|创建|生成文件|写入|修改|部署|安装|搜索|查找|联网|最新|网页|链接|资料|notebook|notes?|execute|run|create|write|modify|deploy|install|search|look up|latest|web|link)/i.test(t);
}

function isStrictTimeDirectQuestion(text = '') {
  const t = String(text || '').trim();
  if (!t) return false;
  if (!/(现在几点|几点了|当前时间|北京时间|time now|what time is it|current time)/i.test(t)) return false;
  return !/(timezone|鏃跺尯|convert|schedule|agenda|calendar|plan|summary|research|latest|news|weather|stock)/i.test(t);
}

function hasExplicitActSignal(text = '') {
  return EXPLICIT_ACT_PATTERN.test(String(text || '').trim());
}

function isSimpleTransformTask(text = '', imageUrl = null) {
  const t = String(text || '').trim();
  if (!t || imageUrl) return false;
  if (!/(总结|摘要|概括|提炼|梳理|改写|润色|翻译|简化|压缩|rewrite|rephrase|summari[sz]e|summary|translate)/i.test(t)) return false;
  if (shouldUseToolBackedSummary(t)) return false;
  return hasInlineContentForTransform(t);
}

function shouldPreferToolAssistance(text = '', imageUrl = null) {
  const t = String(text || '').trim();
  if (!t || imageUrl) return false;
  if (isSimpleTransformTask(t, imageUrl)) return false;
  if (isSelfContainedProductivityPlan(t)) return false;
  return /(search|look up|find|google|latest|news|official|docs?|documentation|source|link|links|log|logs|history|timeline|remember|recall|earlier|previous|before|web|website|\u641c\u7d22|\u67e5\u4e00\u4e0b|\u67e5\u67e5|\u5e2e\u6211\u67e5|\u7f51\u9875|\u5b98\u7f51|\u94fe\u63a5|\u8d44\u6599|\u6587\u6863|\u65e5\u5fd7|\u8bb0\u5f55|\u4e4b\u524d|\u6628\u5929|\u524d\u51e0\u5929|\u8bb0\u5f97|\u8bb0\u4e0d\u8bb0\u5f97|\u56de\u5fc6|\u53d1\u8fc7|\u56fe|\u56fe\u7247)/i.test(t);
}

function scoreNotebookIntent(text = '') {
  const t = String(text || '');
  let score = scoreByAliases(t, INTENT_ALIASES.notebook);
  if (/(我的资料|我的笔记|之前记录|之前记过|知识库|my notes|my notebook|my docs|my documents|knowledge base|notes about)/i.test(t)) score += 0.45;
  return Math.max(0, Math.min(0.98, score));
}

function scoreStockIntent(text = '') {
  const t = String(text || '');
  let score = scoreByAliases(t, INTENT_ALIASES.stock);
  if (/(AAPL|TSLA|NVDA|BTC|ETH|SPY|QQQ|绾虫寚|鏍囨櫘|stock|stocks|ticker|shares|portfolio|fund|crypto|etf)/i.test(t)) score += 0.45;
  return Math.max(0, Math.min(0.98, score));
}

function scoreResearchIntent(text = '') {
  const t = String(text || '');
  let score = scoreByAliases(t, INTENT_ALIASES.research);
  if (/(paper|papers|research|literature|experiment|hypothesis|review|abstract|method|璁烘枃|鐮旂┒|鏂囩尞|瀹為獙)/i.test(t)) score += 0.25;
  return Math.max(0, Math.min(0.98, score));
}

function scoreProductivityIntent(text = '') {
  const t = String(text || '');
  let score = scoreByAliases(t, INTENT_ALIASES.productivity);
  if (/(plan|planning|todo|task|agenda|email|schedule|roadmap|decision|璁″垝|寰呭姙|璁▼|鎷嗚В)/i.test(t)) score += 0.25;
  return Math.max(0, Math.min(0.98, score));
}

module.exports = {
  INTENT_ALIASES,
  hasExplicitActSignal,
  hasInlineContentForTransform,
  isSelfContainedProductivityPlan,
  isSimpleTransformTask,
  isStrictTimeDirectQuestion,
  isTextOnlyPlanRequest,
  scoreByAliases,
  scoreNotebookIntent,
  scorePlaceIntent,
  scoreProductivityIntent,
  scoreResearchIntent,
  scoreSearchIntent,
  scoreStockIntent,
  scoreSummarizeIntent,
  shouldPreferToolAssistance,
  shouldUseToolBackedSummary
};
