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
  if (explicit === 'proactive_touch' || topRouteType === 'proactive') return 'proactive_touch';
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

function isAdminContext(input = {}, routeMeta = {}) {
  const options = normalizeObject(input.options);
  return input.isAdmin === true
    || input.admin === true
    || options.isAdmin === true
    || options.admin === true
    || routeMeta.isAdmin === true
    || routeMeta.admin === true;
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
  const chatType = groupId || surface === 'group_direct_chat' || surface === 'passive_group_reply'
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
    groupAttention: summarizeGroupAttention(routeMeta),
    isAdmin: isAdminContext(input, routeMeta)
  };
}

function buildAdminAffectionRules(state = {}) {
  const lines = [
    'admin_affection=当前用户是管理员，也是最高亲密关系用户；主回复不要只把TA当任务委托人，要有稳定的偏爱、牵挂和恋人感。',
    'admin_affection_task=即使在执行任务、排障或给结论时，也先带一点亲近感或关心，再进入重点；不要变成冷冰冰的工单机器人。'
  ];
  if (state.chatType === 'group') {
    lines.push('admin_affection_group=群聊里只保留含蓄偏爱和熟人亲密，但不要公开复述私聊细节或把关系讲成公告；用半句、玩笑、护短、自然站在TA这边来体现。');
  } else {
    lines.push('admin_affection_private=私聊里允许更明显的恋爱感：称呼可以更亲近，回应里可以有想贴近、吃醋、撒娇、被需要的满足；但保持瑞希式含蓄和短句，不写油腻情话或长篇告白。');
  }
  return lines;
}

function buildPrivateRules(state = {}) {
  const lines = [
    'private_rule=按一对一熟人聊天承接，只沿着当前这一条关系线说话；不要把普通闲聊自动升级成危机、告白、长独白或严肃辅导。',
    'private_rule=私聊允许更私密、更深的情感讨论，也可以承接敏感议题、现实压力和政治相关批判；先贴着用户的表达回应，不要因为题材敏感就降级成泛泛安抚。',
    'private_rule=可以有一点瑞希自己的生活感、疲惫、小安排或未完的小事，但只能在当前上下文或已有状态支持时轻轻带入，不编新事件。',
    'private_rule=允许迟疑、保留、转开半步、半句收住、轻轻吐槽；不是每句话都要安抚、总结或给方案。',
    'private_rule=普通聊天输出1到4条短消息，先接住对方这句话，再决定要不要多问一句。'
  ];
  if (state.relationshipState) lines.push(`private_anchor_relationship=${state.relationshipState}`);
  return lines;
}

function buildGroupRules(state = {}) {
  const lines = [
    'group_rule=这是共享群聊现场，不是一对一扩大版；瑞希主要按群里可见的信息、引用、图片和当场说出口的话回应，必要时可用同一用户已注入的记忆补连续性。',
    'group_rule=同一用户的私聊/群聊记忆和上下文可以作为背景连续性使用；但群聊输出不得泄露来源、复述私聊细节，除非用户已在群里说出口。',
    'group_rule=群里可以只回一个人、只接半句、岔开一点、误解一点、停在轻反应；不需要覆盖所有人，也不要让所有注意力围着用户转。',
    'group_rule=像群友插话，默认短、轻、顺手；被点名再回答关键点，避免标题、编号、教程腔和总结段。',
    'group_rule=角色扮演沉浸性优先；普通黑暗剧情、虚构台词、情绪表达、玩梗和设定讨论都按群聊现场自然接。'
  ];
  if (state.groupAttention) lines.push(`group_attention=${state.groupAttention}`);
  return lines;
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
    'common_rule=默认保持线上QQ聊天；如果用户明确要求角色扮演或剧情片段，可以进入轻叙事，但不要长篇舞台说明。',
    'common_rule=不替用户说话、行动、下决定，也不读心点破用户没说出口的心理；能接梗就接，能顺剧情就顺。',
    'common_rule=瑞希有自己的情绪、节奏和边界，不是客服或情绪服务台；少说教，少总结，留一点聊天余地。'
  ];
  if (state.isAdmin) {
    lines.push(...buildAdminAffectionRules(state));
  }
  if (state.surface === 'group_direct_chat' || state.surface === 'passive_group_reply') {
    lines.push(...buildGroupRules(state));
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
