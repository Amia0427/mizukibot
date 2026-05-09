const { detectIntentByAI, TOP_ROUTE_TYPES } = require('./intentAI');
const config = require('../config');
const { runStructuredSubagent } = require('./structuredSubagent');
const {
  buildCanonicalRouteContract,
  normalizeChatMode,
  normalizeFacets,
  normalizeIntent,
  normalizeResponseIntent,
  sanitizeTopRouteType,
  normalizeToolIntent
} = require('./routeSchema');
const { isPrivilegedPrivateChatUser } = require('../utils/privilegedPrivateChat');
const { buildRouterStageSystemPrompt } = require('../utils/stagePromptContracts');
const { isRecentRecallQuery } = require('../utils/recallHeuristics');

const ADMIN_USER_IDS = new Set(config.ADMIN_USER_IDS || []);
const REFUSE_BYPASS_USER_IDS = new Set(config.REFUSE_BYPASS_USER_IDS || []);
const ADMIN_PREFIX = '/';
const TOP_ROUTE_TYPE_SET = new Set(TOP_ROUTE_TYPES);
const LOCAL_ROUTE_SOURCE = 'local_rule';
// router infers the canonical route contract only; planner/execution/policy live downstream.
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

const SAFETY_EXEMPT_PATTERN = /(防御|防止|检测|识别|排查|修复|清理|科普|解释|总结|翻译|新闻|报道|原理|为什么|风险|合法|合规|怎么办|恢复|止损|排障|defen[cs]e|prevent|detect|identify|investigate|triage|fix|cleanup|explain|summary|summari[sz]e|translate|news|report|principle|why|risk|legal|compliance|recovery|mitigation|remediation)/i;
const HARMFUL_MALICIOUS_ARTIFACT_PATTERN = /(钓鱼网站|钓鱼页|木马|病毒|勒索软件?|后门|僵尸网络|botnet|malware|ransomware|backdoor|trojan|炸弹|bomb)/i;
const HARMFUL_ARTIFACT_BUILD_PATTERN = /(教我|帮我|给我(?:一套|详细)?(?:步骤|教程|方法)|怎么(?:做|搞|写|建|搭|部署)|如何(?:做|搞|写|建|搭|部署)|写(?:一个|个)?|做(?:一个|个)?|制作|创建|生成|搭建|部署|build|make|create|generate|deploy|write|show me how|walk me through|give me steps)/i;
const HARMFUL_STEAL_OR_BYPASS_PATTERN = /(?:教我|帮我|给我(?:一套|详细)?(?:步骤|教程|方法)|怎么|如何|伪造|伪装|绕过|爆破|入侵|攻击|盗取|窃取|偷|破解|hack|steal|phish|exploit|bypass|attack|show me how|walk me through|give me steps)/i;
const HARMFUL_ACCOUNT_TARGET_PATTERNS = Object.freeze([
  /(?:偷|盗|窃取).{0,8}(?:密码|账号|cookie|凭证|验证码|session|token|credentials?)/i,
  /(?:密码|账号|cookie|凭证|验证码|session|token|credentials?).{0,8}(?:偷|盗|窃取)/i,
  /(?:破解|爆破|绕过).{0,8}(?:密码|账号|wifi|登录|验证码|二步验证|双重验证|2fa|mfa)/i,
  /(?:密码|账号|wifi|登录|验证码|二步验证|双重验证|2fa|mfa).{0,8}(?:破解|爆破|绕过)/i,
  /(?:phish|steal|exploit|bypass|hack|attack).{0,12}(?:password|account|cookie|token|session|credentials?|wifi|login|2fa|mfa)/i,
  /(?:password|account|cookie|token|session|credentials?|wifi|login|2fa|mfa).{0,12}(?:phish|steal|exploit|bypass|hack|attack)/i
]);
const BAD_FAITH_PATTERNS = Object.freeze([
  /(把这句话|同一句|同一段|这段话).{0,12}(重复|刷|连发).{0,12}(100|1000|10000|无限|不停|一直)/i,
  /(重复|刷屏|连发|轰炸).{0,12}(100|1000|10000|无限|不停|一直).{0,12}(群|聊天|对话|the chat|群里)/i,
  /(帮我|替我|去).{0,12}(群里|聊天里|对话里|the chat).{0,8}(刷屏|连发|轰炸)/i,
  /(帮我|替我).{0,10}(刷屏|轰炸|骚扰).{0,12}(他们|对方|别人|某人|那个人|someone|him|her|them)/i,
  /(spam|flood).{0,16}(the chat|someone|him|her|them)/i,
  /(harass|spam|flood).{0,12}(someone|the chat|them)/i,
  /(?:我要|我想|我要把|我会把|把|将).{0,6}(?:你|你的).{0,8}(?:工具调用|工具|能力|功能).{0,10}(?:全删了|删了|删掉|关掉|禁用|移除|废掉)/i,
  /(?:delete|remove|disable|turn off).{0,12}(?:your|the bot'?s).{0,12}(?:tool calls|tools|abilities|capabilities)/i
]);
const EXPLICIT_ACT_PATTERN = /(install|run command|execute command|modify file|edit file|write file|save to|append to|delete file|create file|apply change|deploy|restart service|remote operation|ssh into|patch code|修改文件|安装依赖|执行命令|部署|重启服务)/i;
const AI_ROUTE_SAFE_META_KEYS = new Set([
  'reason',
  'chatMode',
  'toolIntent',
  'responseIntent',
  'safetyBoundary'
]);
const SAFETY_BOUNDARY_PATTERNS = Object.freeze([
  /(钓鱼网站|钓鱼页|木马|病毒|勒索软件?|后门|僵尸网络|恶意软件|botnet|malware|ransomware|backdoor|trojan|ddos|sql injection|credential stuffing|bruteforce|brute force|doxx|人肉|诈骗|scam|炸弹|bomb)/i,
  /(?:账号|密码|cookie|凭证|验证码|session|token).{0,10}(?:被盗|泄露|偷|盗|窃取|破解|爆破|绕过)/i,
  /(?:偷|盗|窃取|破解|爆破|绕过).{0,10}(?:账号|密码|cookie|凭证|验证码|session|token|wifi|登录|二步验证|双重验证|2fa|mfa)/i,
  /(刷屏|连发|轰炸|骚扰|spam|flood|harass)/i,
  /(网络攻击|入侵|攻击链|phish|steal|exploit|bypass|hack)/i
]);

function matchesAnyPattern(text = '', patterns = []) {
  const t = String(text || '');
  return patterns.some((pattern) => pattern.test(t));
}

function hasSafetyExemptContext(text = '') {
  return SAFETY_EXEMPT_PATTERN.test(String(text || '').trim());
}

function detectExplicitHarmfulRequest(text = '') {
  const t = String(text || '').trim();
  if (!t) return { matched: false };
  if (hasSafetyExemptContext(t)) return { matched: false };
  const asksToBuildMaliciousArtifact = HARMFUL_ARTIFACT_BUILD_PATTERN.test(t) && HARMFUL_MALICIOUS_ARTIFACT_PATTERN.test(t);
  const asksToStealOrBypass = HARMFUL_STEAL_OR_BYPASS_PATTERN.test(t) && matchesAnyPattern(t, HARMFUL_ACCOUNT_TARGET_PATTERNS);
  if (asksToBuildMaliciousArtifact || asksToStealOrBypass) {
    return { matched: true, reason: 'harmful-request' };
  }
  return { matched: false };
}

function detectExplicitBadFaithRequest(text = '') {
  const t = String(text || '').trim();
  if (!t) return { matched: false };
  if (matchesAnyPattern(t, BAD_FAITH_PATTERNS)) {
    return { matched: true, reason: 'bad-faith-request' };
  }
  return { matched: false };
}

function detectSafetyBoundaryCaution(text = '') {
  const t = String(text || '').trim();
  if (!t) return false;
  if (detectExplicitHarmfulRequest(t).matched || detectExplicitBadFaithRequest(t).matched) return false;
  return matchesAnyPattern(t, SAFETY_BOUNDARY_PATTERNS);
}

function parseAdminCommand(cleanText = '') {
  const t = String(cleanText || '').trim();
  if (!t.startsWith(ADMIN_PREFIX)) return null;

  if (/^\/full(?:\s|$)/i.test(t)) {
    const payload = t.replace(/^\/full/i, '').trim();
    return {
      cmd: 'full',
      args: payload ? [payload] : [],
      raw: t,
      payload
    };
  }

  if (/^\/claude(?:\s|$)/i.test(t)) {
    const payload = t.replace(/^\/claude/i, '').trim();
    return {
      cmd: 'claude',
      args: payload ? [payload] : [],
      raw: t,
      payload
    };
  }

  if (/^\/claude-open(?:\s|$)/i.test(t)) {
    const payload = t.replace(/^\/claude-open/i, '').trim();
    return {
      cmd: 'claude-open',
      args: payload ? [payload] : [],
      raw: t,
      payload
    };
  }

  if (/^\/claude-send(?:\s|$)/i.test(t)) {
    const payload = t.replace(/^\/claude-send/i, '').trim();
    return {
      cmd: 'claude-send',
      args: payload ? [payload] : [],
      raw: t,
      payload
    };
  }

  if (/^\/claude-tail(?:\s|$)/i.test(t)) {
    const payload = t.replace(/^\/claude-tail/i, '').trim();
    return {
      cmd: 'claude-tail',
      args: payload ? [payload] : [],
      raw: t,
      payload
    };
  }

  if (/^\/claude-stop(?:\s|$)/i.test(t)) {
    const payload = t.replace(/^\/claude-stop/i, '').trim();
    return {
      cmd: 'claude-stop',
      args: payload ? [payload] : [],
      raw: t,
      payload
    };
  }

  if (/^\/create(?:\s|$)/i.test(t)) {
    const payload = t.replace(/^\/create/i, '').trim();
    return {
      cmd: 'create',
      args: payload ? [payload] : [],
      raw: t,
      payload
    };
  }

  if (/^\/meme(?:\s|$)/i.test(t)) {
    return { cmd: 'meme', args: t.split(/\s+/).slice(1), raw: t };
  }

  if (/^\/qzone_post(?:\s|$)/i.test(t)) {
    const payload = t.replace(/^\/qzone_post/i, '').trim();
    return {
      cmd: 'qzone_post',
      args: payload ? [payload] : [],
      raw: t,
      payload
    };
  }

  if (/^\/schedule_create(?:\s|$)/i.test(t)) {
    const payload = t.replace(/^\/schedule_create/i, '').trim();
    return {
      cmd: 'schedule_create',
      args: payload ? [payload] : [],
      raw: t,
      payload
    };
  }

  if (/^\/schedule_list(?:\s|$)/i.test(t)) {
    const payload = t.replace(/^\/schedule_list/i, '').trim();
    return {
      cmd: 'schedule_list',
      args: payload ? [payload] : [],
      raw: t,
      payload
    };
  }

  if (/^\/schedule_cancel(?:\s|$)/i.test(t)) {
    const payload = t.replace(/^\/schedule_cancel/i, '').trim();
    return {
      cmd: 'schedule_cancel',
      args: payload ? [payload] : [],
      raw: t,
      payload
    };
  }

  if (/^\/schedule_delete(?:\s|$)/i.test(t)) {
    const payload = t.replace(/^\/schedule_delete/i, '').trim();
    return {
      cmd: 'schedule_delete',
      args: payload ? [payload] : [],
      raw: t,
      payload
    };
  }

  if (/^\/hapi(?:\s|$)/i.test(t)) {
    const payload = t.replace(/^\/hapi/i, '').trim();
    return {
      cmd: 'hapi',
      args: payload ? payload.split(/\s+/).filter(Boolean) : [],
      raw: t,
      payload
    };
  }

  if (/^\/memoryops(?:\s|$)/i.test(t)) {
    const payload = t.replace(/^\/memoryops/i, '').trim();
    return {
      cmd: 'memoryops',
      args: payload ? payload.split(/\s+/).filter(Boolean) : [],
      raw: t,
      payload
    };
  }

  if (/^\/check(?:\s|$)/i.test(t)) {
    const payload = t.replace(/^\/check/i, '').trim();
    return {
      cmd: 'check',
      args: payload ? payload.split(/\s+/).filter(Boolean) : [],
      raw: t,
      payload
    };
  }

  if (/^\/learn(?:\s|$)/i.test(t)) {
    const payload = t.replace(/^\/learn/i, '').trim();
    const parts = payload.split(/\s+/).filter(Boolean);
    const subcmd = String(parts[0] || '').trim().toLowerCase();
    if (!subcmd) {
      return {
        cmd: 'learn',
        args: [],
        raw: t,
        payload: ''
      };
    }
    if (subcmd === 'recent' || subcmd === 'patterns' || subcmd === 'rules' || subcmd === 'style' || subcmd === 'social' || subcmd === 'graph') {
      return {
        cmd: `learn_${subcmd}`,
        args: parts.slice(1),
        raw: t,
        payload: parts.slice(1).join(' ').trim()
      };
    }
    if (subcmd === 'search') {
      return {
        cmd: 'learn_search',
        args: parts.slice(1),
        raw: t,
        payload: payload.replace(/^search\s+/i, '').trim()
      };
    }
    if (subcmd === 'guide') {
      return {
        cmd: 'learn_guide',
        args: parts.slice(1),
        raw: t,
        payload: payload.replace(/^guide\s+/i, '').trim()
      };
    }
    return {
      cmd: 'learn_unknown',
      args: parts.slice(1),
      raw: t,
      payload
    };
  }

  if (/^\/group_public(?:\s|$)/i.test(t)) {
    const payload = t.replace(/^\/group_public/i, '').trim();
    const args = payload ? payload.split(/\s+/).filter(Boolean) : [];
    return {
      cmd: 'group_public',
      args,
      raw: t,
      payload: args.join(' ').trim()
    };
  }

  if (/^\/main_stream(?:\s|$)/i.test(t)) {
    const payload = t.replace(/^\/main_stream/i, '').trim();
    const args = payload ? payload.split(/\s+/).filter(Boolean) : [];
    return {
      cmd: 'main_stream',
      args,
      raw: t,
      payload: args.join(' ').trim()
    };
  }

  const parts = t.slice(ADMIN_PREFIX.length).trim().split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  const args = parts.slice(1);
  const supported = new Set(['debug', 'status', 'reload', 'help', 'hapi', 'memoryops', 'check']);

  if (!supported.has(cmd)) return { cmd: 'unknown', args, raw: t };
  return { cmd, args, raw: t };
}

function hasQzoneTarget(text = '') {
  const input = String(text || '').trim();
  if (!input) return false;
  return /(?:qq\s*)?\u7a7a\u95f4|\u8bf4\u8bf4|qzone/i.test(input);
}

function hasGroupMessageTarget(text = '') {
  const input = String(text || '').trim();
  if (!input) return false;
  return /\u7fa4|\u672c\u7fa4|\u6d88\u606f|\u63d0\u9192|\u901a\u77e5|\u53d1\u9001/i.test(input);
}

function hasScheduleSignal(text = '') {
  const input = String(text || '').trim();
  if (!input) return false;
  if (/\u5b9a\u65f6|\u7a0d\u540e|\u5230\u70b9|cron/i.test(input)) return true;
  if (/(?:\u4eca\u5929|\u660e\u5929)\s*\d{1,2}:\d{2}/i.test(input)) return true;
  if (/\d+\s*(?:\u5206\u949f|\u5c0f\u65f6)\u540e/i.test(input)) return true;
  if (/\u6bcf\u5929\s*\d{1,2}:\d{2}/i.test(input)) return true;
  if (/\u6bcf\u5468[\u4e00-\u65e51-7]+\s*\d{1,2}:\d{2}/i.test(input)) return true;
  return /(?:^|\s)(?:\*|\d[\d*/,.-]*)\s+(?:\*|\d[\d*/,.-]*)\s+(?:\*|\d[\d*/,.-]*)\s+(?:\*|\d[\d*/,.-]*)\s+(?:\*|[\d*/,.-]+)(?:\s|$)/.test(input);
}

function hasQzonePublishSignal(text = '') {
  const input = String(text || '').trim();
  if (!input) return false;
  return /(?:\u53d1(?:\u4e2a|\u4e00\u6761|\u4e00\u7bc7|\u5230)?|\u53d1\u5e03|\u5e2e\u6211\u53d1|\u5199(?:\u4e00\u6761|\u4e00\u7bc7)?(?:.{0,12})?\u53d1(?:\u5230)?)(?:.{0,12})?(?:(?:qq\s*)?\u7a7a\u95f4|\u8bf4\u8bf4|qzone)/i.test(input)
    || /(?:(?:qq\s*)?\u7a7a\u95f4|\u8bf4\u8bf4|qzone)(?:.{0,8})?(?:\u53d1|\u53d1\u5e03)/i.test(input);
}

function detectQqActionIntent(cleanText = '', imageUrl = null) {
  const text = String(cleanText || '').trim();
  if (!text || imageUrl) return null;

  if (/(查看|列出|显示|看看|查询).{0,8}(当前|本群|定时|任务|计划任务|定时任务)/i.test(text)
    || /(定时任务|计划任务).{0,8}(列表|清单|情况)/i.test(text)) {
    return {
      key: 'qq_list_scheduled',
      allowedTools: ['list_scheduled_tasks'],
      reason: 'qq-list-scheduled',
      toolNeed: ['local-read'],
      executionMode: 'staged',
      responseIntent: 'action_guidance'
    };
  }

  if (/(取消|停止|撤销).{0,8}(定时|任务)/i.test(text)
    || /(删除|删掉|移除).{0,8}(定时|任务)/i.test(text)) {
    return {
      key: 'qq_cancel_scheduled',
      allowedTools: ['cancel_scheduled_task', 'delete_scheduled_task', 'list_scheduled_tasks'],
      reason: 'qq-cancel-scheduled',
      toolNeed: ['local-write'],
      executionMode: 'staged',
      responseIntent: 'action_guidance'
    };
  }

  if (/(閺屻儳婀厊閸掓鍤瓅閺勫墽銇殀閻婀厊閺屻儴顕梶\u67e5\u770b|\u5217\u51fa|\u663e\u793a|\u770b\u770b|\u67e5\u8be2).{0,8}(鐎规碍妞倈娴犺濮焲鐠佲€冲灊娴犺濮焲\u5b9a\u65f6|\u4efb\u52a1|\u8ba1\u5212\u4efb\u52a1)/i.test(text) || /(鐎规碍妞傛禒璇插|\u5b9a\u65f6\u4efb\u52a1).{0,8}(閸掓銆億濞撳懎宕焲閹懎鍠寍\u5217\u8868|\u6e05\u5355|\u60c5\u51b5)/i.test(text)) {
    return {
      key: 'qq_list_scheduled',
      allowedTools: ['list_scheduled_tasks'],
      reason: 'qq-list-scheduled',
      toolNeed: ['local-read'],
      executionMode: 'staged',
      responseIntent: 'action_guidance'
    };
  }

  if (/(閸欐牗绉穦閸嬫粍顒泑閹俱倝鏀\u53d6\u6d88|\u505c\u6b62|\u64a4\u9500).{0,8}(鐎规碍妞倈娴犺濮焲\u5b9a\u65f6|\u4efb\u52a1)/i.test(text) || /(閸掔娀娅巪閸掔姵甯€|缁夊娅巪\u5220\u9664|\u5220\u6389|\u79fb\u9664).{0,8}(鐎规碍妞倈娴犺濮焲\u5b9a\u65f6|\u4efb\u52a1)/i.test(text)) {
    return {
      key: 'qq_cancel_scheduled',
      allowedTools: ['cancel_scheduled_task', 'delete_scheduled_task', 'list_scheduled_tasks'],
      reason: 'qq-cancel-scheduled',
      toolNeed: ['local-write'],
      executionMode: 'staged',
      responseIntent: 'action_guidance'
    };
  }

  if (hasScheduleSignal(text)) {
    if (hasQzoneTarget(text)) {
      return {
        key: 'qq_schedule_qzone',
        allowedTools: ['create_qzone_auto_task', 'create_scheduled_command'],
        reason: 'qq-schedule-qzone',
        toolNeed: ['local-write'],
        executionMode: 'staged',
        responseIntent: 'action_guidance'
      };
    }

    if (hasGroupMessageTarget(text)) {
      return {
        key: 'qq_schedule_message',
        allowedTools: ['schedule_group_message', 'create_scheduled_command'],
        reason: 'qq-schedule-message',
        toolNeed: ['local-write'],
        executionMode: 'staged',
        responseIntent: 'action_guidance'
      };
    }
  }

  if (hasQzonePublishSignal(text)) {
    return {
      key: 'qq_publish_qzone',
      allowedTools: ['qzone_draft'],
      reason: 'qq-publish-qzone',
      toolNeed: ['local-write'],
      executionMode: 'staged',
      responseIntent: 'action_guidance'
    };
  }

  return null;
}

function extractImageUrl(rawText = '') {
  const imgMatch = String(rawText).match(/\[CQ:image,.*?url=([^,\]]+).*?\]/);
  if (!imgMatch) return null;
  return imgMatch[1].replace(/&amp;/g, '&');
}

