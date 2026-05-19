function parseJsonTail(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON must be an object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`JSON 解析失败: ${error.message || error}`);
  }
}

function scoreFullSubagentComplexity(question = '', options = {}) {
  const text = String(question || '').trim();
  const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  let score = 0;
  if (/并行|多代理|多线程|分工|多个\s*worker|multi[- ]?agent|parallel/i.test(text)) score += 0.35;
  if (/实现|优化|重构|修复|排查|迁移|部署|测试|方案|计划|完整|全流程/i.test(text)) score += 0.18;
  if (/文件|代码|接口|schema|数据库|缓存|队列|worker|agent|工具|热路径|性能/i.test(text)) score += 0.18;
  if (/(^|\n)\s*(?:\d+[\.\、)]|[-*]\s+)/.test(text) || /首先|然后|最后|同时|分别|步骤/i.test(text)) score += 0.18;
  if (text.length >= 400) score += 0.16;
  if (text.length >= 900) score += 0.18;
  const allowedTools = Array.isArray(routeMeta.allowedTools) ? routeMeta.allowedTools : [];
  if (allowedTools.length >= 2) score += 0.12;
  if (routeMeta.forceFullMultiAgent === true || routeMeta.fullMultiAgent === true) score = 1;
  return Math.max(0, Math.min(1, score));
}

function shouldUseFullMultiAgent(config = {}, question = '', options = {}) {
  if (config.FULL_SUBAGENT_MULTI_AGENT_ENABLED !== true) return false;
  if (config.FULL_SUBAGENT_AUTO_UPGRADE_ENABLED === false) return true;
  const threshold = Math.max(0, Math.min(1, Number(config.FULL_SUBAGENT_COMPLEXITY_THRESHOLD || 0.65) || 0.65));
  return scoreFullSubagentComplexity(question, options) >= threshold;
}

function buildUnavailableRouteReply(route = {}, routeExecutionPlan = {}, { isAdminUser } = {}) {
  const unavailableReason = String(routeExecutionPlan?.unavailableReason || '').trim().toLowerCase();
  if (unavailableReason === 'private-group-only') {
    const command = String(route?.meta?.command?.cmd || '').trim().toLowerCase();
    if (command === 'full') {
      return '私聊不支持 /full，请在目标群内 @我后使用。';
    }
    return '该能力当前仅支持群聊中使用，请在目标群内 @我。';
  }
  if (unavailableReason === 'private-write-disabled') {
    return '私聊当前仅支持问答和只读能力，暂不支持执行动作。';
  }
  if (unavailableReason !== 'no-allowed-tools') {
    return 'The required tool is temporarily unavailable. Please try again later.';
  }

  const qqActionKey = String(route?.meta?.qqActionKey || '').trim().toLowerCase();
  const userId = String(route?.meta?.userId || '').trim();
  const adminUser = typeof isAdminUser === 'function' ? isAdminUser(userId) : false;

  if (qqActionKey === 'qq_publish_qzone') {
    return adminUser
      ? 'QQ 空间草稿工具暂时不可用。你可以稍后重试，或直接使用 /qzone_post。'
      : 'QQ 空间草稿当前仅管理员可用。';
  }

  if (qqActionKey === 'qq_schedule_qzone') {
    return adminUser
      ? '定时 QQ 空间工具暂时不可用。你可以稍后重试，或直接使用 /schedule_create。'
      : '定时 QQ 空间发布当前仅管理员可用。';
  }

  if (qqActionKey === 'qq_schedule_message') {
    return '定时消息工具当前不可用。你可以换个更清晰的时间表达再试一次。';
  }

  return '这轮没有可用工具可以处理这个请求。你可以稍后重试，或把需求说得更具体一些。';
}

function buildQzoneAutodraftPrompt(requestText = '') {
  return [
    '你现在只负责代写一条可以直接发布到 QQ 空间的中文正文。',
    '必须使用第一人称，语气自然，像今天写的日记或状态。',
    '优先根据用户原话推断主题、心情、长度和风格。',
    '默认写成 80 到 180 字。',
    '不要解释，不要提问，不要使用标题、项目符号、引号、标签或前缀。',
    '不要提到自己是 AI。',
    '只输出最终可发布正文。',
    `用户请求: ${String(requestText || '').trim()}`
  ].join('\n');
}

function buildSupplementedTaskText(session = {}, supplement = '') {
  const parts = [];
  const originalText = String(session?.original_text || '').trim();
  const latestSummary = String(session?.latest_summary || session?.latest_result_excerpt || '').trim();
  const cleanSupplement = String(supplement || '').trim();

  if (originalText) parts.push(`原始请求：${originalText}`);
  if (latestSummary) parts.push(`最近结果摘要：${latestSummary}`);
  if (cleanSupplement) parts.push(`补充要求：${cleanSupplement}`);

  return parts.join('\n');
}

function composeDirectRoutePrompt({
  toolGuidancePrompt = null,
  bridgeGuidancePrompt = null,
  perceptionPrompt = null,
  safetyBoundaryRoutePrompt = null,
  streamingSegmentationPrompt = null,
  qqRichReplyPrompt = null
} = {}) {
  return [
    toolGuidancePrompt,
    bridgeGuidancePrompt,
    perceptionPrompt,
    safetyBoundaryRoutePrompt,
    streamingSegmentationPrompt,
    qqRichReplyPrompt
  ].filter(Boolean).join('\n\n');
}

function resolveVisionFallbackModelConfig(route = {}, imageUrl = null, userId = '', buildImageModelConfig) {
  if (!String(imageUrl || '').trim()) return null;
  const visualContext = route?.meta?.visualContext && typeof route.meta.visualContext === 'object'
    ? route.meta.visualContext
    : null;
  if (!visualContext || visualContext?.worker?.succeeded === true) return null;
  if (typeof buildImageModelConfig !== 'function') return null;
  return buildImageModelConfig(null, userId, { routeMeta: route?.meta || {} });
}

function parseToggleSubcommand(command = {}) {
  return String(command?.args?.[0] || command?.payload || 'status').trim().toLowerCase() || 'status';
}

function buildRouteDiagPayload(routeExecutionPlan = {}, branch = '', extra = {}) {
  return {
    routeDebugKey: String(routeExecutionPlan?.routeDebugKey || '').trim(),
    routePolicyKey: String(routeExecutionPlan?.policyKey || routeExecutionPlan?.routePolicyKey || routeExecutionPlan?.routeDebugKey || '').trim(),
    topRouteType: String(routeExecutionPlan?.topRouteType || '').trim(),
    executor: String(routeExecutionPlan?.executor || '').trim(),
    dispatchBranch: String(branch || '').trim(),
    fallbackReason: String(routeExecutionPlan?.unavailableReason || routeExecutionPlan?.routeTrace?.fallbackReason || '').trim(),
    allowTools: routeExecutionPlan?.allowTools === true,
    needsBackground: routeExecutionPlan?.needsBackground === true,
    ...extra
  };
}

module.exports = {
  parseJsonTail,
  scoreFullSubagentComplexity,
  shouldUseFullMultiAgent,
  buildUnavailableRouteReply,
  buildQzoneAutodraftPrompt,
  buildSupplementedTaskText,
  composeDirectRoutePrompt,
  resolveVisionFallbackModelConfig,
  parseToggleSubcommand,
  buildRouteDiagPayload
};
