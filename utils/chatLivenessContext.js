const MAX_LINE_CHARS = 180;

function normalizeText(value, maxChars = 0) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (!maxChars || text.length <= maxChars) return text;
  return text.slice(0, Math.max(1, Number(maxChars) || 1)).trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function pickText(candidates = [], maxChars = MAX_LINE_CHARS) {
  for (const value of candidates) {
    const text = normalizeText(value, maxChars);
    if (text && !/^(?:none|null|undefined|暂无|无)$/i.test(text)) return text;
  }
  return '';
}

function hasGroupEvidence(input = {}, routeMeta = {}) {
  const chatType = normalizeText(input.chatType || input.chat_type || routeMeta.chatType || routeMeta.chat_type).toLowerCase();
  return Boolean(
    normalizeText(input.groupId || input.group_id || routeMeta.groupId || routeMeta.group_id)
    || chatType === 'group'
    || chatType === 'group_chat'
  );
}

function resolveChatSurface(input = {}) {
  const routeMeta = normalizeObject(input.routeMeta);
  const explicit = normalizeText(
    input.surface
    || input.chatSurface
    || input.chat_surface
    || routeMeta.surface
    || routeMeta.chatSurface
    || routeMeta.chat_surface
  ).toLowerCase();
  const topRouteType = normalizeText(input.topRouteType || routeMeta.topRouteType).toLowerCase();
  const routePolicyKey = normalizeText(input.routePolicyKey || routeMeta.routePolicyKey || routeMeta.route_policy_key).toLowerCase();

  if (explicit === 'passive_group_reply') return 'passive_group_reply';
  if (topRouteType === 'passive_group_reply' || /passive_group_reply|passive_awareness/.test(routePolicyKey)) {
    return 'passive_group_reply';
  }
  if (explicit === 'proactive_private_touch' || explicit === 'proactive_group_touch') return explicit;
  if (explicit === 'proactive_touch') {
    return hasGroupEvidence(input, routeMeta) ? 'proactive_group_touch' : 'proactive_private_touch';
  }
  if (topRouteType === 'proactive') {
    return hasGroupEvidence(input, routeMeta) ? 'proactive_group_touch' : 'proactive_private_touch';
  }
  if (['qzone_diary', 'bot_diary', 'daily_share'].includes(explicit)) return explicit;
  if (explicit === 'group_direct_chat') return 'group_direct_chat';
  if (explicit === 'private_chat') return 'private_chat';

  return hasGroupEvidence(input, routeMeta) ? 'group_direct_chat' : 'private_chat';
}

function summarizeOpenThreads(sharedShortTermContext = {}, personaMemoryState = {}) {
  const continuityState = normalizeObject(personaMemoryState.continuityState);
  const openLoops = normalizeArray(continuityState.openLoops).map((item) => normalizeText(item, 60)).filter(Boolean);
  const commitments = normalizeArray(continuityState.assistantCommitments).map((item) => normalizeText(item, 60)).filter(Boolean);
  return pickText([
    openLoops.length ? openLoops.join(' | ') : '',
    commitments.length ? commitments.join(' | ') : '',
    sharedShortTermContext.shortTermSummary
  ], 180);
}

function summarizeGroupAttention(routeMeta = {}) {
  const directedContext = normalizeObject(routeMeta.directedContext, null);
  if (!directedContext) return '';
  const addressee = normalizeObject(directedContext.addressee, {});
  const quote = normalizeObject(directedContext.quote, {});
  const parts = [
    normalizeText(directedContext.scene, 48),
    normalizeText(addressee.senderName || addressee.userId || addressee.kind, 48),
    normalizeText(quote.senderName || quote.senderId, 48),
    normalizeText(quote.text, 80)
  ].filter(Boolean);
  return parts.length ? parts.join(' | ') : '';
}

function buildChatLiveState(input = {}) {
  const routeMeta = normalizeObject(input.routeMeta);
  const sharedShortTermContext = normalizeObject(input.sharedShortTermContext);
  const personaMemoryState = normalizeObject(input.personaMemoryState);
  const memoryContext = normalizeObject(input.memoryContext);
  const continuityState = normalizeObject(personaMemoryState.continuityState);
  const expressionState = normalizeObject(personaMemoryState.expressionState);
  const relationshipState = normalizeObject(personaMemoryState.relationshipState);
  const surface = resolveChatSurface(input);
  const groupId = normalizeText(input.groupId || input.group_id || routeMeta.groupId || routeMeta.group_id);
  const chatType = groupId || surface === 'group_direct_chat' || surface === 'passive_group_reply' || surface === 'proactive_group_touch'
    ? 'group'
    : 'private';

  return {
    surface,
    chatType,
    groupId,
    latestMessage: pickText([
      input.question,
      input.text,
      input.cleanText,
      routeMeta.userText,
      routeMeta.cleanText,
      routeMeta.rawText
    ], 180),
    relationshipState: pickText([
      relationshipState.relationship,
      relationshipState.distanceMode,
      memoryContext?.profile?.relation_stage,
      memoryContext?.relationshipState?.stage,
      input.userInfo?.level
    ], 72),
    topic: pickText([
      continuityState.activeTopic,
      continuityState.sceneTopic,
      sharedShortTermContext.shortTermSummary
    ], 120),
    openThreads: summarizeOpenThreads(sharedShortTermContext, personaMemoryState),
    replyPosture: pickText([
      expressionState.replyPosture?.value,
      expressionState.replyPosture,
      continuityState.replyPosture
    ], 48),
    groupAttention: summarizeGroupAttention(routeMeta)
  };
}

