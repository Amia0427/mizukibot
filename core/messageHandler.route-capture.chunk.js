function buildUnavailableRouteReply(route = {}, routeExecutionPlan = {}) {
  const unavailableReason = String(routeExecutionPlan?.unavailableReason || '').trim().toLowerCase();
  if (unavailableReason !== 'no-allowed-tools') {
    return '这边刚刚没接稳，你等一下再叫我试试。';
  }

  const qqActionKey = String(route?.meta?.qqActionKey || '').trim().toLowerCase();
  const userId = String(route?.meta?.userId || '').trim();
  const adminUser = isAdminUser(userId);

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

function isCorrectionSignal(text = '') {
  const input = String(text || '').trim();
  if (!input) return false;
  return /(不是这样|你说错了|实际上应该是|你搞错了|不对|纠正一下|更准确地说)/i.test(input);
}

function maybeCaptureUserCorrection({
  cleanText,
  signalText = '',
  senderId,
  groupId,
  routeExecutionPlan,
  getLastAssistantReply = null
}) {
  const userMessage = String(cleanText || '').trim();
  const triggerText = String(signalText || userMessage || '').trim();
  if (!isCorrectionSignal(triggerText)) return;
  if (typeof getLastAssistantReply !== 'function') return;
  const timer = setTimeout(() => {
    try {
      const lastAssistantReply = getLastAssistantReply(senderId, groupId);
      if (!lastAssistantReply) return;
      captureCorrection({
        userMessage,
        assistantReply: lastAssistantReply,
        routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
        topRouteType: routeExecutionPlan?.topRouteType || 'direct_chat',
        groupId,
        userId: senderId
      });
    } catch (error) {
      console.error('[self-improvement] correction capture failed:', error?.message || error);
    }
  }, 0);
  if (typeof timer.unref === 'function') timer.unref();
}

function maybeCaptureUnavailableFeatureRequest({ routeExecutionPlan, cleanText, senderId, groupId, route }) {
  if (String(routeExecutionPlan?.unavailableReason || '').trim().toLowerCase() !== 'no-allowed-tools') return;
  if (String(routeExecutionPlan?.topRouteType || '').trim().toLowerCase() !== 'direct_chat') return;
  try {
    captureFeatureRequest({
      userMessage: cleanText,
      unavailableReason: routeExecutionPlan.unavailableReason,
      routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
      topRouteType: routeExecutionPlan.topRouteType,
      toolName: String((routeExecutionPlan.allowedTools || [])[0] || '').trim(),
      groupId,
      userId: senderId,
      suggestedAction: 'Add or expose the missing tool/capability for this request class.'
    });
  } catch (error) {
    console.error('[self-improvement] feature request capture failed:', error?.message || error);
  }
}

function shouldAutoDraftQzonePostRequest(route = {}, cleanText = '') {
  return shouldAutoDraftQzonePostRequestBase(route, cleanText, detectQzonePostDraftMode);
}

function getEffectivePolicyKey(routeExecutionPlan = {}) {
  return String(
    routeExecutionPlan?.policyKey
    || routeExecutionPlan?.routePolicyKey
    || routeExecutionPlan?.routeDebugKey
    || 'chat/default'
  ).trim() || 'chat/default';
}

