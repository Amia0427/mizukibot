/**
 * Guidance library only.
 *
 * routeProfiles is not the source of routing truth.
 * It only provides policy descriptions, tool hints, and execution guidance
 * metadata for prompts, logging, and review.
 */
function createExecutionStep(step, instruction, preferredTools = [], options = {}) {
  return {
    step: String(step || '').trim(),
    instruction: String(instruction || '').trim(),
    preferredTools: Array.isArray(preferredTools)
      ? preferredTools.filter(Boolean).map((item) => String(item).trim()).filter(Boolean)
      : [],
    required: Array.isArray(options.required)
      ? options.required.filter(Boolean).map((item) => String(item).trim()).filter(Boolean)
      : [],
    produces: String(options.produces || '').trim(),
    successCheck: String(options.successCheck || '').trim(),
    ...(options.optional ? { optional: true } : {})
  };
}

const TOP_ROUTE_DEFINITIONS = {
  chat: {
    capability: 'chat',
    description: '纯对话、解释、建议、看法',
    defaultToolHints: []
  },
  lookup: {
    capability: 'tool',
    description: '查询事实、资料、网页、状态、图片内容',
    defaultToolHints: ['web_search']
  },
  transform: {
    capability: 'tool',
    description: '对已有内容加工，例如总结、提炼、改写、翻译、出题',
    defaultToolHints: ['skill_summarize']
  },
  plan: {
    capability: 'tool',
    description: '产出计划、步骤、议程、研究方案、决策框架',
    defaultToolHints: ['assistant_task_breakdown']
  },
  act: {
    capability: 'tool',
    description: '真正执行动作，例如写入、修改、安装、运行命令、远程操作',
    defaultToolHints: []
  },
  admin: {
    capability: 'admin',
    description: '管理命令',
    defaultToolHints: []
  },
  refuse: {
    capability: 'refuse',
    description: '命中拒绝标准',
    defaultToolHints: []
  },
  ignore: {
    capability: 'ignore',
    description: '空消息或无需响应',
    defaultToolHints: []
  }
};

