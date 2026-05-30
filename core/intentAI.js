const config = require('../config');
const { postWithRetry } = require('../api/httpClient');
const { extractMessageContent, extractJsonSafely } = require('../api/parser');
const { TOP_ROUTE_TYPES, sanitizeTopRouteType } = require('./routeSchema');

function ensureChatCompletionsUrl(url) {
  const u = String(url || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(u)) return u;
  if (/\/v\d+$/i.test(u)) return `${u}/chat/completions`;
  return u;
}

function normalizeContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : (part?.text || ''))).join('');
  }
  return String(content || '');
}

function buildRouterPrompt() {
  return [
    '你是消息意图路由器。你的任务是先判断主路由，再输出运行时需要的结构化意图。',
    '只输出 JSON，不要输出解释。',
    '主路由类型只有以下 4 个：',
    '- direct_chat: 普通聊天、图片问答、图片总结、需要或不需要工具的直接回答',
    '- admin: 明确的系统管理命令',
    '- refuse: 危险、恶意、滥用或骚扰请求',
    '- ignore: 空消息或确实无需回应',
    '输出格式：',
    '{',
    '  "topRouteType": "direct_chat|admin|refuse|ignore",',
    '  "confidence": 0.0,',
    '  "cleanText": "string",',
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
    '    "admin": true,',
    '    "command": { "cmd": "help|status|reload|debug|meme|unknown", "args": ["string"], "raw": "string", "payload": "string" },',
    '    "chatMode": "text_chat|image_qa|image_summary",',
    '    "toolIntent": "none|maybe_tools|force_tools",',
    '    "responseIntent": "answer|summary|plan|action_guidance" ',
    '  }',
    '}',
    '规则：',
    '1) 如果请求是 /help /status /reload /debug 这类命令，输出 admin。',
    '2) 如果请求明显危险、违法滥用、骚扰攻击、刷屏轰炸、恶意折腾机器人，输出 refuse。',
    '3) 未列入支持项的 / 指令仍输出 admin，并在 meta.command.cmd="unknown"、meta.admin 按用户权限设置；不要改成 refuse。',
    '4) 除 ignore/refuse/admin 外，一律输出 direct_chat。',
    '5) 看图识别属于 direct_chat + chatMode=image_qa；图片总结属于 direct_chat + chatMode=image_summary。',
    '6) 现在几点、当前时间、北京时间这类问题输出 direct_chat，且 facets.domain="time"，intent.toolNeed=["none"]，facets.sourceScope="none"，intent.executionMode="immediate"，meta.responseIntent="answer"。',
    '7) 当前消息里已经给出全部素材的总结/改写/翻译/提炼，输出 direct_chat，toolIntent="none"，responseIntent="summary"。',
    '8) 当前消息里已经给出全部素材的计划类请求，输出 direct_chat，toolIntent="none"，responseIntent="plan"。',
    '9) 查询最新消息、网页、资料、状态、行情、笔记等，仍输出 direct_chat，但根据需要设置 toolIntent="maybe_tools" 或 "force_tools"。',
    '10) 真正要求改东西、执行命令、安装、写入、远程操作，也输出 direct_chat，并设置 responseIntent="action_guidance" 与 toolIntent="force_tools"。',
    '11) confidence 范围必须是 0 到 1。',
    '12) 不要输出 toolHints、legacyPolicyKey、policyKey、keywords。'
  ].join('\n');
}

function getRouterBaseUrl() {
  // Allow the intent router to point at a cheaper/faster endpoint without affecting main chat.
  return String(config.AI_ROUTER_BASE_URL || config.API_BASE_URL || '').trim();
}

function getRouterApiKey() {
  return String(config.AI_ROUTER_API_KEY || config.API_KEY || '').trim() || null;
}

function getRouterModel() {
  return String(config.AI_ROUTER_MODEL || config.PLAN_MODEL || config.AI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4';
}

async function detectIntentByAI({
  rawText = '',
  cleanText = '',
  effectiveIntentText = '',
  imageUrl = null,
  userId = '',
  requestTrace = null
}) {
  const prompt = buildRouterPrompt();
  const routedText = String(effectiveIntentText || cleanText || '').trim();

  const resp = await postWithRetry(
    ensureChatCompletionsUrl(getRouterBaseUrl()),
    {
      model: getRouterModel(),
      temperature: 0.1,
      messages: [
        { role: 'system', content: prompt },
        {
          role: 'user',
          content: JSON.stringify({
            rawText,
            cleanText: routedText || cleanText,
            effectiveIntentText: routedText || cleanText,
            hasImage: Boolean(imageUrl),
            imageUrl: imageUrl || null,
            userId: String(userId)
          })
        }
      ],
      max_tokens: 900,
      stream: false,
      __trace: {
        ...(requestTrace && typeof requestTrace === 'object' ? requestTrace : {}),
        source: 'router',
        phase: 'router_ai',
        purpose: 'intent_route',
        userId: String(userId || '').trim(),
        topRouteType: 'direct_chat'
      }
    },
    1,
    getRouterApiKey()
  );

  const msg = extractMessageContent(resp);
  const text = normalizeContentText(msg?.content);
  const obj = extractJsonSafely(text);
  if (!obj || typeof obj !== 'object') return null;

  return {
    topRouteType: sanitizeTopRouteType(obj.topRouteType),
    confidence: Number(obj.confidence),
    cleanText: typeof obj.cleanText === 'string' ? obj.cleanText : cleanText,
    intent: obj.intent && typeof obj.intent === 'object' ? obj.intent : {},
    facets: obj.facets && typeof obj.facets === 'object' ? obj.facets : {},
    meta: obj.meta && typeof obj.meta === 'object' ? obj.meta : {}
  };
}

module.exports = { detectIntentByAI, TOP_ROUTE_TYPES };
