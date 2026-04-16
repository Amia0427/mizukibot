// api/toolExecutors.js
// Split from toolRegistry.js for maintainability.
// api/toolRegistry.js
/**
 * Tool execution hub.
 * 1) Exposes OpenAI / LangGraph compatible TOOL_SCHEMAS.
 * 2) Provides a unified TOOL_EXECUTORS map for runtime dispatch.
 * 3) Keeps external skill invocation and local tool wiring in one place.
 */

const tools1 = require('./tools');
const tools2 = require('./tools_batch2');
const tools3 = require('./tools_batch3');
const tools4 = require('./tools_batch4');
const toolsExtra = require('./tools_extra');
const assistantSkills = require('./skills_assistant');
const minecraftAgent = require('./minecraftAgent');
const config = require('../config');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { runLocalCommandViaBridge, isLocalCommandBridgeEnabled } = require('../utils/localCommandBridgeClient');
const { isUnsafeHttpUrl } = require('../utils/networkSafety');
const { formatContextStats } = require('../utils/contextInspector');
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
} = require('../utils/selfImprovementRuntime');
const {
  cancelScheduledTask,
  createScheduledCommand,
  deleteScheduledTask,
  listScheduledTasks,
  publishQzoneForContext,
  scheduleGroupMessage
} = require('./qqActionService');

// Keep skill paths configurable while defaulting to the project-level skills folder.
function resolveSkillsBaseDir() {
  const fromEnv = String(process.env.MIZUKI_SKILLS_DIR || '').trim();
  const candidates = [
    fromEnv,
    path.resolve(__dirname, '..', 'skills'),
    path.resolve(process.cwd(), 'skills'),
    path.resolve(__dirname, '..', '..', '..', 'skills'),
    path.resolve(process.cwd(), '..', '..', 'skills'),
    path.resolve(process.cwd(), '..', 'skills')
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {}
  }
  // Prefer the project-local skills directory when env vars are not loaded yet.
  return path.resolve(__dirname, '..', 'skills');
}

const SKILLS_BASE_DIR = resolveSkillsBaseDir();
const SKILLS_VENV_DIR = String(process.env.MIZUKI_SKILLS_VENV || '').trim()
  || path.resolve(__dirname, '..', '.venv_skills');
const SKILLS_PY_DEPS_DIR = String(process.env.MIZUKI_SKILLS_PY_DEPS || '').trim()
  || path.resolve(__dirname, '..', '.skills_pydeps');
const SKILLS_BIN_DIR = String(process.env.MIZUKI_SKILLS_BIN || '').trim()
  || path.resolve(__dirname, '..', '.skills_bin');
let cachedMemoryCliRunner = undefined;