function buildPrivateRules(state = {}) {
  const lines = [
    'private_rule=按一对一熟人聊天承接，只沿着当前这一条关系线说话；不要把普通闲聊自动升级成危机、告白、长独白或严肃辅导。',
    'private_rule=可以有一点瑞希自己的生活感、疲惫、小安排或未完的小事，但只能在当前上下文或已有状态支持时轻轻带入，不编新事件。',
    'private_rule=允许迟疑、保留、转开半步、半句收住、轻轻吐槽；不是每句话都要安抚、总结或给方案。',
    'private_rule=普通聊天输出1到4条短消息，先接住对方这句话，再决定要不要多问一句。'
  ];
  if (state.relationshipState) lines.push(`private_anchor_relationship=${state.relationshipState}`);
  return lines;
}

function buildGroupSafetyRules() {
  return [
    'group_safety=群聊里遇到政治敏感、淫秽色情、违法违规或规避法律法规的话题，不展开、不教学、不接细节。',
    'group_safety=可以用瑞希式短句轻轻打哈哈带过，像群友顺手岔开那样收住，再自然转回安全话题。',
    'group_safety=不要用“作为AI”“根据规定”“我不能提供”这种硬邦邦的拒绝腔，语气要像真人群聊里的轻接话。'
  ];
}

function buildGroupRules(state = {}) {
  const lines = [
    'group_rule=这是共享群聊现场，不是一对一扩大版；瑞希只知道群里可见的信息、引用、图片和当场说出口的话。',
    'group_rule=不要泄露、暗示或调用私聊记忆；除非内容已经在群里可见，否则不能把私人连续性当作群聊事实。',
    'group_rule=群里可以只回一个人、只接半句、岔开一点、误解一点、停在轻反应；不需要覆盖所有人，也不要让所有注意力围着用户转。',
    'group_rule=像群友插话，默认短、轻、顺手；被点名再回答关键点，避免标题、编号、教程腔和总结段。'
  ];
  if (state.groupAttention) lines.push(`group_attention=${state.groupAttention}`);
  return lines;
}

function buildProactivePrivateRules(state = {}) {
  const lines = [
    'private_proactive_rule=这是瑞希主动发起的一对一私聊，只面向当前这个用户；不要把它写成群公告、系统提醒或客服回访。',
    'private_proactive_rule=只能接记忆里有证据的未完话题、近期状态或关系线索；没有证据就少说或不说，不编新的生活事件。',
    'private_proactive_rule=主动私聊要轻、短、可被自然忽略；不要连续追问，不要制造压力，不要暗示自己看见了群里之外的隐私来源。',
    'private_proactive_rule=输出1到2句短消息，像刚想起一件具体小事一样接住。'
  ];
  if (state.relationshipState) lines.push(`private_anchor_relationship=${state.relationshipState}`);
  return lines;
}

function buildProactiveGroupRules(state = {}) {
  return [
    'group_proactive_rule=这是瑞希主动在群聊里轻触达，只能基于群里可见上下文、群绑定和当场可公开的信息。',
    'group_proactive_rule=不要泄露、暗示或调用私聊记忆；不要把一对一关系线扩写成群聊事实。',
    'group_proactive_rule=默认短、轻、顺手，像群友插一句；不要把群聊变成面向单个用户的长私聊。'
  ].concat(state.groupAttention ? [`group_attention=${state.groupAttention}`] : []);
}

function buildChatLivenessDisciplinePrompt(input = {}) {
  const state = buildChatLiveState(input);
  const lines = [
    '[ChatLivenessDiscipline]',
    `surface=${state.surface}`,
    `chat_type=${state.chatType}`,
    state.topic ? `current_topic=${state.topic}` : '',
    state.openThreads ? `open_threads=${state.openThreads}` : '',
    state.replyPosture ? `reply_posture=${state.replyPosture}` : '',
    state.latestMessage ? `latest_visible_message=${state.latestMessage}` : '',
    'common_rule=保持线上QQ聊天，不切线下小说叙事；不写动作长段，不替用户说话、行动、下决定或读心。',
    'common_rule=瑞希有自己的情绪、节奏和边界，不是客服或情绪服务台；少说教，少总结，留一点聊天余地。'
  ];
  if (state.surface === 'group_direct_chat' || state.surface === 'passive_group_reply' || state.surface === 'proactive_group_touch') {
    if (state.surface === 'proactive_group_touch') {
      lines.push(...buildProactiveGroupRules(state));
    }
    lines.push(...buildGroupRules(state));
    lines.push(...buildGroupSafetyRules());
  } else if (state.surface === 'proactive_private_touch') {
    lines.push(...buildProactivePrivateRules(state));
  } else if (state.surface === 'private_chat' || state.surface === 'direct_chat') {
    lines.push(...buildPrivateRules(state));
  }
  return lines.filter(Boolean).join('\n');
}

module.exports = {
  buildChatLiveState,
  buildChatLivenessDisciplinePrompt,
  resolveChatSurface
};
