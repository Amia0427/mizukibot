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

function buildUnavailableRouteReply(route = {}, routeExecutionPlan = {}, { isAdminUser } = {}) {
  const unavailableReason = String(routeExecutionPlan?.unavailableReason || '').trim().toLowerCase();
  if (unavailableReason === 'private-group-only') {
    const command = String(route?.meta?.command?.cmd || '').trim().toLowerCase();
    if (command === 'group_summary') {
      return '这个要在群里才接得住啦。';
    }
    return '这个得在目标群里喊我才行哦。';
  }
  if (unavailableReason === 'private-write-disabled') {
    return '私聊现在先收起来了，只对白名单和管理员开放哦。';
  }
  if (unavailableReason !== 'no-allowed-tools') {
    return '这边刚刚没接稳，你等一下再叫我试试。';
  }

  const qqActionKey = String(route?.meta?.qqActionKey || '').trim().toLowerCase();
  const userId = String(route?.meta?.userId || '').trim();
  const adminUser = typeof isAdminUser === 'function' ? isAdminUser(userId) : false;

  if (qqActionKey === 'qq_publish_qzone') {
    return adminUser
      ? 'QQ 空间草稿那边现在没接稳。等一下再试，或者直接用 /qzone_post。'
      : 'QQ 空间草稿这件事现在只给管理员开着啦。';
  }

  if (qqActionKey === 'qq_schedule_qzone') {
    return adminUser
      ? '定时 QQ 空间那边现在没接稳。等一下再试，或者直接用 /schedule_create。'
      : '定时 QQ 空间这件事现在只给管理员开着啦。';
  }

  if (qqActionKey === 'qq_schedule_message') {
    return '定时消息这边刚刚没接住。把时间说得更清楚一点，我再试一次。';
  }

  return '这个操作现在没接上。你把想做的事再说具体一点，我重新接。';
}

function shouldDowngradeUnavailableRouteToDirectReply(route = {}, routeExecutionPlan = {}) {
  const unavailableReason = String(routeExecutionPlan?.unavailableReason || '').trim().toLowerCase();
  if (!['no-allowed-tools', 'planner-missing'].includes(unavailableReason)) return false;

  const topRouteType = String(routeExecutionPlan?.topRouteType || route?.topRouteType || '').trim().toLowerCase();
  if (topRouteType && topRouteType !== 'direct_chat') return false;

  const meta = route?.meta && typeof route.meta === 'object' ? route.meta : {};
  if (String(meta.qqActionKey || '').trim()) return false;
  if (String(meta.command?.cmd || '').trim()) return false;

  return true;
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
  perceptionPrompt = null,
  safetyBoundaryRoutePrompt = null,
  streamingSegmentationPrompt = null,
  qqRichReplyPrompt = null
} = {}) {
  return [
    toolGuidancePrompt,
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
  buildUnavailableRouteReply,
  shouldDowngradeUnavailableRouteToDirectReply,
  buildQzoneAutodraftPrompt,
  buildSupplementedTaskText,
  composeDirectRoutePrompt,
  resolveVisionFallbackModelConfig,
  parseToggleSubcommand,
  buildRouteDiagPayload
};