function getMemoryCliRunner() {
  if (cachedMemoryCliRunner !== undefined) return cachedMemoryCliRunner;
  try {
    const mod = require('../utils/memoryCli');
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
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
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

function getVenvBinDir() {
  return process.platform === 'win32'
    ? path.join(SKILLS_VENV_DIR, 'Scripts')
    : path.join(SKILLS_VENV_DIR, 'bin');
}

function getVenvPython() {
  return process.platform === 'win32'
    ? path.join(getVenvBinDir(), 'python.exe')
    : path.join(getVenvBinDir(), 'python3');
}

function buildCommandEnv(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  const venvBin = getVenvBinDir();
  const pathParts = [venvBin, SKILLS_BIN_DIR, env.PATH || ''].filter(Boolean);
  const pyPathParts = [SKILLS_PY_DEPS_DIR, env.PYTHONPATH || ''].filter(Boolean);

  // Put venv bin first so skill scripts can find yt-dlp/other local binaries.
  env.PATH = pathParts.join(path.delimiter);
  // Inject local python deps path so project-managed wheels can be imported.
  env.PYTHONPATH = pyPathParts.join(path.delimiter);
  // Avoid inheriting broken proxy settings from parent process.
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.ALL_PROXY;
  delete env.http_proxy;
  delete env.https_proxy;
  delete env.all_proxy;
  return env;
}

function commandExists(commandName, env = process.env) {
  const pathEntries = String(env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32'
    ? ['.exe', '.cmd', '.bat', '']
    : [''];
  for (const dir of pathEntries) {
    if (!dir) continue;
    for (const ext of exts) {
      const abs = path.join(dir, `${commandName}${ext}`);
      try {
        if (fs.existsSync(abs)) return true;
      } catch (_) {}
    }
  }
  return false;
}

function runCommand(command, args = [], options = {}) {
  const timeoutMs = Number(options.timeoutMs || config.TOOL_TIMEOUT_MS || 15000);
  const cwd = options.cwd || path.resolve(__dirname, '..');
  const env = options.env || process.env;

  if (process.platform === 'win32' && isLocalCommandBridgeEnabled()) {
    return runLocalCommandViaBridge({
      command: String(command || '').trim(),
      args,
      cwd,
      timeoutMs,
      env
    }, timeoutMs).then((result) => {
      if (result && result.ok) {
        return {
          stdout: String(result.stdout || '').trim(),
          stderr: String(result.stderr || '').trim(),
          code: Number(result.code || 0)
        };
      }
      const errMsg = String(result?.stderr || result?.stdout || result?.error || 'bridge command failed').trim();
      throw new Error(errMsg);
    });
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let finished = false;
    let timer = null;

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        child.kill('SIGTERM');
        reject(new Error(`命令超时(${timeoutMs}ms): ${command}`));
      }, timeoutMs);
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
      } else {
        const errMsg = stderr.trim() || stdout.trim() || `命令退出码: ${code}`;
        reject(new Error(errMsg));
      }
    });
  });
}

let cachedPythonCommand = null;

async function resolvePythonCommand(extraEnv = {}) {
  if (cachedPythonCommand) return cachedPythonCommand;

  const env = buildCommandEnv(extraEnv);
  const venvPython = getVenvPython();
  if (fs.existsSync(venvPython)) {
    try {
      await runCommand(venvPython, ['-V'], { env, timeoutMs: 5000 });
      cachedPythonCommand = { command: venvPython, baseArgs: [] };
      return cachedPythonCommand;
    } catch (_) {
      // Broken venvs are common after Python upgrades. Fall through to system Python.
    }
  }

  if (process.platform === 'win32') {
    const pyLauncher = path.join(process.env.SystemRoot || 'C:\Windows', 'py.exe');
    if (fs.existsSync(pyLauncher)) {
      try {
        await runCommand(pyLauncher, ['-3', '-V'], { env, timeoutMs: 5000 });
        cachedPythonCommand = { command: pyLauncher, baseArgs: ['-3'] };
        return cachedPythonCommand;
      } catch (_) {
        // Continue to plain python fallback below.
      }
    }
  }

  const fallbackCommands = process.platform === 'win32'
    ? ['python']
    : ['python3', 'python'];
  for (const command of fallbackCommands) {
    try {
      await runCommand(command, ['-V'], { env, timeoutMs: 5000 });
      cachedPythonCommand = { command, baseArgs: [] };
      return cachedPythonCommand;
    } catch (_) {}
  }

  cachedPythonCommand = { command: process.platform === 'win32' ? 'python' : 'python3', baseArgs: [] };
  return cachedPythonCommand;
}

async function runSkillPython(scriptPath, scriptArgs = [], extraEnv = {}) {
  const env = buildCommandEnv(extraEnv);
  const python = await resolvePythonCommand(extraEnv);
  return runCommand(python.command, [...python.baseArgs, scriptPath, ...scriptArgs], { env });
}

async function runSkillNode(scriptPath, scriptArgs = [], extraEnv = {}) {
  const env = buildCommandEnv(extraEnv);
  return runCommand('node', [scriptPath, ...scriptArgs], { env });
}

function ensureSkillPath(skillName, relPath = '') {
  const abs = relPath
    ? path.join(SKILLS_BASE_DIR, skillName, relPath)
    : path.join(SKILLS_BASE_DIR, skillName);
  if (!fs.existsSync(abs)) {
    throw new Error(`Skill path not found: ${abs}`);
  }
  return abs;
}