const POLICY_DEFINITIONS = {
  'lookup/notebook-answer': {
    capability: 'tool',
    description: '查询用户资料、笔记、知识库、历史记录',
    toolHints: ['notebook_search', 'notebook_list_docs', 'notebook_add_document', 'notebook_reindex_folder'],
    executionPlan: [
      createExecutionStep('locate_scope', 'Determine the note scope, keywords, and any time or folder constraint.', [], {
        required: ['user question'],
        produces: 'search scope for notebook lookup',
        successCheck: 'the notebook search scope is clear enough to query'
      }),
      createExecutionStep('search_notebook', 'Search notebook content first and list documents only when useful.', ['notebook_search', 'notebook_list_docs'], {
        required: ['search scope'],
        produces: 'matching notes or candidate documents',
        successCheck: 'at least one relevant notebook match or a clear no-match result exists'
      }),
      createExecutionStep('inspect_matches', 'Inspect the strongest matches and extract the specific facts needed.', ['notebook_search'], {
        required: ['matching notebook entries'],
        produces: 'fact-level notes from notebook matches',
        successCheck: 'the answer can point to concrete note content instead of vague recall'
      }),
      createExecutionStep('answer_with_citations', 'Answer from notebook evidence and mention the note context when possible.', [], {
        required: ['fact-level notebook notes'],
        produces: 'final notebook-backed answer',
        successCheck: 'the reply is grounded in notebook content and signals the supporting note context'
      })
    ]
  },
  'lookup/vision-answer': {
    capability: 'chat',
    description: '图片理解、看图问答、基于图片回答',
    toolHints: [],
    executionPlan: []
  },
  'lookup/weather-live': {
    capability: 'tool',
    description: '查询天气、温度、降雨、空气情况',
    toolHints: ['web_search', 'web_fetch', 'skill_weather', 'getWeather'],
    executionPlan: [
      createExecutionStep('resolve_location', 'Resolve the location and requested weather window before answering.', [], {
        required: ['user question'],
        produces: 'resolved location and weather scope',
        successCheck: 'the agent knows what place and timeframe weather data should cover'
      }),
      createExecutionStep('collect_weather_source', 'Collect weather evidence from a reliable source before answering.', ['web_search', 'web_fetch', 'skill_weather', 'getWeather'], {
        required: ['resolved location and weather scope'],
        produces: 'weather evidence with core measurements',
        successCheck: 'the answer is grounded in retrieved weather data rather than guesswork'
      }),
      createExecutionStep('answer_weather', 'Answer with the requested weather details and note uncertainty if the source is incomplete.', [], {
        required: ['weather evidence'],
        produces: 'final weather answer',
        successCheck: 'the user receives a direct weather answer with the key conditions covered'
      })
    ]
  },
  'lookup/finance-live': {
    capability: 'tool',
    description: '股票、基金、加密货币、观察列表、投资组合、市场热点',
    toolHints: ['skill_stock_analyze', 'skill_stock_hot', 'skill_stock_dividend', 'skill_stock_watchlist', 'skill_stock_portfolio', 'skill_stock_rumor'],
    executionPlan: [
      createExecutionStep('identify_asset', 'Identify the asset, market, and user intent before analysis.', [], {
        required: ['ticker, name, or market clue'],
        produces: 'resolved asset scope',
        successCheck: 'the asset under discussion is unambiguous enough to analyze'
      }),
      createExecutionStep('collect_market_context', 'Collect the relevant market context with the stock toolset.', ['skill_stock_analyze', 'skill_stock_hot', 'skill_stock_watchlist', 'skill_stock_portfolio'], {
        required: ['resolved asset scope'],
        produces: 'market context and core asset signals',
        successCheck: 'the agent has concrete price, trend, or portfolio context to work from'
      }),
      createExecutionStep('analyze_signal', 'Interpret the collected signal and separate facts from speculation.', ['skill_stock_rumor', 'skill_stock_dividend'], {
        required: ['market context'],
        produces: 'structured stock analysis with uncertainty noted',
        successCheck: 'the analysis distinguishes verified signals, rumors, and missing data'
      }),
      createExecutionStep('answer_with_risk_note', 'Answer with explicit uncertainty and avoid presenting investment advice as certainty.', [], {
        required: ['structured stock analysis'],
        produces: 'final stock answer with risk framing',
        successCheck: 'the reply contains the analysis and an explicit risk or uncertainty note'
      })
    ]
  },
  'lookup/location-web': {
    capability: 'tool',
    description: '查询附近地点、地址、餐厅、门店、导航相关',
    toolHints: ['search_nearby_places'],
    executionPlan: []
  },
  'lookup/music-web': {
    capability: 'tool',
    description: '查询歌词、歌曲内容',
    toolHints: ['getLyrics'],
    executionPlan: []
  },
  'lookup/web-answer': {
    capability: 'tool',
    description: '搜索网页、新闻、资料、最新信息、链接查找',
    toolHints: ['web_search', 'web_fetch'],
    executionPlan: [
      createExecutionStep('search_sources', 'Search for relevant sources first, with priority on official documentation, primary sources, or recent trusted reports when the user explicitly asks for them.', ['web_search'], {
        required: ['user question'],
        produces: 'candidate sources relevant to the request',
        successCheck: 'at least one credible source has been identified before answering'
      }),
      createExecutionStep('read_source_detail', 'Read the strongest source in more detail instead of answering from search snippets alone.', ['web_fetch'], {
        required: ['candidate source'],
        produces: 'source-backed notes for the answer',
        successCheck: 'the answer is grounded in actual source content rather than title-only search results'
      }),
      createExecutionStep('browser_fallback', 'Use the browser when fetch cannot retrieve the needed content or the page requires rendering.', ['browser'], {
        required: ['source page needing rendered inspection'],
        produces: 'rendered page evidence for missing details',
        successCheck: 'missing key details are recovered before the final answer',
        optional: true
      }),
      createExecutionStep('answer_with_sources', 'Answer with clear conclusions, source context, and uncertainty where needed.', [], {
        required: ['source-backed notes'],
        produces: 'final answer grounded in retrieved sources',
        successCheck: 'the user receives a sourced answer instead of a guess'
      })
    ]
  },
  'transform/quiz': {
    capability: 'tool',
    description: '出题、测验、学习练习',
    toolHints: ['study_active_recall_quiz', 'study_exam_revision_plan', 'study_syllabus_plan'],
    executionPlan: [
      createExecutionStep('identify_scope', 'Identify the quiz topic, target learner, and expected difficulty.', [], {
        required: ['topic or learning goal'],
        produces: 'quiz scope and difficulty target',
        successCheck: 'the agent knows what subject to quiz and how hard it should be'
      }),
      createExecutionStep('generate_items', 'Generate quiz items using the study toolset when it helps.', ['study_active_recall_quiz', 'study_exam_revision_plan', 'study_syllabus_plan'], {
        required: ['quiz scope'],
        produces: 'draft questions with answers or checking points',
        successCheck: 'there is a usable set of quiz items aligned with the requested topic'
      }),
      createExecutionStep('check_difficulty', 'Check coverage and adjust the wording or difficulty if needed.', [], {
        required: ['draft quiz items'],
        produces: 'difficulty-calibrated quiz set',
        successCheck: 'questions match the requested level and do not drift off-topic'
      }),
      createExecutionStep('deliver_quiz', 'Deliver the quiz in a clean format and include answers only when appropriate.', [], {
        required: ['final quiz set'],
        produces: 'user-facing quiz output',
        successCheck: 'the user receives a ready-to-use quiz with clear instructions'
      })
    ]
  },
  'transform/notebook-summary': {
    capability: 'tool',
    description: '从 notebook 内容中总结、提炼与改写',
    toolHints: ['notebook_search', 'notebook_list_docs'],
    executionPlan: [
      createExecutionStep('locate_scope', 'Locate the notebook scope and the requested summary target.', [], {
        required: ['user request'],
        produces: 'summary target within notebook content',
        successCheck: 'the notebook summary target is specific enough to inspect'
      }),
      createExecutionStep('read_notebook', 'Read the relevant notebook content before summarizing it.', ['notebook_search', 'notebook_list_docs'], {
        required: ['summary target within notebook content'],
        produces: 'notebook source content for summary',
        successCheck: 'the summary is grounded in retrieved notebook content'
      }),
      createExecutionStep('answer_with_summary', 'Summarize the notebook content while preserving key facts and context.', [], {
        required: ['notebook source content'],
        produces: 'final notebook-backed summary',
        successCheck: 'the reply summarizes the requested note content instead of guessing'
      })
    ]
  },
  'transform/vision-summary': {
    capability: 'chat',
    description: '图片总结、提炼、说明',
    toolHints: [],
    executionPlan: []
  },
  'transform/self-contained-direct': {
    capability: 'direct',
    description: '直接处理当前消息里已经给出的文本内容，例如总结、提炼、改写或翻译',
    toolHints: [],
    executionPlan: []
  },
  'transform/web-summary': {
    capability: 'tool',
    description: '总结链接、文件、网页、文章、视频内容',
    toolHints: ['web_search', 'web_fetch', 'skill_summarize', 'skill_brave_extract', 'skill_tavily_extract', 'read_rss_feed'],
    executionPlan: [
      createExecutionStep('locate_target', 'Locate the actual target when the user provides only keywords or a site name.', ['web_search'], {
        required: ['target hint from the user'],
        produces: 'resolvable target url or document candidate',
        successCheck: 'the agent knows which page or document should be summarized',
        optional: true
      }),
      createExecutionStep('fetch_detail', 'Read the target content before summarizing it.', ['web_fetch'], {
        required: ['target url or document'],
        produces: 'summary-ready source content',
        successCheck: 'the agent has the primary content rather than only metadata'
      }),
      createExecutionStep('browser_fallback', 'Use the browser when fetch misses important sections of the content.', ['browser'], {
        required: ['target page needing rendered inspection'],
        produces: 'completed source coverage from rendered content',
        successCheck: 'important missing sections are recovered before summarizing',
        optional: true
      }),
      createExecutionStep('answer_with_sources', 'Summarize the content while preserving the core facts and the source.', [], {
        required: ['source content'],
        produces: 'concise summary with source context',
        successCheck: 'the summary covers the core points and references the source'
      })
    ]
  },
  'plan/research': {
    capability: 'tool',
    description: '研究、论文、文献综述、实验计划、论文结构',
    toolHints: ['research_question_refiner', 'research_literature_matrix', 'research_experiment_plan', 'research_paper_outline', 'research_peer_review_checklist', 'skill_web_search', 'web_search', 'web_fetch'],
    executionPlan: [
      createExecutionStep('search_sources', 'Search for primary or high-credibility sources before synthesizing.', ['web_search'], {
        required: ['research question'],
        produces: 'candidate papers, docs, or primary sources',
        successCheck: 'credible sources relevant to the research question are identified'
      }),
      createExecutionStep('fetch_core_pages', 'Read at least one core source in full before writing conclusions.', ['web_fetch'], {
        required: ['core source candidate'],
        produces: 'evidence notes from a core source',
        successCheck: 'the agent has read source content, not only search metadata'
      }),
      createExecutionStep('browser_fallback', 'Use the browser when fetch misses material needed for the conclusion.', ['browser'], {
        required: ['core source needing rendered inspection'],
        produces: 'rendered evidence for missing sections',
        successCheck: 'missing source details are recovered before synthesis',
        optional: true
      }),
      createExecutionStep('answer_with_sources', 'State conclusions with source backing and explicit uncertainty.', [], {
        required: ['source evidence notes'],
        produces: 'research answer with citations and uncertainty markers',
        successCheck: 'the final answer distinguishes evidence-backed claims from inference'
      })
    ]
  },
  'plan/general': {
    capability: 'tool',
    description: '任务拆解、待办、计划、议程、邮件、决策',
    toolHints: ['assistant_task_breakdown', 'assistant_weekly_agenda', 'assistant_meeting_agenda', 'assistant_email_draft', 'assistant_decision_matrix', 'extract_todo_from_text', 'pomodoro_plan'],
    executionPlan: [
      createExecutionStep('clarify_goal', 'Clarify the desired output, deadline, and constraints.', [], {
        required: ['user request'],
        produces: 'clear productivity objective',
        successCheck: 'the deliverable shape and constraints are explicit enough to plan against'
      }),
      createExecutionStep('structure_work', 'Choose the most relevant planning tool and structure the work.', ['assistant_task_breakdown', 'assistant_weekly_agenda', 'assistant_meeting_agenda', 'assistant_decision_matrix', 'extract_todo_from_text', 'pomodoro_plan'], {
        required: ['clear productivity objective'],
        produces: 'structured plan, agenda, or decision frame',
        successCheck: 'the work is broken into usable steps or an actionable structure'
      }),
      createExecutionStep('generate_deliverable', 'Draft the actual deliverable instead of only discussing it.', ['assistant_email_draft'], {
        required: ['structured work plan'],
        produces: 'user-facing productivity deliverable',
        successCheck: 'there is a concrete draft, checklist, or plan the user can use immediately'
      }),
      createExecutionStep('final_review', 'Review for missing actions, ordering mistakes, and ambiguity.', [], {
        required: ['draft deliverable'],
        produces: 'cleaned final deliverable',
        successCheck: 'the final output is actionable, ordered, and free of obvious gaps'
      })
    ]
  },
  'plan/general-direct': {
    capability: 'direct',
    description: '直接基于当前消息生成可用的计划、待办、议程或决策框架',
    toolHints: [],
    executionPlan: []
  },
  'act/default': {
    capability: 'tool',
    description: '执行型任务骨架，例如修改、写入、安装、运行命令、落地操作',
    toolHints: ['assistant_task_breakdown', 'notebook_add_document'],
    executionPlan: [
      createExecutionStep('confirm_action_target', 'Confirm what needs to be changed, where the action applies, and what must not be touched.', [], {
        required: ['user request'],
        produces: 'action target and guardrails',
        successCheck: 'the execution scope and no-go boundaries are explicit before acting'
      }),
      createExecutionStep('plan_execution', 'Break the action into ordered execution steps before making changes.', ['assistant_task_breakdown'], {
        required: ['action target and guardrails'],
        produces: 'ordered execution plan for the action',
        successCheck: 'there is a concrete step-by-step execution plan instead of vague action intent'
      }),
      createExecutionStep('apply_changes', 'Execute the requested action carefully and keep outputs tied to the requested scope.', ['notebook_add_document'], {
        required: ['ordered execution plan'],
        produces: 'applied action result or concrete execution outcome',
        successCheck: 'the requested action has been carried out or a precise blocking reason is identified'
      }),
      createExecutionStep('verify_and_report', 'Verify the action result and report what changed, what remains, and any risks.', [], {
        required: ['applied action result'],
        produces: 'verified execution summary',
        successCheck: 'the final reply clearly states what was done and the result is checked'
      })
    ]
  },
  'act/qq-publish-qzone': {
    capability: 'tool',
    description: '在当前群上下文内生成 QQ 空间草稿，仅管理员可用，不立即发布',
    toolHints: ['qzone_draft'],
    executionPlan: []
  },
  'act/qq-schedule-message': {
    capability: 'tool',
    description: '在当前群创建定时消息任务',
    toolHints: ['schedule_group_message', 'create_scheduled_command'],
    executionPlan: []
  },
  'act/qq-schedule-qzone': {
    capability: 'tool',
    description: '在当前群创建定时 QQ 空间任务，仅管理员可用',
    toolHints: ['create_qzone_auto_task', 'create_scheduled_command'],
    executionPlan: []
  },
  'act/qq-list-scheduled': {
    capability: 'tool',
    description: '查看当前群可访问的定时任务',
    toolHints: ['list_scheduled_tasks'],
    executionPlan: []
  },
  'act/qq-cancel-scheduled': {
    capability: 'tool',
    description: '取消或删除当前群内可访问的定时任务',
    toolHints: ['list_scheduled_tasks', 'cancel_scheduled_task', 'delete_scheduled_task'],
    executionPlan: []
  },
  'chat/default': {
    capability: 'chat',
    description: '普通聊天或不明确请求',
    toolHints: [],
    executionPlan: []
  },
  'admin/default': {
    capability: 'admin',
    description: '管理命令',
    toolHints: [],
    executionPlan: []
  },
  'refuse/default': {
    capability: 'refuse',
    description: '命中拒绝标准，返回固定拒绝文案',
    toolHints: [],
    executionPlan: []
  },
  'ignore/default': {
    capability: 'ignore',
    description: '空消息或无需响应',
    toolHints: [],
    executionPlan: []
  }
};

