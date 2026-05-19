function createSocialContextGraphHelpers(deps = {}) {
  const {
    ACTIVE_PAIR_WINDOW_MS,
    FAST_REPLY_WINDOW_MS,
    INITIATOR_WINDOW_MS,
    LOG_LIMIT,
    WINDOW_MS,
    defaultEdge,
    defaultGroupEntry,
    normalizeEdge,
    normalizeId,
    normalizeMessageLog,
    normalizeSummary,
    nowMs
  } = deps;

  function pruneLog(log = []) {
    const cutoff = nowMs() - WINDOW_MS;
    const items = normalizeMessageLog(log).filter((item) => item.timestamp >= cutoff);
    if (items.length <= LOG_LIMIT) return items;
    return items.slice(items.length - LOG_LIMIT);
  }

  function toPairKey(userA = '', userB = '') {
    const first = normalizeId(userA);
    const second = normalizeId(userB);
    if (!first || !second) return '';
    return `${first}->${second}`;
  }

  function toUndirectedPairKey(userA = '', userB = '') {
    const first = normalizeId(userA);
    const second = normalizeId(userB);
    if (!first || !second) return '';
    return [first, second].sort().join('<->');
  }

  function isTeaseCue(text = '') {
    return /(哈哈|笑死|又|还在|别装|逮到|偷看|你这|又来|真会|绷不住|拿捏)/i.test(String(text || ''));
  }

  function isConflictCue(text = '') {
    return /(闭嘴|滚|烦|有病|离谱|神经|别扯|别杠|急了|攻击|吵|怼)/i.test(String(text || ''));
  }

  function isSupportCue(text = '') {
    return /(对|确实|是的|同意|支持|有道理|没毛病|行|可以)/i.test(String(text || ''));
  }

  function buildEdge(entry = {}) {
    const edge = normalizeEdge(entry);
    const dominantCandidates = [
      ['conflict', edge.conflictCount],
      ['tease', edge.teaseCount],
      ['support', edge.supportCount],
      ['reply', edge.totalInteractions]
    ].sort((a, b) => b[1] - a[1]);
    edge.dominantType = dominantCandidates[0]?.[1] > 0 ? dominantCandidates[0][0] : '';
    edge.strength = edge.totalInteractions + edge.fastReplyCount + edge.teaseCount + (edge.explicitReplyCount * 2);
    return edge;
  }

  function summarizeNames(messageLog = [], userA = '', userB = '') {
    const names = new Map();
    for (const item of messageLog) {
      if (item.senderId === userA || item.senderId === userB) {
        if (item.senderName && !names.has(item.senderId)) names.set(item.senderId, item.senderName);
      }
    }
    const first = names.get(userA) || userA;
    const second = names.get(userB) || userB;
    return `${first}<->${second}`;
  }

  function getOrCreateEdge(directedEdges = {}, fromUserId = '', toUserId = '') {
    const edgeKey = toPairKey(fromUserId, toUserId);
    if (!edgeKey) return null;
    const edge = directedEdges[edgeKey] || defaultEdge();
    edge.fromUserId = normalizeId(fromUserId);
    edge.toUserId = normalizeId(toUserId);
    directedEdges[edgeKey] = edge;
    return edge;
  }

  function applyInteractionToEdge(edge = null, { groupId = '', timestamp = 0, text = '', isFastReply = false, isExplicitReply = false } = {}) {
    if (!edge) return;
    edge.totalInteractions += 1;
    if (isFastReply) edge.fastReplyCount += 1;
    if (isExplicitReply) edge.explicitReplyCount += 1;
    if (isTeaseCue(text) && !isConflictCue(text)) edge.teaseCount += 1;
    if (isSupportCue(text)) edge.supportCount += 1;
    if (isConflictCue(text)) edge.conflictCount += 1;
    edge.groups[groupId] = (edge.groups[groupId] || 0) + 1;
    edge.lastSeenAt = Math.max(edge.lastSeenAt || 0, Number(timestamp || 0) || 0);
  }

  function resolveExplicitReplyPair(message = null) {
    const senderId = normalizeId(message?.senderId);
    const replyToSenderId = normalizeId(message?.replyToSenderId);
    if (!senderId || !replyToSenderId || senderId === replyToSenderId) return null;
    return {
      fromUserId: replyToSenderId,
      toUserId: senderId
    };
  }

  function findPriorHumanMessage(humanMessages = [], currentIndex = -1, targetMessageId = '') {
    const wantedId = normalizeId(targetMessageId);
    if (!wantedId) return null;
    for (let i = Math.min(currentIndex - 1, humanMessages.length - 1); i >= 0; i -= 1) {
      const candidate = humanMessages[i];
      const candidateMessageId = normalizeId(String(candidate?.id || '').replace(/^msg:/, ''));
      if (candidateMessageId && candidateMessageId === wantedId) return candidate;
    }
    return null;
  }

  function recomputeGroupEntry(groupId, entry = defaultGroupEntry()) {
    const messageLog = pruneLog(entry.messageLog);
    const humanMessages = messageLog.filter((item) => item.kind !== 'bot');
    const distinctUsers = new Set(humanMessages.map((item) => item.senderId)).size;
    const directedEdges = {};
    const initiatorCounts = new Map();

    for (let i = 1; i < humanMessages.length; i += 1) {
      const curr = humanMessages[i];
      const prev = humanMessages[i - 1];
      if (!curr) continue;

      const explicitPair = resolveExplicitReplyPair(curr);
      if (explicitPair) {
        const repliedMessage = findPriorHumanMessage(humanMessages, i, curr.replyToMessageId);
        const delta = repliedMessage ? (curr.timestamp - repliedMessage.timestamp) : (prev ? (curr.timestamp - prev.timestamp) : Number.MAX_SAFE_INTEGER);
        const explicitEdge = getOrCreateEdge(directedEdges, explicitPair.fromUserId, explicitPair.toUserId);
        applyInteractionToEdge(explicitEdge, {
          groupId,
          timestamp: curr.timestamp,
          text: curr.text,
          isFastReply: delta >= 0 && delta <= FAST_REPLY_WINDOW_MS,
          isExplicitReply: true
        });
        directedEdges[toPairKey(explicitPair.fromUserId, explicitPair.toUserId)] = buildEdge(explicitEdge);
        continue;
      }

      if (!prev || prev.senderId === curr.senderId) continue;
      const delta = curr.timestamp - prev.timestamp;
      if (delta < 0 || delta > ACTIVE_PAIR_WINDOW_MS) continue;
      const edge = getOrCreateEdge(directedEdges, prev.senderId, curr.senderId);
      applyInteractionToEdge(edge, {
        groupId,
        timestamp: curr.timestamp,
        text: curr.text,
        isFastReply: delta <= FAST_REPLY_WINDOW_MS,
        isExplicitReply: false
      });
      directedEdges[toPairKey(prev.senderId, curr.senderId)] = buildEdge(edge);
    }

    for (let i = 0; i < humanMessages.length; i += 1) {
      const current = humanMessages[i];
      const responders = new Set();
      for (let j = i + 1; j < humanMessages.length; j += 1) {
        const candidate = humanMessages[j];
        if (candidate.timestamp - current.timestamp > INITIATOR_WINDOW_MS) break;
        if (candidate.senderId !== current.senderId) responders.add(candidate.senderId);
      }
      if (responders.size >= 2) {
        initiatorCounts.set(current.senderId, (initiatorCounts.get(current.senderId) || 0) + 1);
      }
    }

    const undirectedReplyPairs = new Map();
    for (const edge of Object.values(directedEdges)) {
      const pairKey = toUndirectedPairKey(edge.fromUserId, edge.toUserId);
      if (!pairKey) continue;
      const summary = undirectedReplyPairs.get(pairKey) || {
        userA: pairKey.split('<->')[0],
        userB: pairKey.split('<->')[1],
        count: 0,
        strength: 0,
        teaseCount: 0,
        supportCount: 0,
        conflictCount: 0,
        names: summarizeNames(messageLog, pairKey.split('<->')[0], pairKey.split('<->')[1])
      };
      summary.count += edge.totalInteractions;
      summary.strength += edge.strength;
      summary.teaseCount += edge.teaseCount;
      summary.supportCount += edge.supportCount;
      summary.conflictCount += edge.conflictCount;
      undirectedReplyPairs.set(pairKey, summary);
    }

    const topTeasePairs = [...undirectedReplyPairs.values()]
      .filter((item) => item.teaseCount > 0 && item.conflictCount <= Math.max(1, Math.floor(item.teaseCount / 2)))
      .sort((a, b) => b.teaseCount - a.teaseCount)
      .slice(0, 4)
      .map((item) => ({
        userA: item.userA,
        userB: item.userB,
        names: item.names,
        count: item.teaseCount,
        strength: item.strength,
        dominantType: 'tease'
      }));

    const conflictTotal = [...undirectedReplyPairs.values()].reduce((sum, item) => sum + item.conflictCount, 0);
    const teaseTotal = [...undirectedReplyPairs.values()].reduce((sum, item) => sum + item.teaseCount, 0);
    const supportTotal = [...undirectedReplyPairs.values()].reduce((sum, item) => sum + item.supportCount, 0);

    let atmosphere = 'cold';
    if (humanMessages.length >= 20 && distinctUsers >= 3) atmosphere = 'noisy';
    if (conflictTotal >= 4 && conflictTotal >= Math.max(2, teaseTotal + supportTotal)) atmosphere = 'tense';
    else if (humanMessages.length >= 16 && teaseTotal + supportTotal >= Math.max(4, conflictTotal * 2)) atmosphere = 'light';
    else if (humanMessages.length < 12 || distinctUsers < 3) atmosphere = 'cold';

    return {
      messageLog,
      summary: normalizeSummary({
        atmosphere,
        sampleCount: humanMessages.length,
        distinctUsers,
        topInitiators: [...initiatorCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([userId, count]) => ({
            userId,
            senderName: humanMessages.find((item) => item.senderId === userId)?.senderName || '',
            count
          })),
        topReplyPairs: [...undirectedReplyPairs.values()]
          .sort((a, b) => b.strength - a.strength)
          .slice(0, 4)
          .map((item) => ({
            userA: item.userA,
            userB: item.userB,
            names: item.names,
            count: item.count,
            strength: item.strength,
            dominantType: item.conflictCount > item.teaseCount && item.conflictCount > item.supportCount
              ? 'conflict'
              : (item.teaseCount > item.supportCount ? 'tease' : 'reply')
          })),
        topTeasePairs,
        updatedAt: nowMs()
      }),
      edges: directedEdges
    };
  }

  function recomputeMergedGraph(groups = {}) {
    const mergedEdges = {};
    for (const [groupId, group] of Object.entries(groups || {})) {
      const rawEdges = group?.edges && typeof group.edges === 'object' ? group.edges : {};
      for (const edge of Object.values(rawEdges)) {
        const key = toPairKey(edge.fromUserId, edge.toUserId);
        if (!key) continue;
        const target = mergedEdges[key] || defaultEdge();
        target.fromUserId = edge.fromUserId;
        target.toUserId = edge.toUserId;
        target.totalInteractions += Number(edge.totalInteractions || 0);
        target.fastReplyCount += Number(edge.fastReplyCount || 0);
        target.explicitReplyCount += Number(edge.explicitReplyCount || 0);
        target.teaseCount += Number(edge.teaseCount || 0);
        target.supportCount += Number(edge.supportCount || 0);
        target.conflictCount += Number(edge.conflictCount || 0);
        target.groups[groupId] = Number(edge.totalInteractions || 0);
        target.lastSeenAt = Math.max(target.lastSeenAt || 0, Number(edge.lastSeenAt || 0) || 0);
        mergedEdges[key] = buildEdge(target);
      }
    }
    return { edges: mergedEdges };
  }

  function applyGroupDeltaToMergedGraph(mergedGraph = { edges: {} }, groupId = '', previousGroup = defaultGroupEntry(), nextGroup = defaultGroupEntry()) {
    const gid = normalizeId(groupId);
    const nextMerged = {
      edges: {
        ...(mergedGraph?.edges && typeof mergedGraph.edges === 'object' ? mergedGraph.edges : {})
      }
    };

    for (const edge of Object.values(previousGroup?.edges || {})) {
      const key = toPairKey(edge.fromUserId, edge.toUserId);
      if (!key || !nextMerged.edges[key]) continue;
      const target = normalizeEdge(nextMerged.edges[key]);
      target.totalInteractions = Math.max(0, Number(target.totalInteractions || 0) - Number(edge.totalInteractions || 0));
      target.fastReplyCount = Math.max(0, Number(target.fastReplyCount || 0) - Number(edge.fastReplyCount || 0));
      target.explicitReplyCount = Math.max(0, Number(target.explicitReplyCount || 0) - Number(edge.explicitReplyCount || 0));
      target.teaseCount = Math.max(0, Number(target.teaseCount || 0) - Number(edge.teaseCount || 0));
      target.supportCount = Math.max(0, Number(target.supportCount || 0) - Number(edge.supportCount || 0));
      target.conflictCount = Math.max(0, Number(target.conflictCount || 0) - Number(edge.conflictCount || 0));
      delete target.groups[gid];
      if (target.totalInteractions <= 0) {
        delete nextMerged.edges[key];
      } else {
        nextMerged.edges[key] = buildEdge(target);
      }
    }

    for (const edge of Object.values(nextGroup?.edges || {})) {
      const key = toPairKey(edge.fromUserId, edge.toUserId);
      if (!key) continue;
      const target = normalizeEdge(nextMerged.edges[key] || defaultEdge());
      target.fromUserId = edge.fromUserId;
      target.toUserId = edge.toUserId;
      target.totalInteractions += Number(edge.totalInteractions || 0);
      target.fastReplyCount += Number(edge.fastReplyCount || 0);
      target.explicitReplyCount += Number(edge.explicitReplyCount || 0);
      target.teaseCount += Number(edge.teaseCount || 0);
      target.supportCount += Number(edge.supportCount || 0);
      target.conflictCount += Number(edge.conflictCount || 0);
      target.groups[gid] = Number(edge.totalInteractions || 0);
      target.lastSeenAt = Math.max(Number(target.lastSeenAt || 0), Number(edge.lastSeenAt || 0) || 0);
      nextMerged.edges[key] = buildEdge(target);
    }

    return nextMerged;
  }

  return {
    applyGroupDeltaToMergedGraph,
    buildEdge,
    recomputeGroupEntry,
    recomputeMergedGraph,
    toPairKey,
    toUndirectedPairKey
  };
}

module.exports = {
  createSocialContextGraphHelpers
};