function ensureSkillCacheDir(name) {
  const dir = path.join(config.DATA_DIR, 'skill_cache', name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function normalizeStringList(raw, limit = 10, itemMaxLen = 50) {
  const items = Array.isArray(raw)
    ? raw
    : String(raw ?? '').split(',');
  return items
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .map((item) => item.slice(0, itemMaxLen))
    .slice(0, limit);
}

function safeReadTextFile(absPath) {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch (_) {
    return '';
  }
}

function listSkillReferenceFiles(skillName) {
  const refs = [];
  const roots = [
    path.join(SKILLS_BASE_DIR, skillName, 'references'),
    path.join(SKILLS_BASE_DIR, skillName, 'assets'),
    path.join(SKILLS_BASE_DIR, skillName, 'snippets')
  ];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const entry of entries) {
        const abs = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(abs);
          continue;
        }
        const ext = path.extname(entry.name).toLowerCase();
        if (['.md', '.txt', '.json', '.yaml', '.yml'].includes(ext)) {
          refs.push(abs);
        }
      }
    }
  }

  return refs.sort();
}

function extractRelevantBlocks(text, query = '', limit = 2) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  const lines = String(text || '').split(/\r?\n/);
  if (!normalizedQuery) {
    return lines.join('\n').trim().slice(0, 2200);
  }

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = String(lines[i] || '');
    const lower = line.toLowerCase();
    if (!tokens.some((token) => lower.includes(token))) continue;
    const start = Math.max(0, i - 3);
    const end = Math.min(lines.length, i + 4);
    hits.push(lines.slice(start, end).join('\n').trim());
    if (hits.length >= limit) break;
  }

  if (hits.length > 0) return hits.join('\n\n---\n\n').slice(0, 2600);
  return lines.join('\n').trim().slice(0, 2200);
}

async function loadSkillReference(skillName, args = {}) {
  const skillDir = ensureSkillPath(skillName);
  const skillDocPath = path.join(skillDir, 'SKILL.md');
  const skillDoc = safeReadTextFile(skillDocPath);
  const query = String(args.query ?? args.topic ?? args.keyword ?? '').trim();
  const requestedRef = String(args.reference ?? args.doc ?? '').trim().toLowerCase();
  const refFiles = listSkillReferenceFiles(skillName);

  let selectedRef = '';
  if (requestedRef) {
    selectedRef = refFiles.find((abs) => path.basename(abs).toLowerCase() === requestedRef)
      || refFiles.find((abs) => abs.toLowerCase().includes(requestedRef))
      || '';
  }
  if (!selectedRef && query) {
    selectedRef = refFiles.find((abs) => path.basename(abs).toLowerCase().includes(query.toLowerCase()))
      || '';
  }
  if (!selectedRef && refFiles.length > 0) {
    selectedRef = refFiles[0];
  }

  const parts = [
    'SKILL: ' + skillName,
    'PATH: ' + skillDir
  ];

  if (query) {
    parts.push('QUERY: ' + query);
  }

  if (skillDoc) {
    parts.push('SKILL_MD:');
    parts.push(extractRelevantBlocks(skillDoc, query, 3));
  } else {
    parts.push('SKILL_MD: missing');
  }

  if (selectedRef) {
    const rel = path.relative(skillDir, selectedRef) || path.basename(selectedRef);
    const refText = safeReadTextFile(selectedRef);
    parts.push('REFERENCE_FILE: ' + rel);
    parts.push(extractRelevantBlocks(refText, query, 3));
  } else if (refFiles.length > 0) {
    parts.push('REFERENCE_FILES: ' + refFiles.slice(0, 8).map((abs) => path.relative(skillDir, abs)).join(', '));
  } else {
    parts.push('REFERENCE_FILES: none');
  }

  return parts.join('\n\n');
}