function resolveQuotePriorityMeta(directedContext = null) {
  const quotePriority = directedContext?.quotePriority && typeof directedContext.quotePriority === 'object'
    ? directedContext.quotePriority
    : null;
  return quotePriority
    ? {
        enabled: quotePriority.enabled === true,
        mode: String(quotePriority.mode || 'none').trim() || 'none',
        reason: String(quotePriority.reason || '').trim(),
        quoteAnchoredText: String(quotePriority.quoteAnchoredText || '').trim(),
        quoteFocus: quotePriority.quoteFocus && typeof quotePriority.quoteFocus === 'object'
          ? {
              text: String(quotePriority.quoteFocus.text || '').trim(),
              hasImage: quotePriority.quoteFocus.hasImage === true,
              senderName: String(quotePriority.quoteFocus.senderName || '').trim(),
              origin: String(quotePriority.quoteFocus.origin || '').trim()
            }
          : null
      }
    : {
        enabled: false,
        mode: 'none',
        reason: '',
        quoteAnchoredText: '',
        quoteFocus: null
      };
}

function resolveIntentInputs({ rawText = '', botQQ = '', directedContext = null, effectiveIntentText = '' } = {}) {
  const imageUrl = extractImageUrl(rawText);
  const cleanText = cleanMessageText(rawText, botQQ);
  const quotePriority = resolveQuotePriorityMeta(directedContext);
  const intentText = String(effectiveIntentText || quotePriority.quoteAnchoredText || cleanText).trim();
  return {
    imageUrl,
    cleanText,
    intentText,
    quotePriority
  };
}