const POLICY_DESCRIPTIONS = Object.fromEntries(
  Object.entries(POLICY_DEFINITIONS).map(([policyKey, definition]) => [policyKey, definition.description || policyKey])
);

const POLICY_TOOL_HINTS = Object.fromEntries(
  Object.entries(POLICY_DEFINITIONS).map(([policyKey, definition]) => [policyKey, definition.toolHints || []])
);

const POLICY_EXECUTION_PLANS = Object.fromEntries(
  Object.entries(POLICY_DEFINITIONS)
    .filter(([, definition]) => Array.isArray(definition.executionPlan) && definition.executionPlan.length > 0)
    .map(([policyKey, definition]) => [policyKey, definition.executionPlan])
);

const TOP_ROUTE_DESCRIPTIONS = Object.fromEntries(
  Object.entries(TOP_ROUTE_DEFINITIONS).map(([routeType, definition]) => [routeType, definition.description || routeType])
);

const INTENT_ALIASES = {
  place: [
    '附近', '周边', '哪里有', '哪有', '在哪', '地址', '怎么去', '推荐',
    '餐厅', '饭店', '火锅', '咖啡店', '医院', '药店', '地铁站', '商场', '景点', '酒店', '银行', '超市'
  ],
  weather: ['天气', '气温', '下雨吗', '降温', '温度', '天气怎么样', '湿度', '风力'],
  quiz: ['考考我', '出题', '来题', '来一道题', '测验', '医学题', '刷题'],
  time: ['时间', '几点', '现在几点', '北京时间', '当地时间'],
  search: ['搜索', '搜一个', '查一个', '帮我找', '帮我搜', '检索', '最新', '新闻', '网页', '资料', '链接'],
  summarize: ['总结', '摘要', '概括', '提炼', '梳理', '总结一个', '概述'],
  notebook: ['笔记', '资料', '知识库', '文档', '记录', '之前记的', '我的资料', '我的笔记'],
  stock: ['股票', '美股', '港股', 'A股', '基金', '加密', '币圈', '股价', '分红', '股息', '观察列表', '投资组合', '行情', '财报'],
  research: ['研究', '论文', '文献', '综述', '实验', '假设', '审稿', 'abstract', 'peer review'],
  productivity: ['计划', '拆解', '待办', 'todo', '番茄钟', '议程', '邮件', '决策矩阵', '复习计划', '周计划']
};

function normalizePolicyKeyAlias(policyKey = '') {
  const normalized = String(policyKey || '').trim();
  if (normalized === 'lookup/time-direct') return 'lookup/web-answer';
  return normalized;
}

function getPolicyDefinition(policyKey = '') {
  return POLICY_DEFINITIONS[normalizePolicyKeyAlias(policyKey)] || null;
}

function getPolicyToolHints(policyKey = '') {
  const definition = getPolicyDefinition(policyKey);
  return Array.isArray(definition?.toolHints) ? [...definition.toolHints] : [];
}

function getPolicyExecutionPlan(policyKey = '') {
  const definition = getPolicyDefinition(policyKey);
  return Array.isArray(definition?.executionPlan) ? definition.executionPlan.map((step) => ({ ...step })) : [];
}

module.exports = {
  INTENT_ALIASES,
  POLICY_DEFINITIONS,
  POLICY_DESCRIPTIONS,
  POLICY_EXECUTION_PLANS,
  POLICY_TOOL_HINTS,
  TOP_ROUTE_DEFINITIONS,
  TOP_ROUTE_DESCRIPTIONS,
  normalizePolicyKeyAlias,
  getPolicyDefinition,
  getPolicyExecutionPlan,
  getPolicyToolHints
};