async function runShellSkillScript(skillName, relPath, args = [], extraEnv = {}) {
  const scriptPath = ensureSkillPath(skillName, relPath);
  if (process.platform === 'win32') {
    return {
      stdout: '',
      stderr: 'Script ' + relPath + ' requires a Linux shell runtime',
      code: 1
    };
  }
  return runCommand('bash', [scriptPath, ...args], {
    env: buildCommandEnv(extraEnv),
    cwd: path.dirname(scriptPath)
  });
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
    const query = String(args.query ?? '').trim();
    if (!query) return 'Missing query.';

    const scriptPath = ensureSkillPath('arxiv', path.join('scripts', 'arxiv_tool.py'));
    const maxResults = Math.max(1, Math.min(10, Number(args.max_results) || 5));
    const categories = normalizeStringList(args.categories ?? []);
    const tags = normalizeStringList(args.tags ?? []);
    const cmdArgs = [
      'search',
      '--query', query,
      '--max-results', String(maxResults)
    ];
    if (categories.length) cmdArgs.push('--categories', categories.join(','));
    if (tags.length) cmdArgs.push('--tags', tags.join(','));

    const { stdout, stderr } = await runSkillPython(scriptPath, cmdArgs, {
      PYTHONIOENCODING: 'utf-8'
    });
    return stdout || stderr || 'No arXiv search output.';
  },

  skill_arxiv_get: async (args = {}) => {
    const arxivId = String(args.arxiv_id ?? args.id ?? '').trim();
    if (!arxivId) return 'Missing arxiv_id.';

    const scriptPath = ensureSkillPath('arxiv', path.join('scripts', 'arxiv_tool.py'));
    const includeAbstract = Boolean(args.include_abstract ?? true);
    const cmdArgs = [
      'get',
      '--id', arxivId,
      '--include-abstract', includeAbstract ? 'true' : 'false'
    ];

    const { stdout, stderr } = await runSkillPython(scriptPath, cmdArgs, {
      PYTHONIOENCODING: 'utf-8'
    });
    return stdout || stderr || 'No arXiv paper output.';
  },

  skill_arxiv_latest: async (args = {}) => {
    const scriptPath = ensureSkillPath('arxiv', path.join('scripts', 'arxiv_tool.py'));
    const maxResults = Math.max(1, Math.min(10, Number(args.max_results) || 5));
    const categories = normalizeStringList(args.categories ?? []);
    const tags = normalizeStringList(args.tags ?? []);
    const cmdArgs = [
      'latest',
      '--max-results', String(maxResults)
    ];
    if (categories.length) cmdArgs.push('--categories', categories.join(','));
    if (tags.length) cmdArgs.push('--tags', tags.join(','));

    const { stdout, stderr } = await runSkillPython(scriptPath, cmdArgs, {
      PYTHONIOENCODING: 'utf-8'
    });
    return stdout || stderr || 'No arXiv latest output.';
  },

  skill_weather: async (args = {}) => {
    const location = String(args.location ?? args.city ?? args.text ?? '').trim();
    if (!location) return '请提供 location，例如：location="Shanghai"';

    const encodedLocation = encodeURIComponent(location).replace(/%20/g, '+');
    const format = String(args.format || '%l:+%c+%t+%h+%w').trim() || '%l:+%c+%t+%h+%w';
    const url = `https://wttr.in/${encodedLocation}?format=${encodeURIComponent(format)}`;
    const curlCmd = process.platform === 'win32' ? 'curl.exe' : 'curl';

    try {
      const { stdout } = await runCommand(curlCmd, ['-s', url], {
        env: process.env,
        timeoutMs: 10000
      });
      return stdout || '未获取到天气信息';
    } catch (e) {
      // Keep a clear fallback message so the bot can recover gracefully.
      return `天气查询失败：${e.message}`;
    }
  },

  skill_youtube_transcript: async (args = {}) => {
    const url = String(args.url ?? '').trim();
    if (!url) return '请提供 YouTube 视频链接，例如：url="https://www.youtube.com/watch?v=..."';

    const scriptPath = path.join(SKILLS_BASE_DIR, 'youtube-watcher', 'scripts', 'get_transcript.py');
    if (!fs.existsSync(scriptPath)) {
      return `未找到 youtube-watcher 脚本：${scriptPath}`;
    }

    const env = buildCommandEnv();
    const ytDlpInVenv = fs.existsSync(path.join(getVenvBinDir(), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'));
    const ytDlpInPath = commandExists('yt-dlp', env);
    if (!ytDlpInVenv && !ytDlpInPath) {
      return '缺少依赖 yt-dlp。请先安装：python -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple yt-dlp';
    }

    const { stdout } = await runSkillPython(scriptPath, [url], env);
    return stdout || '未获取到视频字幕（可能视频无字幕）';
  },

  skill_summarize: async (args = {}) => {
    const input = String(args.input ?? args.url ?? args.file ?? '').trim();
    if (!input) return '请提供 input（URL 或文件路径）。';

    const summarizeInVenv = fs.existsSync(path.join(getVenvBinDir(), process.platform === 'win32' ? 'summarize.exe' : 'summarize'));
    const summarizeInPath = commandExists('summarize', buildCommandEnv());
    if (!summarizeInVenv && !summarizeInPath) {
      return '未安装 summarize CLI。当前先使用内置总结能力完成摘要；如需该 CLI，可后续单独安装。';
    }

    const model = String(args.model || '').trim();
    const length = String(args.length || 'short').trim() || 'short';
    const useJson = Boolean(args.json);

    const cmdArgs = [input, '--length', length];
    if (model) cmdArgs.push('--model', model);
    if (useJson) cmdArgs.push('--json');

    const summarizeCmd = summarizeInVenv
      ? path.join(getVenvBinDir(), process.platform === 'win32' ? 'summarize.exe' : 'summarize')
      : 'summarize';

    const { stdout } = await runCommand(summarizeCmd, cmdArgs, {
      env: buildCommandEnv(),
      timeoutMs: 45000
    });
    return stdout || 'summarize 已执行，但没有输出内容';
  },

  skill_vetter_report: async (args = {}) => {
    const skillName = String(args.skill_name ?? args.name ?? '').trim();
    if (!skillName) return '请提供要审查的 skill_name。';

    const skillDir = path.join(SKILLS_BASE_DIR, skillName);
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
              findings.push(`${path.relative(SKILLS_BASE_DIR, abs)} 命中规则: ${p}`);
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
    const imports = ['requests', 'aiohttp', 'websockets'];
    const checks = [];
    for (const mod of imports) {
      try {
        const python = await resolvePythonCommand();
        const { stdout } = await runCommand(
          python.command,
          [...python.baseArgs, '-c', `import ${mod}; print("${mod}:ok")`],
          {
            env: buildCommandEnv(),
            timeoutMs: 6000
          }
        );
        checks.push(stdout || `${mod}:ok`);
      } catch (e) {
        checks.push(`${mod}:missing (${e.message})`);
      }
    }
    return checks.join('\n');
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
    const raw = args.tickers ?? args.ticker ?? [];
    const tickers = Array.isArray(raw)
      ? raw.map((v) => String(v || '').trim()).filter(Boolean)
      : String(raw || '').split(/[,\s]+/).map((v) => v.trim()).filter(Boolean);
    if (!tickers.length) return 'Missing ticker or tickers.';

    const scriptPath = ensureSkillPath('stock-analysis', path.join('scripts', 'analyze_stock.py'));
    const output = String(args.output || 'text').trim() || 'text';
    const cmdArgs = [...tickers, '--output', output];
    if (Boolean(args.fast)) cmdArgs.push('--fast');
    if (Boolean(args.no_insider)) cmdArgs.push('--no-insider');

    const { stdout, stderr } = await runSkillPython(scriptPath, cmdArgs);
    return stdout || stderr || 'Command completed with no output.';
  },

  skill_stock_dividend: async (args = {}) => {
    const raw = args.tickers ?? args.ticker ?? [];
    const tickers = Array.isArray(raw)
      ? raw.map((v) => String(v || '').trim()).filter(Boolean)
      : String(raw || '').split(/[,\s]+/).map((v) => v.trim()).filter(Boolean);
    if (!tickers.length) return 'Missing ticker or tickers.';

    const scriptPath = ensureSkillPath('stock-analysis', path.join('scripts', 'dividends.py'));
    const output = String(args.output || 'text').trim() || 'text';
    const { stdout, stderr } = await runSkillPython(scriptPath, [...tickers, '--output', output]);
    return stdout || stderr || 'Command completed with no output.';
  },

  skill_stock_price_query: async (args = {}) => {
    const raw = args.codes ?? args.code ?? args.tickers ?? args.ticker ?? '';
    const codes = Array.isArray(raw)
      ? raw.map((v) => String(v || '').trim()).filter(Boolean)
      : String(raw || '').split(/[,\s]+/).map((v) => v.trim()).filter(Boolean);
    if (!codes.length) return 'Missing code or codes.';
    if (codes.length > 20) return 'Too many codes. Maximum 20.';

    const scriptPath = ensureSkillPath('stock-price-query', path.join('scripts', 'stock_query.py'));
    const joined = codes.join(',');
    const market = String(args.market || '').trim().toLowerCase();
    const cmdArgs = [joined];
    if (market) cmdArgs.push(market);

    const { stdout, stderr } = await runSkillPython(scriptPath, cmdArgs);
    return stdout || stderr || 'No stock quote output.';
  },

  skill_ontology_graph: async (args = {}) => {
    const action = String(args.action || '').trim().toLowerCase();
    if (!action) return 'Missing action.';

    const scriptPath = ensureSkillPath('ontology', path.join('scripts', 'ontology.py'));
    const cacheDir = ensureSkillCacheDir('ontology');
    const graphPath = path.join(cacheDir, 'graph.jsonl');
    const schemaPath = path.join(cacheDir, 'schema.yaml');
    const cmdArgs = [action];

    if (action === 'create') {
      const type = String(args.type || '').trim();
      if (!type) return 'Missing type.';
      cmdArgs.push('--type', type);
      cmdArgs.push('--props', JSON.stringify(args.props || {}));
      if (String(args.id || '').trim()) cmdArgs.push('--id', String(args.id).trim());
    } else if (action === 'get' || action === 'delete') {
      const id = String(args.id || '').trim();
      if (!id) return 'Missing id.';
      cmdArgs.push('--id', id);
    } else if (action === 'query') {
      if (String(args.type || '').trim()) cmdArgs.push('--type', String(args.type).trim());
      cmdArgs.push('--where', JSON.stringify(args.where || {}));
    } else if (action === 'list') {
      if (String(args.type || '').trim()) cmdArgs.push('--type', String(args.type).trim());
    } else if (action === 'update') {
      const id = String(args.id || '').trim();
      if (!id) return 'Missing id.';
      cmdArgs.push('--id', id);
      cmdArgs.push('--props', JSON.stringify(args.props || {}));
    } else if (action === 'relate') {
      const fromId = String(args.from_id ?? args.from ?? '').trim();
      const rel = String(args.rel || '').trim();
      const toId = String(args.to_id ?? args.to ?? '').trim();
      if (!fromId || !rel || !toId) return 'Missing from_id, rel, or to_id.';
      cmdArgs.push('--from', fromId, '--rel', rel, '--to', toId);
      cmdArgs.push('--props', JSON.stringify(args.props || {}));
    } else if (action === 'related') {
      const id = String(args.id || '').trim();
      if (!id) return 'Missing id.';
      cmdArgs.push('--id', id);
      if (String(args.rel || '').trim()) cmdArgs.push('--rel', String(args.rel).trim());
      if (String(args.dir || '').trim()) cmdArgs.push('--dir', String(args.dir).trim());
    } else if (action === 'validate') {
      cmdArgs.push('--schema', schemaPath);
    } else if (action === 'schema-append') {
      const data = args.data || args.schema || null;
      if (!data) return 'Missing data.';
      cmdArgs.push('--schema', schemaPath, '--data', JSON.stringify(data));
    } else {
      return 'Unsupported action.';
    }

    if (action !== 'schema-append' && action !== 'validate') {
      cmdArgs.push('--graph', graphPath);
    } else if (action === 'validate') {
      cmdArgs.push('--graph', graphPath);
    }

    const { stdout, stderr } = await runSkillPython(scriptPath, cmdArgs, {
      PYTHONIOENCODING: 'utf-8'
    });
    return stdout || stderr || 'No ontology output.';
  },

  skill_stock_watchlist: async (args = {}) => {
    const action = String(args.action || '').trim().toLowerCase();
    if (!action) return 'Missing action. Use add/remove/list/check.';

    const scriptPath = ensureSkillPath('stock-analysis', path.join('scripts', 'watchlist.py'));
    const cmdArgs = [action];
    const ticker = String(args.ticker || '').trim();
    if (ticker) cmdArgs.push(ticker);
    if (Number.isFinite(Number(args.target))) cmdArgs.push('--target', String(args.target));
    if (Number.isFinite(Number(args.stop))) cmdArgs.push('--stop', String(args.stop));
    if (Boolean(args.alert_on_signal)) cmdArgs.push('--alert-on', 'signal');
    if (Boolean(args.notify)) cmdArgs.push('--notify');

    const { stdout, stderr } = await runSkillPython(scriptPath, cmdArgs);
    return stdout || stderr || 'Watchlist command completed with no output.';
  },

  skill_skill_validate: async (args = {}) => {
    const skillName = String(args.skill_name ?? args.name ?? '').trim();
    if (!skillName) return 'Missing skill_name.';

    const scriptPath = ensureSkillPath('skill-creator', path.join('scripts', 'quick_validate.py'));
    const targetPath = ensureSkillPath(skillName);
    const { stdout, stderr } = await runSkillPython(scriptPath, [targetPath]);
    return stdout || stderr || 'Skill validation completed with no output.';
  },

  skill_stock_hot: async (args = {}) => {
    const scriptPath = ensureSkillPath('stock-analysis', path.join('scripts', 'hot_scanner.py'));
    const cmdArgs = [];
    if (Boolean(args.no_social)) cmdArgs.push('--no-social');
    if (Boolean(args.json)) cmdArgs.push('--json');

    const { stdout, stderr } = await runSkillPython(scriptPath, cmdArgs, {
      CLAWDBOT_STATE_DIR: config.DATA_DIR
    });
    return stdout || stderr || 'Command completed with no output.';
  },

  skill_stock_portfolio: async (args = {}) => {
    const action = String(args.action || '').trim().toLowerCase();
    if (!action) return 'Missing action. Use create/list/show/delete/rename/add/update/remove.';

    const scriptPath = ensureSkillPath('stock-analysis', path.join('scripts', 'portfolio.py'));
    const cmdArgs = [action];
    if (action === 'create' || action === 'delete') {
      const name = String(args.name || '').trim();
      if (!name) return 'Missing name.';
      cmdArgs.push(name);
    } else if (action === 'rename') {
      const oldName = String(args.old_name || '').trim();
      const newName = String(args.new_name || '').trim();
      if (!oldName || !newName) return 'Missing old_name or new_name.';
      cmdArgs.push(oldName, newName);
    } else if (action === 'show') {
      const portfolio = String(args.portfolio || '').trim();
      if (portfolio) cmdArgs.push('--portfolio', portfolio);
    } else if (action === 'add' || action === 'update') {
      const ticker = String(args.ticker || '').trim();
      if (!ticker) return 'Missing ticker.';
      cmdArgs.push(ticker);
      if (Number.isFinite(Number(args.quantity))) cmdArgs.push('--quantity', String(args.quantity));
      if (Number.isFinite(Number(args.cost))) cmdArgs.push('--cost', String(args.cost));
      const portfolio = String(args.portfolio || '').trim();
      if (portfolio) cmdArgs.push('--portfolio', portfolio);
    } else if (action === 'remove') {
      const ticker = String(args.ticker || '').trim();
      if (!ticker) return 'Missing ticker.';
      cmdArgs.push(ticker);
      const portfolio = String(args.portfolio || '').trim();
      if (portfolio) cmdArgs.push('--portfolio', portfolio);
    } else if (action !== 'list') {
      return 'Unsupported action. Use create/list/show/delete/rename/add/update/remove.';
    }

    const { stdout, stderr } = await runSkillPython(scriptPath, cmdArgs, {
      CLAWDBOT_STATE_DIR: config.DATA_DIR
    });
    return stdout || stderr || 'Command completed with no output.';
  },

  skill_stock_rumor: async () => {
    const scriptPath = ensureSkillPath('stock-analysis', path.join('scripts', 'rumor_scanner.py'));
    const { stdout, stderr } = await runSkillPython(scriptPath, [], {
      CLAWDBOT_STATE_DIR: config.DATA_DIR
    });
    return stdout || stderr || 'Command completed with no output.';
  },

  skill_ppt_generate: async (args = {}) => {
    const query = String(args.query ?? args.topic ?? '').trim();
    if (!query) return 'Missing query.';
    if (!String(process.env.BAIDU_API_KEY || '').trim()) {
      return 'Missing BAIDU_API_KEY. AI PPT skill is unavailable.';
    }

    const scriptPath = ensureSkillPath('ai-ppt-generator', path.join('scripts', 'generate_ppt.py'));
    const cmdArgs = ['--query', query];
    if (Number.isFinite(Number(args.style_id))) cmdArgs.push('--style_id', String(args.style_id));
    if (Number.isFinite(Number(args.tpl_id))) cmdArgs.push('--tpl_id', String(args.tpl_id));
    const webContent = String(args.web_content || '').trim();
    if (webContent) cmdArgs.push('--web_content', webContent);

    const { stdout, stderr } = await runSkillPython(scriptPath, cmdArgs);
    return stdout || stderr || 'PPT command completed with no output.';
  },

  skill_ppt_theme_list: async () => {
    if (!String(process.env.BAIDU_API_KEY || '').trim()) {
      return 'Missing BAIDU_API_KEY. AI PPT skill is unavailable.';
    }

    const scriptPath = ensureSkillPath('ai-ppt-generator', path.join('scripts', 'ppt_theme_list.py'));
    const { stdout, stderr } = await runSkillPython(scriptPath, []);
    return stdout || stderr || 'PPT command completed with no output.';
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
    if (!query) return loadSkillReference('clawddocs', {});
    const { stdout, stderr } = await runShellSkillScript('clawddocs', path.join('scripts', 'search.sh'), [query]);
    return stdout || stderr || 'No clawddocs search output.';
  },

  skill_clawddocs_fetch: async (args = {}) => {
    const docPath = String(args.doc_path ?? args.path ?? '').trim();
    if (!docPath) return 'Missing doc_path.';
    const { stdout, stderr } = await runShellSkillScript('clawddocs', path.join('scripts', 'fetch-doc.sh'), [docPath]);
    return stdout || stderr || 'No clawddocs document output.';
  },

  skill_image_generate_pro: async (args = {}) => {
    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) return 'Missing prompt.';
    if (!String(process.env.GEMINI_API_KEY || args.api_key || '').trim()) {
      return 'Missing GEMINI_API_KEY. Nano Banana Pro skill is unavailable.';
    }

    const scriptPath = ensureSkillPath('nano-banana-pro', path.join('scripts', 'generate_image.py'));
    const outputDir = ensureSkillCacheDir('nano-banana-pro');
    const defaultName = 'image-' + Date.now() + '.png';
    const filename = String(args.filename || defaultName).trim() || defaultName;
    const outputPath = path.isAbsolute(filename) ? filename : path.join(outputDir, filename);
    const cmdArgs = ['--prompt', prompt, '--filename', outputPath];

    const resolution = String(args.resolution || '1K').trim() || '1K';
    cmdArgs.push('--resolution', resolution);

    const inputImage = String(args.input_image || '').trim();
    if (inputImage) cmdArgs.push('--input-image', inputImage);
    const apiKey = String(args.api_key || '').trim();
    if (apiKey) cmdArgs.push('--api-key', apiKey);

    const { stdout, stderr } = await runSkillPython(scriptPath, cmdArgs);
    return stdout || stderr || ('Image generated: ' + outputPath);
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

module.exports = { TOOL_EXECUTORS };


