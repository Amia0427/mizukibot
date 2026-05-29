// api/toolExecutors/index.js
// Split from toolRegistry.js for maintainability.
// api/toolRegistry.js
/**
 * Tool execution hub.
 * 1) Exposes OpenAI / LangGraph compatible TOOL_SCHEMAS.
 * 2) Provides a unified TOOL_EXECUTORS map for runtime dispatch.
 * 3) Keeps external skill invocation and local tool wiring in one place.
 */

const tools1 = require('../tools');
const tools2 = require('../tools_batch2');
const tools3 = require('../tools_batch3');
const tools4 = require('../tools_batch4');
const toolsExtra = require('../tools_extra');
const config = require('../../config');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { isUnsafeHttpUrl } = require('../../utils/networkSafety');
const { formatContextStats } = require('../../utils/contextInspector');
const { searchRecipes } = require('../../utils/howtocookLocalSearch');
const {
  formatEventsAsText,
  formatGuidesAsText,
  formatPatternsAsText,
  formatRulesAsText,
  listGuides,
  listPatterns,
  listRecentEvents,
  listRules,
  searchEvents
} = require('../../utils/selfImprovementRuntime');
const {
  cancelScheduledTask,
  createScheduledCommand,
  deleteScheduledTask,
  listScheduledTasks,
  publishQzoneForContext,
  scheduleGroupMessage
} = require('../qqActionService');
const { createLazyModuleProxy } = require('./lazyModules');
const {
  ensureSkillPath,
  loadSkillReference,
  resolveSkillsBaseDir
} = require('./skillRuntime');

const assistantSkills = createLazyModuleProxy('assistantSkills', () => require('../skills_assistant'));
const minecraftAgent = createLazyModuleProxy('minecraftAgent', () => require('../minecraftAgent'));
const nativeArxiv = createLazyModuleProxy('nativeArxiv', () => require('../skills_native/arxiv'));
const nativeWeather = createLazyModuleProxy('nativeWeather', () => require('../skills_native/weather'));
const nativeSkillValidation = createLazyModuleProxy('nativeSkillValidation', () => require('../skills_native/skillValidation'));
const nativeClawddocs = createLazyModuleProxy('nativeClawddocs', () => require('../skills_native/clawddocs'));
const nativeSummarize = createLazyModuleProxy('nativeSummarize', () => require('../skills_native/summarize'));
const nativeStockQuote = createLazyModuleProxy('nativeStockQuote', () => require('../skills_native/stocks/quote'));
const nativeStockDividend = createLazyModuleProxy('nativeStockDividend', () => require('../skills_native/stocks/dividend'));
const nativeStockPortfolio = createLazyModuleProxy('nativeStockPortfolio', () => require('../skills_native/stocks/portfolio'));
const nativeStockHot = createLazyModuleProxy('nativeStockHot', () => require('../skills_native/stocks/hot'));
const nativeStockRumor = createLazyModuleProxy('nativeStockRumor', () => require('../skills_native/stocks/rumor'));
const nativeStockAnalyze = createLazyModuleProxy('nativeStockAnalyze', () => require('../skills_native/stocks/analyze'));
const nativeStockWatchlist = createLazyModuleProxy('nativeStockWatchlist', () => require('../skills_native/stocks/watchlist'));
const nativeOntology = createLazyModuleProxy('nativeOntology', () => require('../skills_native/ontology'));
const nativeYoutube = createLazyModuleProxy('nativeYoutube', () => require('../skills_native/youtube'));
const nativePpt = createLazyModuleProxy('nativePpt', () => require('../skills_native/ppt'));
const nativeImageGenerate = createLazyModuleProxy('nativeImageGenerate', () => require('../skills_native/imageGenerate'));

let cachedMemoryCliRunner = undefined;

function getMemoryCliRunner() {
  if (cachedMemoryCliRunner !== undefined) return cachedMemoryCliRunner;
  try {
    const mod = require('../../utils/memoryCli');
    cachedMemoryCliRunner = typeof mod?.runMemoryCli === 'function' ? mod.runMemoryCli : null;
  } catch (error) {
    cachedMemoryCliRunner = null;
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    console.warn('[toolExecutors] memory_cli unavailable:', error.message);
  }
  return cachedMemoryCliRunner;
}

