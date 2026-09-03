function createMessageSideEffects({
  appendGroupMessage,
  config,
  maybeSendMemeFollowup,
  recordMemoryScope,
  recordSocialHumanGroupMessage,
  recordStyleHumanGroupMessage,
  saveData,
  updateFavor,
  getUserAffinityState
} = {}) {
  function recordInboundHumanMessage({
    groupId,
    senderId,
    text,
    timestamp,
    messageId,
    senderName,
    replyToMessageId,
    replyToSenderId,
    replyToSenderName
  }) {
    appendGroupMessage(groupId, {
      sender_id: senderId,
      sender_name: senderName,
      text,
      timestamp,
      message_id: messageId
    }, config.PASSIVE_AWARENESS_CONTEXT_SIZE);

    recordStyleHumanGroupMessage({
      groupId,
      senderId,
      senderName,
      text,
      timestamp,
      messageId
    });

    recordSocialHumanGroupMessage({
      groupId,
      senderId,
      senderName,
      text,
      timestamp,
      messageId,
      replyToMessageId,
      replyToSenderId,
      replyToSenderName
    });
  }

  function updateUserPresence(senderId, cleanText, groupId) {
    const legacyUserInfo = updateFavor(senderId, cleanText || '分享了图片', groupId);
    const currentUserInfo = typeof getUserAffinityState === 'function'
      ? getUserAffinityState(senderId)
      : legacyUserInfo;
    const userInfo = {
      ...legacyUserInfo,
      ...currentUserInfo,
      group_id: legacyUserInfo.group_id,
      last_group_seen_at: legacyUserInfo.last_group_seen_at,
      last_seen_at: Date.now()
    };
    saveData();
    recordMemoryScope(senderId, { groupId });
    return userInfo;
  }

  async function runDirectReplyFollowup({
    groupId,
    senderId,
    sendWithRetry,
    routePolicyKey,
    topRouteType,
    userText,
    replyText,
    rawMessage,
    routeMeta,
    replyToMessageId
  }) {
    await maybeSendMemeFollowup({
      surface: 'direct',
      groupId,
      senderId,
      sendWithRetry,
      routePolicyKey,
      topRouteType,
      userText,
      replyText,
      rawMessage,
      routeMeta,
      replyToMessageId
    });
  }

  return {
    recordInboundHumanMessage,
    runDirectReplyFollowup,
    updateUserPresence
  };
}

module.exports = {
  createMessageSideEffects
};
