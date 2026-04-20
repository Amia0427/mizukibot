/**
 * Internal message pipeline contracts.
 * These objects are not public API and exist only to keep the split
 * message pipeline from passing long ad-hoc argument lists around.
 */

function buildInboundMessageContext(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    msg: source.msg || {},
    effectiveMsg: source.effectiveMsg || source.msg || {},
    groupId: String(source.groupId || source.effectiveMsg?.group_id || source.msg?.group_id || '').trim(),
    senderId: String(source.senderId || source.effectiveMsg?.user_id || source.msg?.user_id || '').trim(),
    senderName: String(
      source.senderName
      || source.messageMeta?.senderName
      || source.effectiveMsg?.sender?.card
      || source.effectiveMsg?.sender?.nickname
      || source.effectiveMsg?.sender?.nick
      || source.effectiveMsg?.sender_name
      || source.effectiveMsg?.user_id
      || source.msg?.sender?.card
      || source.msg?.sender?.nickname
      || source.msg?.sender?.nick
      || source.msg?.sender_name
      || source.msg?.user_id
      || ''
    ).trim(),
    rawText: String(source.rawText || ''),
    cleanText: String(source.cleanText || ''),
    imageUrl: source.imageUrl || null,
    visualContext: source.visualContext && typeof source.visualContext === 'object'
      ? { ...source.visualContext }
      : null,
    isAtBot: Boolean(source.isAtBot),
    preprocessedText: String(source.preprocessedText || source.cleanText || ''),
    botQQ: String(source.botQQ || '').trim(),
    platform: String(source.platform || source.effectiveMsg?.platform || source.msg?.platform || 'qq').trim() || 'qq',
    chatType: String(source.chatType || source.effectiveMsg?.message_type || source.msg?.message_type || 'group').trim() === 'private' ? 'private' : 'group',
    groupName: String(
      source.groupName
      || source.messageMeta?.groupName
      || source.effectiveMsg?.group_name
      || source.msg?.group_name
      || ''
    ).trim() || null,
    continuousMeta: source.continuousMeta || null,
    directedContext: source.directedContext && typeof source.directedContext === 'object'
      ? { ...source.directedContext }
      : null,
    messageMeta: source.messageMeta && typeof source.messageMeta === 'object'
      ? { ...source.messageMeta }
      : {}
  };
}

function buildRouteDecisionContext(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    inboundContext: source.inboundContext || null,
    route: source.route || null,
    plannerDecision: source.plannerDecision || null,
    executionPlan: source.executionPlan || null,
    userInfo: source.userInfo || null,
    senderId: String(source.senderId || source.inboundContext?.senderId || '').trim(),
    groupId: String(source.groupId || source.inboundContext?.groupId || '').trim(),
    requestText: String(source.requestText || source.inboundContext?.cleanText || ''),
    imageUrl: Object.prototype.hasOwnProperty.call(source, 'imageUrl')
      ? (source.imageUrl || null)
      : (source.inboundContext?.imageUrl || null),
    visualContext: source.visualContext && typeof source.visualContext === 'object'
      ? { ...source.visualContext }
      : (source.inboundContext?.visualContext && typeof source.inboundContext.visualContext === 'object'
        ? { ...source.inboundContext.visualContext }
        : null),
    directedContext: source.directedContext || source.inboundContext?.directedContext || null
  };
}

function buildReplyEnvelope(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    replyText: String(source.replyText || ''),
    persistedReplyText: String(source.persistedReplyText || source.replyText || ''),
    replySegments: Array.isArray(source.replySegments) ? [...source.replySegments] : [],
    routeContext: source.routeContext || null,
    sendStrategy: source.sendStrategy || null,
    allowStream: Boolean(source.allowStream),
    atSender: source.atSender !== false,
    backgroundTaskState: source.backgroundTaskState || null,
    postActions: Array.isArray(source.postActions) ? [...source.postActions] : [],
    usedStreamingSend: Boolean(source.usedStreamingSend),
    replyOptions: source.replyOptions || null,
    freshness: source.freshness && typeof source.freshness === 'object'
      ? { ...source.freshness }
      : null
  };
}

function buildPostActionEnvelope(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    inboundContext: source.inboundContext || null,
    routeContext: source.routeContext || null,
    replyEnvelope: source.replyEnvelope || null,
    route: source.route || null,
    executionPlan: source.executionPlan || null,
    userInfo: source.userInfo || null,
    senderId: String(source.senderId || source.inboundContext?.senderId || '').trim(),
    groupId: String(source.groupId || source.inboundContext?.groupId || '').trim(),
    requestText: String(source.requestText || source.inboundContext?.cleanText || ''),
    rawText: String(source.rawText || source.inboundContext?.rawText || ''),
    imageUrl: Object.prototype.hasOwnProperty.call(source, 'imageUrl')
      ? (source.imageUrl || null)
      : (source.inboundContext?.imageUrl || null),
    visualContext: source.visualContext && typeof source.visualContext === 'object'
      ? { ...source.visualContext }
      : (source.inboundContext?.visualContext && typeof source.inboundContext.visualContext === 'object'
        ? { ...source.inboundContext.visualContext }
        : null),
    replyText: String(source.replyText || source.replyEnvelope?.replyText || '')
  };
}

module.exports = {
  buildInboundMessageContext,
  buildRouteDecisionContext,
  buildReplyEnvelope,
  buildPostActionEnvelope
};