function normalizeWebQuery(args = {}) {
  return String(args.query ?? args.keyword ?? args.q ?? '').trim();
}

function checkNodeRuntimeCapability(name = '') {
  const target = String(name || '').trim();
  if (!target) return 'Missing runtime capability name.';
  try {
    require.resolve(target);
    return `${target}:ok`;
  } catch (error) {
    return `${target}:missing (${error.message})`;
  }
}

async function runFreeWebSearch(args = {}) {
  const query = normalizeWebQuery(args);
  if (!query) return '请提供 query，例如：query="最新 AI 新闻"';
  return tools1.web_search(query);
}

async function runFreeUrlExtract(args = {}) {
  const url = String(args.url ?? args.link ?? '').trim();
  if (!url) return '请提供 url，例如：url="https://example.com/article"';
  if (!/^https?:\/\//i.test(url)) return 'url 格式无效，请提供 http/https 链接。';
  // Block localhost/private targets to reduce SSRF risk from tool calls.
  if (isUnsafeHttpUrl(url)) return '出于安全策略，禁止访问本地或内网地址。';

  const buildReadableFallback = (targetUrl, reason = '') => {
    const reasonText = String(reason || '').trim();
    const lines = [
      '标题：页面抓取受限',
      `链接：${targetUrl}`
    ];
    if (reasonText) lines.push(`摘要：目标站点阻止了直接抓取，原因：${reasonText}`);
    lines.push('正文摘录：该页面启用了反爬或访问限制，当前无法直接提取正文。你可以继续使用该链接进行人工查看，或改用站内搜索结果摘要。');
    return lines.join('\n');
  };

  const extractReadableText = (targetUrl, html = '') => {
    const $ = cheerio.load(String(html || ''));
    $('script,style,noscript,iframe,svg').remove();

    const title = $('title').first().text().replace(/\s+/g, ' ').trim() || targetUrl;
    const metaDesc = (
      $('meta[name="description"]').attr('content')
      || $('meta[property="og:description"]').attr('content')
      || ''
    ).replace(/\s+/g, ' ').trim();

    const mainTextRaw = (
      $('main').first().text()
      || $('article').first().text()
      || $('body').text()
      || ''
    );
    const mainText = String(mainTextRaw).replace(/\s+/g, ' ').trim();
    const excerpt = mainText.slice(0, 1200);

    const lines = [
      `标题：${title}`,
      `链接：${targetUrl}`
    ];
    if (metaDesc) lines.push(`摘要：${metaDesc}`);
    if (excerpt) {
      lines.push(`正文摘录：${excerpt}${mainText.length > excerpt.length ? '...' : ''}`);
    } else {
      lines.push('正文摘录：未提取到可读文本。');
    }
    return lines.join('\n');
  };

  const requestHeaders = {
    'User-Agent': config.HTTP_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Referer: 'https://www.google.com/'
  };

  try {
    const resp = await axios.get(url, {
      timeout: 12000,
      maxRedirects: 5,
      proxy: false,
      validateStatus: (status) => status >= 200 && status < 400,
      headers: requestHeaders
    });

    const html = String(resp?.data || '');
    if (!html.trim()) {
      return `链接可访问，但没有可提取的页面内容：${url}`;
    }
    return extractReadableText(resp.request?.res?.responseUrl || url, html);
  } catch (e) {
    const status = Number(e?.response?.status || 0);
    const body = String(e?.response?.data || '');
    const reason = e.code || e.message || String(e);
    if (status === 403 || status === 429 || /cloudflare|attention required/i.test(body)) {
      return buildReadableFallback(url, `${status || 'blocked'} ${reason}`.trim());
    }
    return `页面提取失败：${reason}`;
  }
}

// -------------------------
// 1) Executor map (normalized object-style args)
// -------------------------
const TOOL_EXECUTORS = {
  // ===== tools.js =====
  getLyrics: async (args = {}) => {
    const question = args.question ?? args.song ?? args.text ?? '';
    return tools1.getLyrics(question);
  },

  getWeather: async (args = {}) => {
    const text = args.text ?? args.city ?? '';
    return tools1.getWeather(text);
  },

  search_nearby_places: async (args = {}) => {
    const keywords = args.keywords ?? args.query ?? '椁愬巺';
    const city = args.city ?? '閲嶅簡';
    return tools1.search_nearby_places(keywords, city);
  },

  local_howtocook_recipe_search: async (args = {}) => {
    return searchRecipes(args);
  },

  search_academic_paper: async (args = {}) => {
    const keywords = args.keywords ?? args.query ?? '';
    return tools1.search_academic_paper(keywords);
  },

  query_arcaea_info: async (args = {}) => {
    const song_name = args.song_name ?? args.song ?? args.keyword ?? '';
    return tools1.query_arcaea_info(song_name);
  },

  get_bilibili_hot: async () => {
    return tools1.get_bilibili_hot();
  },

  web_search: async (args = {}) => {
    const query = args.query ?? args.keyword ?? args.q ?? '';
    return tools1.web_search(query);
  },

  currency_convert: async (args = {}) => {
    const from = args.from ?? '';
    const to = args.to ?? '';
    const amount = args.amount ?? 1;
    return tools1.currency_convert(from, to, amount);
  },

  // ===== tools_batch2.js =====
  url_safety_check: async (args = {}) => {
    const url = args.url ?? args.link ?? '';
    return tools2.url_safety_check(url);
  },

  json_validate: async (args = {}) => {
    const text = args.text ?? args.json ?? '';
    return tools2.json_validate(text);
  },

  study_card_generator: async (args = {}) => {
    const topic = args.topic ?? '';
    const points = args.points ?? '';
    const count = args.count ?? 5;
    return tools2.study_card_generator(topic, points, count);
  },

  meeting_minutes_struct: async (args = {}) => {
    const text = args.text ?? args.content ?? '';
    return tools2.meeting_minutes_struct(text);
  },

  // ===== tools_batch3.js =====
  extract_todo_from_text: async (args = {}) => {
    const text = args.text ?? args.content ?? '';
    return tools3.extract_todo_from_text(text);
  },

  pomodoro_plan: async (args = {}) => {
    const goal = args.goal ?? '';
    const total_minutes = args.total_minutes ?? 120;
    const focus_minutes = args.focus_minutes ?? 25;
    const break_minutes = args.break_minutes ?? 5;
    return tools3.pomodoro_plan(goal, total_minutes, focus_minutes, break_minutes);
  },

  regex_tester: async (args = {}) => {
    const pattern = args.pattern ?? '';
    const text = args.text ?? '';
    const flags = args.flags ?? 'g';
    return tools3.regex_tester(pattern, text, flags);
  },

  text_stats: async (args = {}) => {
    const text = args.text ?? '';
    const top_n = args.top_n ?? 8;
    return tools3.text_stats(text, top_n);
  },

  safe_eval_math: async (args = {}) => {
    const expression = args.expression ?? args.expr ?? '';
    return tools3.safe_eval_math(expression);
  },

  // ===== tools_batch4.js =====
  notebook_reindex_folder: async (args = {}) => {
    const userId = args.userId ?? args.user_id ?? 'public';
    const folderPath = args.folderPath ?? args.folder ?? '';
    const options = args.options ?? {};
    return tools4.notebook_reindex_folder(userId, folderPath, options);
  },

  notebook_add_document: async (args = {}) => {
    const userId = args.userId ?? args.user_id ?? 'public';
    const title = args.title ?? '';
    const content = args.content ?? '';
    return tools4.notebook_add_document(userId, title, content);
  },

  notebook_list_docs: async (args = {}) => {
    const userId = args.userId ?? args.user_id ?? 'public';
    return tools4.notebook_list_docs(userId);
  },

  notebook_search: async (args = {}) => {
    const userId = args.userId ?? args.user_id ?? 'public';
    const query = args.query ?? '';
    const top_k = args.top_k ?? 5;
    return tools4.notebook_search(userId, query, top_k);
  },

  memory_cli: async (args = {}) => {
    const command = args.command ?? '';
    const context = args.__context && typeof args.__context === 'object' ? args.__context : {};
    const runMemoryCli = getMemoryCliRunner();
    if (typeof runMemoryCli !== 'function') {
      throw new Error('memory_cli unavailable: memory runtime dependencies are missing');
    }
    return JSON.stringify(await runMemoryCli(command, context));
  },

  get_context_stats: async (args = {}) => {
    const context = args.__context && typeof args.__context === 'object' ? args.__context : {};
    const snapshot = context.mainConversationSnapshot && typeof context.mainConversationSnapshot === 'object'
      ? context.mainConversationSnapshot
      : null;
    if (!snapshot) {
      return 'No main conversation context snapshot is available for this tool call.';
    }
    return formatContextStats(snapshot);
  },

  self_improvement_recent: async (args = {}) => {
    return formatEventsAsText(listRecentEvents(args.limit ?? 10, {
      kind: args.kind,
      status: args.status
    }));
  },

  self_improvement_search: async (args = {}) => {
    return formatEventsAsText(searchEvents(args.query ?? '', {
      top_k: args.top_k,
      kind: args.kind,
      promoted_only: args.promoted_only
    }));
  },

  self_improvement_patterns: async (args = {}) => {
    return formatPatternsAsText(listPatterns(args.limit ?? 10, {
      route_policy_key: args.route_policy_key,
      tool_name: args.tool_name
    }));
  },

  self_improvement_rules: async (args = {}) => {
    return formatRulesAsText(listRules(args.limit ?? 10, {
      pattern_key: args.pattern_key,
      top_route_type: args.top_route_type,
      tool_name: args.tool_name
    }));
  },

  self_improvement_guides: async (args = {}) => {
    return formatGuidesAsText(listGuides(args.limit ?? 10, {
      pattern_key: args.pattern_key,
      active_only: args.active_only
    }));
  },

  qzone_draft: async (args = {}) => {
    const context = args.__context && typeof args.__context === 'object' ? args.__context : {};
    const result = await publishQzoneForContext({
      content: args.content,
      mode: args.mode,
      hint: args.hint
    }, context);
    return result.text;
  },

  publish_qzone: async (args = {}) => {
    const context = args.__context && typeof args.__context === 'object' ? args.__context : {};
    const result = await publishQzoneForContext({
      content: args.content,
      mode: args.mode,
      hint: args.hint
    }, context);
    return result.text;
  },

  schedule_group_message: async (args = {}) => {
    const context = args.__context && typeof args.__context === 'object' ? args.__context : {};
    const result = scheduleGroupMessage(args.message, args.when, context);
    return result.text;
  },

  create_scheduled_command: async (args = {}) => {
    const context = args.__context && typeof args.__context === 'object' ? args.__context : {};
    const result = createScheduledCommand(args.action, args.when, {
      content: args.content,
      mode: args.mode,
      hint: args.hint
    }, context);
    return result.text;
  },

  create_qzone_auto_task: async (args = {}) => {
    const context = args.__context && typeof args.__context === 'object' ? args.__context : {};
    const result = createScheduledCommand('qzone_post', args.when, {
      content: args.content,
      mode: args.mode || 'agent',
      hint: args.hint
    }, context);
    return result.text;
  },

  list_scheduled_tasks: async (args = {}) => {
    const context = args.__context && typeof args.__context === 'object' ? args.__context : {};
    const result = listScheduledTasks(args.scope, context);
    return result.text;
  },

  cancel_scheduled_task: async (args = {}) => {
    const context = args.__context && typeof args.__context === 'object' ? args.__context : {};
    const result = cancelScheduledTask(args.job_id, context);
    return result.text;
  },

  delete_scheduled_task: async (args = {}) => {
    const context = args.__context && typeof args.__context === 'object' ? args.__context : {};
    const result = deleteScheduledTask(args.job_id, context);
    return result.text;
  },

  notebook_append_journal: async (args = {}) => {
    const entry = args.entry ?? '';
    const tag = args.tag ?? 'daily';
    return tools4.notebook_append_journal(entry, tag);
  },

  notebook_read_recent_journal: async (args = {}) => {
    const limit = args.limit ?? 5;
    return tools4.notebook_read_recent_journal(limit);
  },

  // ===== tools_extra.js =====
  get_current_time: async (args = {}) => {
    const timezone = args.timezone ?? 'Asia/Shanghai';
    return toolsExtra.get_current_time(timezone);
  },

  translate_text: async (args = {}) => {
    const text = args.text ?? '';
    const to = args.to ?? '';
    const from = args.from ?? 'auto';
    return toolsExtra.translate_text(text, to, from);
  },

  read_rss_feed: async (args = {}) => {
    const url = args.url ?? '';
    const limit = args.limit ?? 5;
    return toolsExtra.read_rss_feed(url, limit);
  },

  generate_uuid: async (args = {}) => {
    const version = args.version ?? 'v4';
    return toolsExtra.generate_uuid(version);
  },

  hash_text: async (args = {}) => {
    const text = args.text ?? '';
    const algorithm = args.algorithm ?? 'sha256';
    const encoding = args.encoding ?? 'hex';
    return toolsExtra.hash_text(text, algorithm, encoding);
  },

  extract_urls: async (args = {}) => {
    const text = args.text ?? '';
    const unique = args.unique ?? true;
    return toolsExtra.extract_urls(text, unique);
  },

  json_query: async (args = {}) => {
    const json_text = args.json_text ?? args.json ?? '';
    const path = args.path ?? '';
    return toolsExtra.json_query(json_text, path);
  },

  render_template: async (args = {}) => {
    const template = args.template ?? '';
    const variables = args.variables ?? {};
    return toolsExtra.render_template(template, variables);
  },

  jwt_decode: async (args = {}) => {
    const token = args.token ?? '';
    return toolsExtra.jwt_decode(token);
  },

  // ===== skills_assistant.js =====
  assistant_task_breakdown: async (args = {}) => {
    const goal = args.goal ?? '';
    const constraints = args.constraints ?? '';
    const max_tasks = args.max_tasks ?? 8;
    return assistantSkills.assistant_task_breakdown(goal, constraints, max_tasks);
  },

  assistant_weekly_agenda: async (args = {}) => {
    const goals = args.goals ?? [];
    const start_date = args.start_date ?? '';
    const focus_hours_per_day = args.focus_hours_per_day ?? 3;
    return assistantSkills.assistant_weekly_agenda(goals, start_date, focus_hours_per_day);
  },

  assistant_meeting_agenda: async (args = {}) => {
    const topic = args.topic ?? '';
    const participants = args.participants ?? [];
    const duration_minutes = args.duration_minutes ?? 45;
    const goals = args.goals ?? [];
    return assistantSkills.assistant_meeting_agenda(topic, participants, duration_minutes, goals);
  },

  assistant_email_draft: async (args = {}) => {
    const intent = args.intent ?? '';
    const recipient = args.recipient ?? '';
    const key_points = args.key_points ?? [];
    const tone = args.tone ?? 'professional';
    return assistantSkills.assistant_email_draft(intent, recipient, key_points, tone);
  },

  assistant_decision_matrix: async (args = {}) => {
    const options = args.options ?? [];
    const criteria = args.criteria ?? [];
    const weights = args.weights ?? {};
    return assistantSkills.assistant_decision_matrix(options, criteria, weights);
  },

  assistant_daily_brief: async (args = {}) => {
    const yesterday = args.yesterday ?? [];
    const today = args.today ?? [];
    const blockers = args.blockers ?? [];
    const mood = args.mood ?? '';
    return assistantSkills.assistant_daily_brief(yesterday, today, blockers, mood);
  },

  research_question_refiner: async (args = {}) => {
    const topic = args.topic ?? '';
    const domain = args.domain ?? '';
    const constraints = args.constraints ?? '';
    const expected_output = args.expected_output ?? '';
    return assistantSkills.research_question_refiner(topic, domain, constraints, expected_output);
  },

  research_literature_matrix: async (args = {}) => {
    const topic = args.topic ?? '';
    const papers = args.papers ?? [];
    const dimensions = args.dimensions ?? [];
    return assistantSkills.research_literature_matrix(topic, papers, dimensions);
  },

  research_experiment_plan: async (args = {}) => {
    const hypothesis = args.hypothesis ?? '';
    const variables = args.variables ?? [];
    const datasets = args.datasets ?? [];
    const timeline_days = args.timeline_days ?? 14;
    return assistantSkills.research_experiment_plan(hypothesis, variables, datasets, timeline_days);
  },

  research_paper_outline: async (args = {}) => {
    const title = args.title ?? '';
    const contribution_points = args.contribution_points ?? [];
    const target_venue = args.target_venue ?? '';
    const language = args.language ?? 'zh';
    return assistantSkills.research_paper_outline(title, contribution_points, target_venue, language);
  },

  research_peer_review_checklist: async (args = {}) => {
    const manuscript_type = args.manuscript_type ?? 'paper';
    const strictness = args.strictness ?? 'normal';
    return assistantSkills.research_peer_review_checklist(manuscript_type, strictness);
  },

  study_syllabus_plan: async (args = {}) => {
    const subject = args.subject ?? '';
    const level = args.level ?? 'beginner';
    const weeks = args.weeks ?? 8;
    const weekly_hours = args.weekly_hours ?? 6;
    return assistantSkills.study_syllabus_plan(subject, level, weeks, weekly_hours);
  },

  study_active_recall_quiz: async (args = {}) => {
    const topic = args.topic ?? '';
    const points = args.points ?? [];
    const count = args.count ?? 5;
    const difficulty = args.difficulty ?? 'normal';
    return assistantSkills.study_active_recall_quiz(topic, points, count, difficulty);
  },

  study_exam_revision_plan: async (args = {}) => {
    const exam_name = args.exam_name ?? '';
    const days_left = args.days_left ?? 14;
    const subjects = args.subjects ?? [];
    const daily_hours = args.daily_hours ?? 4;
    return assistantSkills.study_exam_revision_plan(exam_name, days_left, subjects, daily_hours);
  },

  research_abstract_structurer: async (args = {}) => {
    const raw_abstract = args.raw_abstract ?? '';
    const max_sentences = args.max_sentences ?? 6;
    return assistantSkills.research_abstract_structurer(raw_abstract, max_sentences);
  },

  research_intro_paragraph_builder: async (args = {}) => {
    const problem = args.problem ?? '';
    const gap = args.gap ?? '';
    const contributions = args.contributions ?? [];
    const tone = args.tone ?? 'formal';
    return assistantSkills.research_intro_paragraph_builder(problem, gap, contributions, tone);
  },

  research_result_interpreter: async (args = {}) => {
    const metrics = args.metrics ?? [];
    const baselines = args.baselines ?? [];
    const observations = args.observations ?? '';
    return assistantSkills.research_result_interpreter(metrics, baselines, observations);
  },

  study_mistake_diagnosis: async (args = {}) => {
    const subject = args.subject ?? '';
    const mistakes = args.mistakes ?? [];
    const days = args.days ?? 7;
    return assistantSkills.study_mistake_diagnosis(subject, mistakes, days);
  },

  study_spaced_repetition_plan: async (args = {}) => {
    const items = args.items ?? [];
    const days = args.days ?? 14;
    const intensity = args.intensity ?? 'normal';
    return assistantSkills.study_spaced_repetition_plan(items, days, intensity);
  },

  // ===== project skills =====
  skill_web_search: async (args = {}) => {
    return runFreeWebSearch(args);
  },

  skill_arxiv_search: async (args = {}) => {
    return nativeArxiv.searchArxiv(args);
  },

  skill_arxiv_get: async (args = {}) => {
    return nativeArxiv.getArxiv(args);
  },

  skill_arxiv_latest: async (args = {}) => {
    return nativeArxiv.latestArxiv(args);
  },

  skill_weather: async (args = {}) => {
    return nativeWeather.getWeatherSummary(args);
  },

  skill_youtube_transcript: async (args = {}) => {
    return nativeYoutube.getYoutubeTranscript(args);
  },

  skill_summarize: async (args = {}) => {
    return nativeSummarize.summarizeInput(args, config.DATA_DIR);
  },

  skill_vetter_report: async (args = {}) => {
    const skillName = String(args.skill_name ?? args.name ?? '').trim();
    if (!skillName) return '请提供要审查的 skill_name。';

    const skillsBaseDir = resolveSkillsBaseDir();
    const skillDir = path.join(skillsBaseDir, skillName);
    if (!fs.existsSync(skillDir)) {
      return `未找到技能目录：${skillDir}`;
    }

    // 安全检查关键词：用于快速静态筛查潜在风险。
    const redFlagPatterns = [
      /eval\s*\(/i,
      /exec\s*\(/i,
      /base64/i,
      /curl\s+/i,
      /wget\s+/i,
      /requests\.(post|get)\(/i,
      /subprocess\.(Popen|run)\(/i,
      /child_process/i,
      /~\/\.ssh/i,
      /~\/\.aws/i
    ];

    const reviewedFiles = [];
    const findings = [];

    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '__pycache__') continue;
          walk(abs);
        } else if (entry.isFile()) {
          reviewedFiles.push(abs);
          const ext = path.extname(entry.name).toLowerCase();
          if (!['.js', '.ts', '.py', '.sh', '.md', '.json', '.yaml', '.yml', '.txt'].includes(ext)) continue;
          let content = '';
          try { content = fs.readFileSync(abs, 'utf8'); } catch (_) { continue; }
          for (const p of redFlagPatterns) {
            if (p.test(content)) {
              findings.push(`${path.relative(skillsBaseDir, abs)} 命中规则: ${p}`);
            }
          }
        }
      }
    }

    walk(skillDir);

    const riskLevel = findings.length === 0 ? 'LOW' : (findings.length <= 3 ? 'MEDIUM' : 'HIGH');
    const verdict = findings.length === 0 ? 'SAFE TO INSTALL' : 'INSTALL WITH CAUTION';

    return [
      'SKILL VETTING REPORT',
      '====================',
      `Skill: ${skillName}`,
      `Path: ${skillDir}`,
      `Files Reviewed: ${reviewedFiles.length}`,
      `Risk Level: ${riskLevel}`,
      `Verdict: ${verdict}`,
      '',
      findings.length ? 'Red Flags:' : 'Red Flags: None',
      ...(findings.length ? findings.slice(0, 30).map((x, i) => `${i + 1}. ${x}`) : [])
    ].join('\n');
  },

  skill_qqbot_dep_check: async () => {
    return [
      checkNodeRuntimeCapability('axios'),
      checkNodeRuntimeCapability('cheerio'),
      checkNodeRuntimeCapability('@langchain/core'),
      checkNodeRuntimeCapability('@langchain/openai')
    ].join('\n');
  },

  skill_brave_search: async (args = {}) => {
    return runFreeWebSearch(args);
  },

  web_fetch: async (args = {}) => {
    return runFreeUrlExtract(args);
  },

  skill_brave_extract: async (args = {}) => {
    return runFreeUrlExtract(args);
  },

  skill_tavily_search: async (args = {}) => {
    return runFreeWebSearch(args);
  },

  skill_tavily_extract: async (args = {}) => {
    return runFreeUrlExtract(args);
  },

  skill_stock_analyze: async (args = {}) => {
    return nativeStockAnalyze.analyzeStocks(args);
  },

  skill_stock_dividend: async (args = {}) => {
    return nativeStockDividend.queryDividends(args);
  },

  skill_stock_price_query: async (args = {}) => {
    return nativeStockQuote.queryQuotes(args);
  },

  skill_ontology_graph: async (args = {}) => {
    return nativeOntology.mutateOntology(config.DATA_DIR, args);
  },

  skill_stock_watchlist: async (args = {}) => {
    return nativeStockWatchlist.mutateWatchlist(config.DATA_DIR, args);
  },

  skill_skill_validate: async (args = {}) => {
    const skillName = String(args.skill_name ?? args.name ?? '').trim();
    return nativeSkillValidation.validateSkillByName(resolveSkillsBaseDir(), skillName);
  },

  skill_stock_hot: async (args = {}) => {
    return nativeStockHot.scanHot(args);
  },

  skill_stock_portfolio: async (args = {}) => {
    return nativeStockPortfolio.mutatePortfolio(config.DATA_DIR, args);
  },

  skill_stock_rumor: async () => {
    return nativeStockRumor.scanRumors();
  },

  skill_ppt_generate: async (args = {}) => {
    return nativePpt.generatePpt(args);
  },

  skill_ppt_theme_list: async () => {
    return nativePpt.listThemes();
  },

  skill_agent_browser_guide: async (args = {}) => {
    return loadSkillReference('agent-browser', args);
  },

  skill_api_gateway_reference: async (args = {}) => {
    return loadSkillReference('api-gateway', args);
  },

  skill_auto_updater_guide: async (args = {}) => {
    return loadSkillReference('auto-updater', args);
  },

  skill_byterover_guide: async (args = {}) => {
    return loadSkillReference('byterover', args);
  },

  skill_clawddocs_reference: async (args = {}) => {
    return loadSkillReference('clawddocs', args);
  },

  skill_find_skills_guide: async (args = {}) => {
    return loadSkillReference('find-skills', args);
  },

  skill_free_ride_guide: async (args = {}) => {
    return loadSkillReference('free-ride', args);
  },

  skill_github_api_guide: async (args = {}) => {
    return loadSkillReference('github-api', args);
  },

  skill_gog_guide: async (args = {}) => {
    return loadSkillReference('gog', args);
  },

  skill_humanizer_guide: async (args = {}) => {
    return loadSkillReference('humanizer', args);
  },

  skill_larry_guide: async (args = {}) => {
    return loadSkillReference('larry', args);
  },

  skill_n8n_workflow_guide: async (args = {}) => {
    return loadSkillReference('n8n-workflow-automation', args);
  },

  skill_nano_pdf_guide: async (args = {}) => {
    return loadSkillReference('nano-pdf', args);
  },

  skill_obsidian_guide: async (args = {}) => {
    return loadSkillReference('obsidian', args);
  },

  skill_openai_whisper_guide: async (args = {}) => {
    return loadSkillReference('openai-whisper', args);
  },

  skill_proactive_agent_guide: async (args = {}) => {
    return loadSkillReference('proactive-agent', args);
  },

  skill_research_cog_guide: async (args = {}) => {
    return loadSkillReference('research-cog', args);
  },

  skill_self_improving_agent_guide: async (args = {}) => {
    return loadSkillReference('self-improving-agent', args);
  },

  skill_skillhub_preference_guide: async (args = {}) => {
    return loadSkillReference('skillhub-preference', args);
  },

  skill_youtube_api_guide: async (args = {}) => {
    return loadSkillReference('youtube-api-skill', args);
  },

  skill_clawddocs_search: async (args = {}) => {
    const query = String(args.query ?? args.keyword ?? '').trim();
    const skillDir = ensureSkillPath('clawddocs');
    if (!query) return loadSkillReference('clawddocs', {});
    const hits = nativeClawddocs.searchDocs(skillDir, query);
    if (hits.length === 0) return `No clawddocs results for: ${query}`;
    return hits.map((item, index) => `${index + 1}. ${item}`).join('\n');
  },

  skill_clawddocs_fetch: async (args = {}) => {
    const docPath = String(args.doc_path ?? args.path ?? '').trim();
    const skillDir = ensureSkillPath('clawddocs');
    return nativeClawddocs.fetchDoc(skillDir, docPath);
  },

  skill_image_generate_pro: async (args = {}) => {
    return nativeImageGenerate.generateImage(args, config.DATA_DIR);
  },

  // ===== minecraft tools =====
  minecraft_connect: async (args = {}) => {
    return minecraftAgent.connect(args);
  },

  minecraft_disconnect: async (args = {}) => {
    return minecraftAgent.disconnect(args);
  },

  minecraft_status: async () => {
    return minecraftAgent.status();
  },

  minecraft_chat: async (args = {}) => {
    return minecraftAgent.chat(args);
  },

  minecraft_move_to: async (args = {}) => {
    return minecraftAgent.moveTo(args);
  },

  minecraft_follow_player: async (args = {}) => {
    return minecraftAgent.followPlayer(args);
  },

  minecraft_look_at: async (args = {}) => {
    return minecraftAgent.lookAt(args);
  },

  minecraft_stop: async () => {
    return minecraftAgent.stop();
  }
};

// -------------------------
// 2) Tool Schema锛堢粰妯″瀷鐪嬬殑锛?
// -------------------------

module.exports = {
  TOOL_EXECUTORS,
  _test: {
    loadSkillReference,
    resolveSkillsBaseDir
  }
};