function cleanMessageText(rawText = '', botQQ = '') {
  return String(rawText)
    .replace(/\[CQ:reply,.*?\]/g, '')
    .replace(new RegExp(`\\[CQ:at,qq=${botQQ}\\]`, 'g'), '')
    .replace(/\[CQ:image,.*?\]/g, '')
    .replace(/\[CQ:json,.*?\]/g, '')
    .replace(/\[CQ:forward,.*?\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isAtBot(rawText = '', botQQ = '') {
  return String(rawText).includes(`[CQ:at,qq=${botQQ}]`);
}

function isAdmin(userId) {
  return ADMIN_USER_IDS.has(String(userId));
}

function getLocalRouteUserRole(userId = '') {
  return isAdmin(userId) ? 'admin' : 'user';
}

function shouldUseSubagentByWhitelist(userId) {
  return isAdmin(userId);
}

function shouldBypassRouteRefuse(userId, options = {}) {
  const normalizedUserId = String(userId || '').trim();
  if (REFUSE_BYPASS_USER_IDS.has(normalizedUserId)) return true;
  return isPrivilegedPrivateChatUser({
    chatType: options?.chatType,
    userId: normalizedUserId,
    config
  });
}

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

function shouldPreferToolAssistance(text = '', imageUrl = null) {
  const t = String(text || '').trim();
  if (!t || imageUrl) return false;
  if (isSimpleTransformTask(t, imageUrl)) return false;
  if (isSelfContainedProductivityPlan(t)) return false;
  return /(search|look up|find|google|latest|news|official|docs?|documentation|source|link|links|log|logs|history|timeline|remember|recall|earlier|previous|before|web|website|\u641c\u7d22|\u67e5\u4e00\u4e0b|\u67e5\u67e5|\u5e2e\u6211\u67e5|\u7f51\u9875|\u5b98\u7f51|\u94fe\u63a5|\u8d44\u6599|\u6587\u6863|\u65e5\u5fd7|\u8bb0\u5f55|\u4e4b\u524d|\u6628\u5929|\u524d\u51e0\u5929|\u8bb0\u5f97|\u8bb0\u4e0d\u8bb0\u5f97|\u56de\u5fc6|\u53d1\u8fc7|\u56fe|\u56fe\u7247)/i.test(t);
}

function buildPreferredToolRoute({
  confidence = 0.86,
  cleanText = '',
  rawText = '',
  imageUrl = null,
  reason = 'prefer-tool-assistance',
  sourceScope = 'mixed',
  toolNeed = ['mixed'],
  needsMemory = false,
  freshness = 'unknown',
  allowedTools = undefined
} = {}) {
  return makeRoute({
    confidence,
    cleanText,
    rawText,
    imageUrl,
    topRouteType: 'direct_chat',
    intent: { risk: 'low', toolNeed, executionMode: 'staged', needsPlanning: false, needsMemory },
    facets: { modality: 'text', sourceScope, domain: needsMemory ? 'personal' : 'general', outputKind: 'answer', freshness },
    meta: { reason, allowedTools, chatMode: 'text_chat', toolIntent: 'maybe_tools', responseIntent: 'answer' }
  });
}

function isSimpleTransformTask(text = '', imageUrl = null) {
  const t = String(text || '').trim();
  if (!t || imageUrl) return false;
  if (!/(总结|摘要|概括|提炼|梳理|改写|润色|翻译|简化|压缩|rewrite|rephrase|summari[sz]e|summary|translate)/i.test(t)) return false;
  if (shouldUseToolBackedSummary(t)) return false;
  return hasInlineContentForTransform(t);
}

function getStrongFallbackPolicyKeys(route = {}) {
  const contract = buildCanonicalRouteContract(route);
  if (contract.topRouteType === 'ignore') return ['ignore/default'];
  if (contract.topRouteType === 'refuse') return ['refuse/default'];
  if (contract.topRouteType === 'admin') return ['admin/default'];
  return [];
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

function makeRoute({
  confidence = 0,
  cleanText = '',
  rawText = '',
  imageUrl = null,
  meta = {},
  intent = null,
  facets = null,
  topRouteType = null
} = {}) {
  const normalizedTopRouteType = sanitizeTopRouteType(topRouteType || 'direct_chat');
  const normalizedIntent = normalizeIntent(intent);
  const normalizedFacets = normalizeFacets(facets, {}, imageUrl);
  const normalizedMeta = meta && typeof meta === 'object' ? { ...meta } : {};
  normalizedMeta.chatMode = normalizeChatMode(
    normalizedMeta.chatMode,
    imageUrl ? (normalizedFacets.outputKind === 'summary' ? 'image_summary' : 'image_qa') : 'text_chat'
  );
  normalizedMeta.toolIntent = normalizeToolIntent(
    normalizedMeta.toolIntent,
    normalizedIntent.toolNeed.some((item) => item !== 'none') ? 'maybe_tools' : 'none'
  );
  normalizedMeta.responseIntent = normalizeResponseIntent(
    normalizedMeta.responseIntent,
    normalizedFacets.outputKind === 'summary' || normalizedFacets.outputKind === 'rewrite' || normalizedFacets.outputKind === 'quiz'
      ? 'summary'
      : normalizedFacets.outputKind === 'plan' || normalizedFacets.outputKind === 'report'
        ? 'plan'
        : normalizedFacets.outputKind === 'action'
          ? 'action_guidance'
          : 'answer'
  );

  return {
    confidence,
    cleanText,
    rawText,
    imageUrl,
    meta: normalizedMeta,
    topRouteType: normalizedTopRouteType,
    intent: normalizedIntent,
    facets: normalizedFacets
  };
}

function buildRefuseRoute({ cleanText = '', rawText = '', imageUrl = null, reason = 'bad-faith-request' } = {}) {
  return makeRoute({
    confidence: 0.99,
    cleanText,
    rawText,
    imageUrl,
    topRouteType: 'refuse',
    intent: { risk: 'high', toolNeed: ['none'], executionMode: 'immediate', needsPlanning: false, needsMemory: false },
    facets: { modality: imageUrl ? 'image' : 'text', sourceScope: 'none', domain: 'general', outputKind: 'answer', freshness: 'unknown' },
    meta: { reason }
  });
}

function shouldIgnoreUnsafeOrBadFaithRequest(text = '') {
  const t = String(text || '').trim();
  if (!t) return { matched: false };

  const harmfulDecision = detectExplicitHarmfulRequest(t);
  if (harmfulDecision.matched) return harmfulDecision;

  const badFaithDecision = detectExplicitBadFaithRequest(t);
  if (badFaithDecision.matched) return badFaithDecision;

  return { matched: false };
}

function resolveLocalRuleId(route = {}) {
  const routeMeta = route?.meta && typeof route.meta === 'object' ? route.meta : {};
  const existingRuleId = String(routeMeta.localRuleId || '').trim();
  if (existingRuleId) return existingRuleId;

  const topRouteType = sanitizeTopRouteType(route?.topRouteType || '');
  if (topRouteType === 'ignore') return 'empty-message';
  if (topRouteType === 'refuse') return 'refuse-local-policy';
  if (topRouteType === 'admin') return 'admin-command';
  if (String(routeMeta.qqActionKey || '').trim()) return 'qq-action';
  if (
    String(routeMeta.responseIntent || '').trim() === 'action_guidance'
    || String(routeMeta.toolIntent || '').trim() === 'force_tools'
  ) {
    return 'explicit-action';
  }
  return 'direct-chat';
}

function markLocalRuleRoute(route = {}, userId = '') {
  const routeMeta = route?.meta && typeof route.meta === 'object' ? route.meta : {};
  return {
    ...route,
    meta: {
      ...routeMeta,
      routeSource: LOCAL_ROUTE_SOURCE,
      localRuleId: resolveLocalRuleId(route),
      userRole: getLocalRouteUserRole(userId)
    }
  };
}

function matchTerminalLocalRoute({ rawText = '', cleanText = '', imageUrl = null, userId = '', chatType = '' }) {
  const bypassRouteRefuse = shouldBypassRouteRefuse(userId, { chatType });

  if (!cleanText && !imageUrl) {
    return makeRoute({
      confidence: 1,
      cleanText,
      rawText,
      imageUrl,
      topRouteType: 'ignore'
    });
  }

  const ignoreDecision = shouldIgnoreUnsafeOrBadFaithRequest(cleanText);
  if (ignoreDecision.matched && !bypassRouteRefuse) {
    return buildRefuseRoute({ cleanText, rawText, imageUrl, reason: ignoreDecision.reason });
  }

  const adminCmd = parseAdminCommand(cleanText);
  if (adminCmd) {
    if (adminCmd.cmd === 'meme' && !isAdmin(userId)) {
      return makeRoute({
        confidence: 1,
        cleanText,
        rawText,
        imageUrl,
        topRouteType: 'admin',
        intent: { risk: 'low', toolNeed: ['none'], executionMode: 'staged', needsPlanning: false, needsMemory: false },
        facets: { modality: 'text', sourceScope: 'none', domain: 'admin', outputKind: 'action', freshness: 'unknown' },
        meta: { admin: false, command: adminCmd }
      });
    }
    if (
      adminCmd.cmd === 'full'
      || adminCmd.cmd === 'claude'
      || adminCmd.cmd === 'claude-open'
      || adminCmd.cmd === 'claude-send'
      || adminCmd.cmd === 'claude-tail'
      || adminCmd.cmd === 'claude-stop'
    ) {
      return makeRoute({
        confidence: 1,
        cleanText,
        rawText,
        imageUrl,
        topRouteType: 'admin',
        intent: {
          risk: 'high',
          toolNeed: ['local-write'],
          executionMode: 'delegated',
          needsPlanning: true,
          needsMemory: false
        },
        facets: { modality: 'text', sourceScope: 'mixed', domain: 'admin', outputKind: 'action', freshness: 'unknown' },
        meta: {
          admin: isAdmin(userId),
          command: adminCmd,
          toolIntent: 'force_tools',
          responseIntent: 'action_guidance'
        }
      });
    }
    if (isAdmin(userId)) {
      return makeRoute({
        confidence: 1,
        cleanText,
        rawText,
        imageUrl,
        topRouteType: 'admin',
        intent: { risk: 'high', toolNeed: ['none'], executionMode: 'staged', needsPlanning: false, needsMemory: false },
        facets: { modality: 'text', sourceScope: 'none', domain: 'admin', outputKind: 'action', freshness: 'unknown' },
        meta: { admin: true, command: adminCmd }
      });
    }
    return makeRoute({
      confidence: 0.55,
      cleanText,
      rawText,
      imageUrl,
      topRouteType: 'admin',
      intent: { risk: 'low', toolNeed: ['none'], executionMode: 'immediate', needsPlanning: false, needsMemory: false },
      facets: { modality: 'text', sourceScope: 'none', domain: 'admin', outputKind: 'action', freshness: 'unknown' },
      meta: { admin: false, command: adminCmd }
    });
  }

  return null;
}

function matchActionLocalRoute({ rawText = '', cleanText = '', imageUrl = null, userId = '' }) {
  const qqActionIntent = detectQqActionIntent(cleanText, imageUrl);
  if (qqActionIntent) {
    const adjustedAllowedTools = (() => {
      const requested = Array.isArray(qqActionIntent.allowedTools) ? qqActionIntent.allowedTools.slice() : [];
      if (qqActionIntent.key === 'qq_publish_qzone' && !isAdmin(userId)) return [];
      if (qqActionIntent.key === 'qq_schedule_qzone' && !isAdmin(userId)) return [];
      return requested;
    })();
    return makeRoute({
      confidence: 0.96,
      cleanText,
      rawText,
      imageUrl,
      topRouteType: 'direct_chat',
      intent: {
        risk: 'medium',
        toolNeed: qqActionIntent.toolNeed,
        executionMode: qqActionIntent.executionMode,
        needsPlanning: false,
        needsMemory: false
      },
      facets: {
        modality: 'text',
        sourceScope: 'none',
        domain: 'general',
        outputKind: 'action',
        freshness: 'unknown'
      },
      meta: {
        reason: qqActionIntent.reason,
        localRuleId: 'qq-action',
        qqActionKey: qqActionIntent.key,
        allowedTools: adjustedAllowedTools,
        chatMode: 'text_chat',
        toolIntent: 'force_tools',
        responseIntent: qqActionIntent.responseIntent
      }
    });
  }

  return null;
}

function matchLegacyFineDirectLocalRoute({ rawText = '', cleanText = '', imageUrl = null }) {
  // Direct local rules: light heuristics for common chat/tool/vision intents.
  if (
    !imageUrl &&
    /(\bhow\b|\bwhat\b|\bwhich\b|\bwhere\b|\bhelp\b|\bcan you\b|\u600e\u4e48|\u54ea\u4e2a|\u54ea\u91cc|\u4ec0\u4e48|\u8fd9\u4e2a|\u90a3\u4e2a|\u600e\u4e48\u5f04|\u5e2e\u6211\u770b\u770b)/i.test(cleanText) &&
    !/(https?:\/\/|www\.|\u7f51\u9875|\u94fe\u63a5|\u6587\u7ae0|\u89c6\u9891|\u6587\u4ef6|\u7b14\u8bb0|notebook|notes?)/i.test(cleanText) &&
    !/(remember|recall|earlier|previous|before|history|timeline|log|logs|\u8bb0\u5f97|\u8bb0\u4e0d\u8bb0\u5f97|\u4e4b\u524d|\u6628\u5929|\u524d\u51e0\u5929|\u56de\u5fc6|\u8bb0\u5f55|\u53d1\u8fc7|\u56fe|\u56fe\u7247)/i.test(cleanText) &&
    !/[\u3002\uff01\uff1f.!?]\s*.+/.test(cleanText) &&
    String(cleanText || '').trim().length <= 24 &&
    !/(\u8ba1\u5212|\u603b\u7ed3|\u6458\u8981|\u6982\u62ec|\u63d0\u70bc|\u6539\u5199|\u7ffb\u8bd1|\u90ae\u4ef6|\u5f85\u529e|\u8bae\u7a0b|\u90e8\u7f72|\u5b89\u88c5|\u4fee\u6539|\u5199\u5165)/i.test(cleanText) &&
    !shouldPreferToolAssistance(cleanText, imageUrl)
  ) {
    return makeRoute({
      confidence: 0.9,
      cleanText,
      rawText,
      imageUrl,
      topRouteType: 'direct_chat',
      intent: { risk: 'low', toolNeed: ['none'], executionMode: 'staged', needsPlanning: false, needsMemory: false },
      facets: { modality: 'text', sourceScope: 'none', domain: 'general', outputKind: 'answer', freshness: 'unknown' },
      meta: { reason: 'short-implicit-question', chatMode: 'text_chat', toolIntent: 'none', responseIntent: 'answer' }
    });
  }

  if (shouldPreferToolAssistance(cleanText, imageUrl)) {
    const prefersMemory = /(remember|recall|earlier|previous|before|history|timeline|log|logs|\u8bb0\u5f97|\u8bb0\u4e0d\u8bb0\u5f97|\u4e4b\u524d|\u6628\u5929|\u524d\u51e0\u5929|\u56de\u5fc6|\u8bb0\u5f55|\u53d1\u8fc7|\u56fe|\u56fe\u7247)/i.test(cleanText);
    const prefersWeb = /(search|look up|find|google|latest|news|official|docs?|documentation|source|link|links|web|website|\u641c\u7d22|\u67e5\u4e00\u4e0b|\u67e5\u67e5|\u5e2e\u6211\u67e5|\u7f51\u9875|\u5b98\u7f51|\u94fe\u63a5|\u8d44\u6599|\u6587\u6863)/i.test(cleanText);
    return buildPreferredToolRoute({
      confidence: prefersMemory && prefersWeb ? 0.9 : 0.86,
      cleanText,
      rawText,
      imageUrl,
      reason: prefersMemory ? 'recall-needs-tool-assistance' : 'search-needs-tool-assistance',
      sourceScope: prefersMemory && prefersWeb ? 'mixed' : (prefersMemory ? 'notebook' : 'web'),
      toolNeed: prefersMemory && prefersWeb ? ['mixed'] : (prefersMemory ? ['local-read'] : ['web']),
      needsMemory: prefersMemory,
      freshness: prefersWeb ? 'latest' : 'unknown',
      allowedTools: prefersMemory ? ['notebook_search', 'notebook_list_docs'] : undefined
    });
  }

  if (imageUrl && /(总结|提炼|概括|描述|解释|summari[sz]e|describe|explain|这张图|图片)/i.test(cleanText)) {
    return makeRoute({
      confidence: 0.92,
      cleanText,
      rawText,
      imageUrl,
      topRouteType: 'direct_chat',
      intent: { risk: 'low', toolNeed: ['image'], executionMode: 'staged', needsPlanning: false, needsMemory: false },
      facets: { modality: 'image', sourceScope: 'vision', domain: 'general', outputKind: 'summary', freshness: 'unknown' },
      meta: { reason: 'image-summary-first', chatMode: 'image_summary', toolIntent: 'maybe_tools', responseIntent: 'summary' }
    });
  }

  if (imageUrl && (!cleanText || /(image|photo|picture|look at this|what is in this|analyze this image|这张图|图片里|看图)/i.test(cleanText))) {
    return makeRoute({
      confidence: 0.95,
      cleanText,
      rawText,
      imageUrl,
      topRouteType: 'direct_chat',
      intent: { risk: 'low', toolNeed: ['image'], executionMode: 'immediate', needsPlanning: false, needsMemory: false },
      facets: { modality: 'image', sourceScope: 'vision', domain: 'general', outputKind: 'answer', freshness: 'unknown' },
      meta: { reason: 'image-answer-first', chatMode: 'image_qa', toolIntent: 'none', responseIntent: 'answer' }
    });
  }

  if (hasExplicitActSignal(cleanText)) {
    return makeRoute({
      confidence: 0.9,
      cleanText,
      rawText,
      imageUrl,
      topRouteType: 'direct_chat',
      intent: { risk: 'medium', toolNeed: ['local-write'], executionMode: 'delegated', needsPlanning: true, needsMemory: false },
      facets: { modality: imageUrl ? 'mixed' : 'text', sourceScope: 'mixed', domain: 'general', outputKind: 'action', freshness: 'unknown' },
      meta: { reason: 'explicit-act', chatMode: imageUrl ? 'image_qa' : 'text_chat', toolIntent: 'force_tools', responseIntent: 'action_guidance' }
    });
  }

  if (isSelfContainedProductivityPlan(cleanText)) {
    return makeRoute({
      confidence: 0.88,
      cleanText,
      rawText,
      imageUrl,
      topRouteType: 'direct_chat',
      intent: { risk: 'low', toolNeed: ['none'], executionMode: 'staged', needsPlanning: true, needsMemory: false },
      facets: { modality: 'text', sourceScope: 'none', domain: 'general', outputKind: 'plan', freshness: 'unknown' },
      meta: { reason: 'explicit-plan', chatMode: 'text_chat', toolIntent: 'none', responseIntent: 'plan' }
    });
  }

  if (/(plan|planning|todo|task|agenda|schedule|roadmap|weekly study plan|璁″垝|寰呭姙|璁▼|鎷嗚В)/i.test(cleanText)) {
    const isResearch = /(research|paper|literature|experiment|鐮旂┒|璁烘枃|鏂囩尞|瀹為獙)/i.test(cleanText);
    const textOnlyPlan = !isResearch && isTextOnlyPlanRequest(cleanText);
    return makeRoute({
      confidence: 0.86,
      cleanText,
      rawText,
      imageUrl,
      topRouteType: 'direct_chat',
      intent: { risk: 'low', toolNeed: [isResearch ? 'web' : (textOnlyPlan ? 'none' : 'mixed')], executionMode: 'staged', needsPlanning: true, needsMemory: false },
      facets: { modality: 'text', sourceScope: isResearch ? 'web' : (textOnlyPlan ? 'none' : 'mixed'), domain: isResearch ? 'research' : 'general', outputKind: isResearch ? 'report' : 'plan', freshness: isResearch ? 'latest' : 'unknown' },
      meta: { reason: 'explicit-plan', chatMode: 'text_chat', toolIntent: textOnlyPlan ? 'none' : 'force_tools', responseIntent: 'plan' }
    });
  }

  if (/(鐜板湪鍑犵偣|鍑犵偣浜唡褰撳墠鏃堕棿|鍖椾含鏃堕棿|time now)/i.test(cleanText)) {
    return makeRoute({
      confidence: 0.9,
      cleanText,
      rawText,
      imageUrl,
      topRouteType: 'direct_chat',
      intent: { risk: 'low', toolNeed: ['none'], executionMode: 'staged', needsPlanning: false, needsMemory: false },
      facets: { modality: 'text', sourceScope: 'none', domain: 'time', outputKind: 'answer', freshness: 'timeless' },
      meta: { reason: 'explicit-time', chatMode: 'text_chat', toolIntent: 'none', responseIntent: 'answer' }
    });
  }

  if (
    !imageUrl &&
    /(\u603b\u7ed3|\u6458\u8981|\u6982\u62ec|\u63d0\u70bc|summari[sz]e|summary|recap|outline)/i.test(cleanText) &&
    shouldUseToolBackedSummary(cleanText)
  ) {
    return makeRoute({
      confidence: 0.9,
      cleanText,
      rawText,
      imageUrl,
      topRouteType: 'direct_chat',
      intent: { risk: 'low', toolNeed: ['web'], executionMode: 'staged', needsPlanning: false, needsMemory: false },
      facets: { modality: 'text', sourceScope: 'web', domain: 'general', outputKind: 'summary', freshness: 'unknown' },
      meta: { reason: 'explicit-web-summary', chatMode: 'text_chat', toolIntent: 'force_tools', responseIntent: 'summary' }
    });
  }

  if (isSimpleTransformTask(cleanText, imageUrl)) {
    return makeRoute({
      confidence: 0.86,
      cleanText,
      rawText,
      imageUrl,
      topRouteType: 'direct_chat',
      intent: { risk: 'low', toolNeed: ['none'], executionMode: 'staged', needsPlanning: false, needsMemory: false },
      facets: {
        modality: 'text',
        sourceScope: 'none',
        domain: 'general',
        outputKind: /(\u6539\u5199|\u6da6\u8272|rewrite|rephrase)/i.test(cleanText) ? 'rewrite' : 'summary',
        freshness: 'unknown'
      },
      meta: { reason: 'explicit-transform', chatMode: 'text_chat', toolIntent: 'none', responseIntent: 'summary' }
    });
  }

  const placeScore = Math.max(scorePlaceIntent(cleanText), scoreByAliases(cleanText, INTENT_ALIASES.place));
  const weatherScore = scoreByAliases(cleanText, INTENT_ALIASES.weather);
  const notebookScore = scoreNotebookIntent(cleanText);
  const searchScore = scoreSearchIntent(cleanText);
  const stockScore = scoreStockIntent(cleanText);
  const researchScore = scoreResearchIntent(cleanText);
  const productivityScore = scoreProductivityIntent(cleanText);
  const summarizeScore = scoreSummarizeIntent(cleanText, imageUrl);
  const quizScore = scoreByAliases(cleanText, INTENT_ALIASES.quiz);

  if (productivityScore >= 0.45 && researchScore < productivityScore && isSelfContainedProductivityPlan(cleanText)) {
    return makeRoute({
      confidence: productivityScore,
      cleanText,
      rawText,
      imageUrl,
      topRouteType: 'direct_chat',
      intent: { risk: 'low', toolNeed: ['none'], executionMode: 'staged', needsPlanning: true, needsMemory: false },
      facets: { modality: 'text', sourceScope: 'none', domain: 'general', outputKind: 'plan', freshness: 'unknown' },
      meta: { reason: 'scored-plan', chatMode: 'text_chat', toolIntent: 'none', responseIntent: 'plan' }
    });
  }

  if (summarizeScore >= 0.45 && quizScore < 0.45 && notebookScore < 0.48 && isSimpleTransformTask(cleanText, imageUrl)) {
    return makeRoute({
      confidence: summarizeScore,
      cleanText,
      rawText,
      imageUrl,
      topRouteType: 'direct_chat',
      intent: { risk: 'low', toolNeed: ['none'], executionMode: 'staged', needsPlanning: false, needsMemory: false },
      facets: {
        modality: 'text',
        sourceScope: 'none',
        domain: 'general',
        outputKind: /(\u6539\u5199|\u6da6\u8272|rewrite|rephrase)/i.test(cleanText) ? 'rewrite' : 'summary',
        freshness: 'unknown'
      },
      meta: { reason: 'scored-transform', chatMode: 'text_chat', toolIntent: 'none', responseIntent: 'summary' }
    });
  }

  if (researchScore >= 0.45 || productivityScore >= 0.45) {
    const isResearch = researchScore >= productivityScore;
    const textOnlyPlan = !isResearch && isTextOnlyPlanRequest(cleanText);
    return makeRoute({
      confidence: Math.max(researchScore, productivityScore),
      cleanText,
      rawText,
      imageUrl,
      topRouteType: 'direct_chat',
      intent: { risk: 'low', toolNeed: [isResearch ? 'web' : (textOnlyPlan ? 'none' : 'mixed')], executionMode: 'staged', needsPlanning: true, needsMemory: false },
      facets: { modality: 'text', sourceScope: isResearch ? 'web' : (textOnlyPlan ? 'none' : 'mixed'), domain: isResearch ? 'research' : 'general', outputKind: isResearch ? 'report' : 'plan', freshness: isResearch ? 'latest' : 'unknown' },
      meta: { reason: 'scored-plan', chatMode: 'text_chat', toolIntent: textOnlyPlan ? 'none' : 'force_tools', responseIntent: 'plan' }
    });
  }

  if (quizScore >= 0.45 || summarizeScore >= 0.45) {
    const useQuiz = quizScore >= summarizeScore;
    const useNotebook = notebookScore >= 0.48;
    return makeRoute({
      confidence: Math.max(quizScore, summarizeScore),
      cleanText,
      rawText,
      imageUrl,
      topRouteType: 'direct_chat',
      intent: { risk: 'low', toolNeed: [imageUrl ? 'image' : (useQuiz ? 'mixed' : (useNotebook ? 'local-read' : 'web'))], executionMode: 'staged', needsPlanning: false, needsMemory: useNotebook },
      facets: {
        modality: imageUrl ? 'image' : 'text',
        sourceScope: useNotebook ? 'notebook' : (imageUrl ? 'vision' : 'web'),
        domain: useQuiz ? 'study' : (useNotebook ? 'personal' : 'general'),
        outputKind: useQuiz ? 'quiz' : 'summary',
        freshness: 'unknown'
      },
      meta: { reason: 'scored-transform', chatMode: imageUrl ? 'image_summary' : 'text_chat', toolIntent: 'maybe_tools', responseIntent: 'summary' }
    });
  }

  const lookupScore = Math.max(placeScore, weatherScore, notebookScore, searchScore, stockScore);
  if (lookupScore >= 0.45) {
    const domain = stockScore >= Math.max(placeScore, weatherScore, notebookScore, searchScore)
      ? 'finance'
      : placeScore >= Math.max(weatherScore, notebookScore, searchScore)
        ? 'location'
        : weatherScore >= Math.max(notebookScore, searchScore)
          ? 'weather'
          : notebookScore >= searchScore
            ? 'personal'
            : 'general';

    const sourceScope = domain === 'personal'
      ? 'notebook'
      : domain === 'weather' || /(latest|news|docs?|source|官网|最新)/i.test(cleanText)
        ? 'live'
        : 'web';
    const toolNeed = domain === 'personal' ? ['local-read'] : (imageUrl ? ['image'] : ['web']);
    const allowedTools = domain === 'personal'
      ? ['notebook_search', 'notebook_list_docs']
      : undefined;

    return makeRoute({
      confidence: lookupScore,
      cleanText,
      rawText,
      imageUrl,
      topRouteType: 'direct_chat',
      intent: { risk: 'low', toolNeed, executionMode: 'staged', needsPlanning: false, needsMemory: domain === 'personal' },
      facets: {
        modality: imageUrl ? 'image' : 'text',
        sourceScope: imageUrl ? 'vision' : sourceScope,
        domain,
        outputKind: 'answer',
        freshness: domain === 'weather' || domain === 'finance' || sourceScope === 'live' ? 'latest' : 'unknown'
      },
      meta: {
        reason: 'scored-lookup',
        allowedTools,
        chatMode: imageUrl ? 'image_qa' : 'text_chat',
        toolIntent: 'maybe_tools',
        responseIntent: 'answer'
      }
    });
  }

  // Default local rule: ordinary chat.
  return makeRoute({
    confidence: imageUrl ? 0.72 : 0.6,
    cleanText,
    rawText,
    imageUrl,
    topRouteType: 'direct_chat',
    meta: { chatMode: imageUrl ? 'image_qa' : 'text_chat', toolIntent: 'none', responseIntent: 'answer' }
  });
}

function extractDirectRouteSignals(cleanText = '', imageUrl = null) {
  const text = String(cleanText || '').trim();
  const hasImage = Boolean(imageUrl);
  const isExplicitAction = hasExplicitActSignal(text);
  const hasSafetyBoundary = detectSafetyBoundaryCaution(text);
  const isStrictTime = isStrictTimeDirectQuestion(text);
  const recapQuery = !hasImage && isRecentRecallQuery(text);
  const needsMemory = !hasImage && (recapQuery || /(remember|recall|earlier|previous|before|history|timeline|log|logs|my notes|my notebook|notes about|我的资料|我的笔记|之前记录|之前记过|知识库|笔记|记得|记不记得|之前|昨天|前几天|回忆|记录|发过|图|图片)/i.test(text));
  const needsFreshInfo = !isStrictTime && !hasImage && !recapQuery && (
    shouldUseToolBackedSummary(text)
    || /(search|look up|find|google|latest|news|official|docs?|documentation|source|link|links|web|website|weather|stock|stocks|ticker|shares|portfolio|fund|crypto|etf|搜索|查一下|查查|帮我查|网页|官网|链接|资料|文档|最新|新闻|来源|实时|当前|今天|天气|气温|下雨|温度|股票|股价|行情|财报|基金|币圈)/i.test(text)
  );
  const isTransformLike = hasImage
    ? /(总结|提炼|概括|描述|解释|summari[sz]e|describe|explain|这张图|图片)/i.test(text)
    : /(总结|摘要|概括|提炼|梳理|改写|润色|翻译|简化|压缩|summari[sz]e|summary|recap|outline|rewrite|rephrase|translate)/i.test(text);
  const isPlanLike = !isExplicitAction && (
    isSelfContainedProductivityPlan(text)
    || isTextOnlyPlanRequest(text)
    || /(plan|planning|todo|task|agenda|roadmap|proposal|strategy|step by step|计划|待办|议程|拆解|规划|方案|步骤|怎么做|如何做)/i.test(text)
  );
  const needsTools = isExplicitAction || needsMemory || needsFreshInfo;
  return {
    hasImage,
    needsTools,
    needsMemory,
    needsFreshInfo,
    isTransformLike,
    isPlanLike,
    isExplicitAction,
    hasSafetyBoundary,
    recapQuery
  };
}

function buildDirectRouteFromSignals({ rawText = '', cleanText = '', imageUrl = null, signals = null } = {}) {
  const s = signals || extractDirectRouteSignals(cleanText, imageUrl);
  const chatMode = s.hasImage
    ? (s.isTransformLike ? 'image_summary' : 'image_qa')
    : 'text_chat';
  const responseIntent = s.isExplicitAction
    ? 'action_guidance'
    : s.isPlanLike
      ? 'plan'
      : s.isTransformLike
        ? 'summary'
        : 'answer';
  const sourceScope = s.isExplicitAction
    ? 'mixed'
    : s.hasImage
      ? 'vision'
      : s.recapQuery
        ? 'notebook'
      : s.needsMemory && s.needsFreshInfo
        ? 'mixed'
        : s.needsMemory
          ? 'notebook'
          : s.needsFreshInfo
            ? 'web'
            : 'none';
  const toolNeed = s.isExplicitAction
    ? ['local-write']
    : s.hasImage
      ? ['image']
      : sourceScope === 'mixed'
        ? ['mixed']
        : sourceScope === 'notebook'
          ? ['local-read']
          : sourceScope === 'web'
            ? ['web']
            : ['none'];
  const toolIntent = s.isExplicitAction
    ? 'force_tools'
    : s.needsTools || (s.hasImage && chatMode === 'image_summary')
      ? 'maybe_tools'
      : 'none';
  const outputKind = responseIntent === 'action_guidance'
    ? 'action'
    : responseIntent === 'plan'
      ? 'plan'
      : responseIntent === 'summary'
        ? 'summary'
        : 'answer';
  const allowedTools = sourceScope === 'notebook'
    ? ['notebook_search', 'notebook_list_docs']
    : undefined;

  return makeRoute({
    confidence: s.isExplicitAction || s.hasImage || s.needsTools || s.isPlanLike || s.isTransformLike ? 0.86 : 0.6,
    cleanText,
    rawText,
    imageUrl,
    topRouteType: 'direct_chat',
    intent: {
      risk: s.isExplicitAction ? 'medium' : 'low',
      toolNeed,
      executionMode: s.isExplicitAction ? 'delegated' : (s.needsTools || s.isPlanLike || s.isTransformLike ? 'staged' : 'immediate'),
      needsPlanning: s.isExplicitAction || s.isPlanLike,
      needsMemory: s.needsMemory
    },
    facets: {
      modality: s.hasImage ? 'image' : 'text',
      sourceScope,
      domain: 'general',
      outputKind,
      freshness: s.recapQuery ? 'unknown' : (s.needsFreshInfo ? 'latest' : 'unknown')
    },
    meta: {
      reason: s.isExplicitAction ? 'explicit-action' : 'direct-chat',
      localRuleId: s.isExplicitAction ? 'explicit-action' : 'direct-chat',
      ...(allowedTools ? { allowedTools } : {}),
      ...(s.hasSafetyBoundary ? { safetyBoundary: true } : {}),
      chatMode,
      toolIntent,
      responseIntent
    }
  });
}

function matchDirectLocalRoute({ rawText = '', cleanText = '', imageUrl = null }) {
  return buildDirectRouteFromSignals({
    rawText,
    cleanText,
    imageUrl,
    signals: extractDirectRouteSignals(cleanText, imageUrl)
  });
}

const LOCAL_ROUTE_RULE_GROUPS = Object.freeze([
  matchTerminalLocalRoute,
  matchActionLocalRoute,
  matchDirectLocalRoute
]);

function buildCanonicalFallbackRoute({ rawText = '', cleanText = '', imageUrl = null, userId = '', chatType = '' }) {
  const input = { rawText, cleanText, imageUrl, userId, chatType };
  for (const matchRuleGroup of LOCAL_ROUTE_RULE_GROUPS) {
    const route = matchRuleGroup(input);
    if (route) return route;
  }
  return matchDirectLocalRoute(input);
}

function isDirectRouteInvariantSatisfied(route = {}) {
  void route;
  return true;
}

function sanitizeAiMeta(aiMeta = {}, fallbackMeta = {}) {
  const rawAiMeta = aiMeta && typeof aiMeta === 'object' ? aiMeta : {};
  const nextMeta = {};
  for (const key of Object.keys(rawAiMeta)) {
    if (!AI_ROUTE_SAFE_META_KEYS.has(key)) continue;
    nextMeta[key] = rawAiMeta[key];
  }

  const fallbackToolIntent = normalizeToolIntent(fallbackMeta?.toolIntent, 'none');
  const fallbackResponseIntent = normalizeResponseIntent(fallbackMeta?.responseIntent, 'answer');
  const nextToolIntent = normalizeToolIntent(nextMeta.toolIntent, fallbackToolIntent);
  const nextResponseIntent = normalizeResponseIntent(nextMeta.responseIntent, fallbackResponseIntent);
  const fallbackIsExplicitAct = hasExplicitActSignal(fallbackMeta?.effectiveIntentText || fallbackMeta?.reason || '');
  const aiIsExplicitAct = hasExplicitActSignal(rawAiMeta?.reason || '');
  const canEscalateToForceTools = fallbackToolIntent === 'force_tools' || fallbackIsExplicitAct || aiIsExplicitAct;

  nextMeta.chatMode = normalizeChatMode(nextMeta.chatMode, normalizeChatMode(fallbackMeta?.chatMode, 'text_chat'));
  nextMeta.toolIntent = nextToolIntent === 'force_tools' && !canEscalateToForceTools
    ? fallbackToolIntent
    : nextToolIntent;
  nextMeta.responseIntent = nextResponseIntent === 'action_guidance' && !canEscalateToForceTools
    ? fallbackResponseIntent
    : nextResponseIntent;
  if (fallbackMeta?.safetyBoundary === true) {
    nextMeta.safetyBoundary = true;
  } else {
    nextMeta.safetyBoundary = nextMeta.safetyBoundary === true;
  }
  return nextMeta;
}

function sanitizeContextSummary(summary = '', maxLength = 220) {
  const text = String(summary || '')
    .replace(/\[CQ:[^\]]+\]/g, ' ')
    .replace(/\b(?:group|groupId|user|userId|session|sessionId)\s*[:=]\s*[A-Za-z0-9:_-]+\b/gi, ' ')
    .replace(/\b\d{5,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function buildRouterSubagentPrompt() {
  return [
    buildRouterStageSystemPrompt(),
    'You are an in-process direct_chat router refiner.',
    'You must only return JSON. No markdown. No explanation.',
    'Terminal routes are frozen by local authority.',
    'You may only refine a direct_chat route.',
    'Never output admin, refuse, or ignore.',
    'Never clear a safety boundary.',
    'Do not invent fields outside the canonical route shape.',
    'The output must fit this shape:',
    '{',
    '  "topRouteType": "direct_chat",',
    '  "confidence": 0.0,',
    '  "intent": {',
    '    "risk": "low|medium|high",',
    '    "toolNeed": ["none|web|local-read|local-write|image|mixed"],',
    '    "executionMode": "immediate|staged|delegated|background",',
    '    "needsPlanning": true,',
    '    "needsMemory": false',
    '  },',
    '  "facets": {',
    '    "modality": "text|image|mixed",',
    '    "sourceScope": "none|web|notebook|live|vision|mixed",',
    '    "domain": "general|finance|location|weather|study|music|personal|research|admin|time",',
    '    "outputKind": "answer|summary|rewrite|quiz|plan|report|action",',
    '    "freshness": "timeless|latest|unknown"',
    '  },',
    '  "meta": {',
    '    "reason": "string",',
    '    "chatMode": "text_chat|image_qa|image_summary",',
    '    "toolIntent": "none|maybe_tools|force_tools",',
    '    "responseIntent": "answer|summary|plan|action_guidance"',
    '  }',
    '}',
    'Do not output admin-only command fields, route prompts, identity fields, history, memory, or session data.'
  ].join('\n');
}

function buildRouterSubagentPayload({
  rawText = '',
  cleanText = '',
  effectiveIntentText = '',
  imageUrl = null,
  fallbackRoute = null,
  contextSummary = '',
  directedContext = null,
  requestTrace = null
} = {}) {
  const fallbackContract = buildCanonicalRouteContract(fallbackRoute || {});
  return {
    currentMessage: {
      rawText: String(rawText || '').trim(),
      cleanText: String(cleanText || '').trim(),
      effectiveIntentText: String(effectiveIntentText || cleanText || '').trim(),
      hasImage: Boolean(imageUrl),
      imageUrl: imageUrl || null
    },
    contextSummary: sanitizeContextSummary(contextSummary, 220),
    directedContext: directedContext && typeof directedContext === 'object'
      ? {
          scene: String(directedContext.scene || '').trim(),
          addressee: directedContext.addressee && typeof directedContext.addressee === 'object'
            ? {
                kind: String(directedContext.addressee.kind || '').trim(),
                userId: String(directedContext.addressee.userId || '').trim(),
                senderName: String(directedContext.addressee.senderName || '').trim(),
                confidence: Number(directedContext.addressee.confidence || 0) || 0,
                reason: String(directedContext.addressee.reason || '').trim()
              }
            : null,
          quotePriority: directedContext.quotePriority && typeof directedContext.quotePriority === 'object'
            ? resolveQuotePriorityMeta(directedContext)
            : null,
          quote: directedContext.quote && typeof directedContext.quote === 'object'
            ? {
                messageId: String(directedContext.quote.messageId || '').trim(),
                senderId: String(directedContext.quote.senderId || '').trim(),
                senderName: String(directedContext.quote.senderName || '').trim(),
                origin: String(directedContext.quote.origin || '').trim(),
                hasImage: directedContext.quote.hasImage === true,
                text: sanitizeContextSummary(directedContext.quote.text || '', 180)
              }
            : null
        }
      : null,
    localFallbackRoute: {
      topRouteType: 'direct_chat',
      confidence: Number.isFinite(Number(fallbackRoute?.confidence)) ? Number(fallbackRoute.confidence) : 0.5,
      intent: fallbackRoute?.intent || {},
      facets: fallbackRoute?.facets || {},
      meta: {
        reason: String(fallbackRoute?.meta?.reason || '').trim(),
        chatMode: fallbackContract.chatMode,
        toolIntent: fallbackContract.toolIntent,
        responseIntent: fallbackContract.responseIntent,
        safetyBoundary: fallbackRoute?.meta?.safetyBoundary === true
      }
    },
    constraints: {
      terminalRoutesFrozen: true,
      allowedTopRouteType: 'direct_chat',
      stickySafetyBoundary: fallbackRoute?.meta?.safetyBoundary === true
    }
  };
}

function validateRouterSubagentOutput(output = {}) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  if (sanitizeTopRouteType(output.topRouteType || output.type) !== 'direct_chat') return false;
  const meta = output.meta && typeof output.meta === 'object' ? output.meta : {};
  const forbiddenKeys = ['admin', 'command', 'allowedTools', 'userId', 'groupId', 'sessionId', 'history', 'memory', 'routePrompt'];
  if (forbiddenKeys.some((key) => Object.prototype.hasOwnProperty.call(meta, key))) return false;
  return true;
}

function getRouterSubagentModelConfig() {
  return {
    baseUrl: String(config.AI_ROUTER_BASE_URL || config.API_BASE_URL || '').trim(),
    apiKey: String(config.AI_ROUTER_API_KEY || config.API_KEY || '').trim(),
    model: String(config.AI_ROUTER_MODEL || config.PLAN_MODEL || config.AI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4',
    temperature: 0.1,
    maxTokens: 700,
    retries: 0,
    timeoutMs: Number(config.ROUTER_SUBAGENT_TIMEOUT_MS || config.REQUEST_TIMEOUT_MS || 8000)
  };
}

async function detectIntentBySubagent({
  rawText = '',
  cleanText = '',
  effectiveIntentText = '',
  imageUrl = null,
  fallbackRoute = null,
  contextSummary = '',
  directedContext = null
} = {}) {
  const result = await runStructuredSubagent({
    agentName: 'router',
    systemPrompt: buildRouterSubagentPrompt(),
    userPayload: buildRouterSubagentPayload({
      rawText,
      cleanText,
      effectiveIntentText,
      imageUrl,
      fallbackRoute,
      contextSummary,
      directedContext
    }),
    modelResolver: getRouterSubagentModelConfig,
    validateOutput: validateRouterSubagentOutput,
    trace: {
      ...(requestTrace && typeof requestTrace === 'object' ? requestTrace : {}),
      source: 'router',
      phase: 'router_subagent',
      purpose: 'intent_route',
      userId: String(fallbackRoute?.meta?.userId || '').trim(),
      topRouteType: 'direct_chat'
    }
  });

  if (!result.ok) return null;
  return result.output;
}

function sanitizeAiRoute(aiRoute, fallbackRoute, { userId, imageUrl }) {
  if (!aiRoute) return fallbackRoute;

  const topRouteType = sanitizeTopRouteType(aiRoute.topRouteType || aiRoute.type);
  const confidence = Number.isFinite(aiRoute.confidence) ? Math.max(0, Math.min(1, aiRoute.confidence)) : 0.5;
  if (confidence < (config.AI_ROUTER_MIN_CONFIDENCE || 0.55)) return fallbackRoute;
  const rawAiMeta = aiRoute.meta && typeof aiRoute.meta === 'object' ? aiRoute.meta : {};
  const aiToolIntent = normalizeToolIntent(rawAiMeta.toolIntent, 'none');
  if (topRouteType !== 'direct_chat') {
    return fallbackRoute;
  }
  const highRiskRoute = topRouteType === 'admin'
    || topRouteType === 'refuse'
    || aiToolIntent === 'force_tools'
    || normalizeFacets(aiRoute.facets, fallbackRoute.facets, imageUrl ?? fallbackRoute.imageUrl).outputKind === 'action';
  if (highRiskRoute && confidence < Math.max(config.AI_ROUTER_MIN_CONFIDENCE || 0.55, 0.75)) {
    return makeRoute({
      ...fallbackRoute,
      confidence: Number.isFinite(Number(fallbackRoute?.confidence)) ? Number(fallbackRoute.confidence) : 0.6,
      meta: {
        ...(fallbackRoute.meta || {}),
        fallbackReason: 'ai-router-low-confidence-high-risk'
      }
    });
  }

  // Terminal refusal remains authoritative local policy only.
  // AI router and router subagent may refine direct_chat, but must not create refuse routes.
  if (topRouteType === 'refuse') {
    return fallbackRoute;
  }

  if (sanitizeTopRouteType(fallbackRoute.topRouteType) === 'refuse') {
    return fallbackRoute;
  }

  if (topRouteType === 'admin' && !isAdmin(userId)) {
    return makeRoute({
      ...fallbackRoute,
      confidence: 0.6,
      topRouteType: 'direct_chat',
      meta: { ...(fallbackRoute.meta || {}), ai_downgraded_admin: true }
    });
  }

  const cleanText = String(fallbackRoute.cleanText || '').trim();
  const normalizedIntent = normalizeIntent(aiRoute.intent, fallbackRoute.intent);
  const normalizedFacets = normalizeFacets(aiRoute.facets, fallbackRoute.facets, imageUrl ?? fallbackRoute.imageUrl);
  const fallbackMeta = fallbackRoute.meta && typeof fallbackRoute.meta === 'object' ? fallbackRoute.meta : {};
  const aiMeta = aiRoute.meta && typeof aiRoute.meta === 'object' ? aiRoute.meta : {};
  const nextRoute = makeRoute({
    confidence,
    cleanText: cleanText || fallbackRoute.cleanText,
    rawText: fallbackRoute.rawText,
    imageUrl: imageUrl ?? fallbackRoute.imageUrl,
    topRouteType,
    intent: normalizedIntent,
    facets: normalizedFacets,
    meta: {
      ...fallbackMeta,
      ...sanitizeAiMeta(aiMeta, {
        ...fallbackMeta,
        cleanText,
        effectiveIntentText: String(fallbackMeta.effectiveIntentText || cleanText).trim()
      })
    }
  });

  if (!TOP_ROUTE_TYPE_SET.has(nextRoute.topRouteType)) return fallbackRoute;
  if (!isDirectRouteInvariantSatisfied(nextRoute)) return fallbackRoute;
  return nextRoute;
}

function detectIntent({ rawText = '', botQQ = '', userId = '', contextSummary = '', directedContext = null, effectiveIntentText = '', chatType = '' }) {
  void contextSummary;
  const {
    imageUrl,
    cleanText,
    intentText,
    quotePriority
  } = resolveIntentInputs({ rawText, botQQ, directedContext, effectiveIntentText });
  let route = buildCanonicalFallbackRoute({ rawText, cleanText: intentText, imageUrl, userId, chatType });
  route.cleanText = cleanText;
  route.rawText = rawText;
  route.meta = {
    ...(route.meta || {}),
    effectiveIntentText: intentText || cleanText,
    quotePriority
  };
  route = markLocalRuleRoute(route, userId);
  if (sanitizeTopRouteType(route?.topRouteType) !== 'direct_chat') return route;
  if (!detectSafetyBoundaryCaution(intentText)) return route;
  return markLocalRuleRoute(makeRoute({
    ...route,
    meta: {
      ...(route.meta || {}),
      safetyBoundary: true,
      effectiveIntentText: intentText || cleanText,
      quotePriority
    }
  }), userId);
}

async function detectIntentHybrid({ rawText = '', botQQ = '', userId = '', contextSummary = '', directedContext = null, effectiveIntentText = '', chatType = '' }, options = {}) {
  const fallbackRoute = detectIntent({ rawText, botQQ, userId, contextSummary, directedContext, effectiveIntentText, chatType });
  if (sanitizeTopRouteType(fallbackRoute.topRouteType) !== 'direct_chat') return fallbackRoute;
  if (!config.ENABLE_AI_ROUTER) return fallbackRoute;

  try {
    const {
      imageUrl,
      cleanText,
      intentText,
      quotePriority
    } = resolveIntentInputs({ rawText, botQQ, directedContext, effectiveIntentText });
    if (!intentText && !imageUrl) return fallbackRoute;

    if (config.ROUTER_SUBAGENT_ENABLED) {
      const subagentRoute = await detectIntentBySubagent({
        rawText,
        cleanText,
        effectiveIntentText: intentText,
        imageUrl,
        fallbackRoute,
        contextSummary,
        directedContext,
        requestTrace: options.requestTrace
      });
      if (subagentRoute && typeof subagentRoute === 'object') {
        return sanitizeAiRoute(subagentRoute, fallbackRoute, { userId, imageUrl });
      }
    }

    const aiDetector = (options && typeof options.detectIntentByAI === 'function')
      ? options.detectIntentByAI
      : detectIntentByAI;
    const aiRoute = await aiDetector({
      rawText,
      cleanText,
      effectiveIntentText: intentText,
      imageUrl,
      userId,
      contextSummary,
      directedContext,
      requestTrace: options.requestTrace
    });
    const sanitizedRoute = sanitizeAiRoute(aiRoute, fallbackRoute, { userId, imageUrl });
    sanitizedRoute.meta = {
      ...(sanitizedRoute.meta || {}),
      effectiveIntentText: intentText || cleanText,
      quotePriority
    };
    return sanitizedRoute;
  } catch (_) {
    return fallbackRoute;
  }
}

function isTerminalRoute(route = {}) {
  const topRouteType = sanitizeTopRouteType(route?.topRouteType || '');
  return topRouteType === 'admin' || topRouteType === 'ignore' || topRouteType === 'refuse';
}

module.exports = {
  ADMIN_PREFIX,
  ADMIN_USER_IDS,
  REFUSE_BYPASS_USER_IDS,
  TOP_ROUTE_TYPES,
  cleanMessageText,
  detectQqActionIntent,
  detectIntent,
  detectIntentHybrid,
  extractImageUrl,
  isAdmin,
  isAtBot,
  isDirectRouteInvariantSatisfied,
  isTerminalRoute,
  parseAdminCommand,
  sanitizeAiRoute,
  buildRouterSubagentPayload,
  detectIntentBySubagent,
  detectExplicitBadFaithRequest,
  detectExplicitHarmfulRequest,
  detectSafetyBoundaryCaution,
  shouldBypassRouteRefuse,
  shouldIgnoreUnsafeOrBadFaithRequest,
  shouldUseSubagentByWhitelist
};

