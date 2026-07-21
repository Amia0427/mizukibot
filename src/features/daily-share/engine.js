'use strict';

const config = require('../../../config');
const { runQzoneAgent } = require('../../../api/qzoneAgentService');
const {
  cleanupLocalImage,
  tryGenerateBotDiaryQzoneImage
} = require('../../../api/qqActionService');
const { formatDateInTz } = require('../../../utils/time');
const {
  appendRecentContentFingerprint,
  appendRecentKey,
  appendRecentShare,
  ensureStateEntry,
  ensureTarget,
  loadState,
  loadTargets,
  resetGroupState,
  saveState,
  saveTargets
} = require('../../../core/dailyShareStore');
const dailyShareKnowledgeProvider = require('../../../core/dailyShareKnowledgeProvider');
const {
  createDailyShareContent,
  normalizeDailyShareFingerprint,
  validateDailyShareOutput
} = require('../../../core/dailyShareContent');
const {
  MAX_RETRIES,
  buildVariationConstraintPrompt,
  getModelConfigForQzoneAttempt,
  getRecentQzoneHistory,
  sampleVariationProfile
} = require('../../../core/qzoneGenerationState');
const {
  CANDIDATE_COUNT,
  CANDIDATE_VARIANT_TYPES,
  PLAN_RETRY_LIMIT,
  appendQzoneGenerationLog,
  buildCandidatePrompt,
  buildQzonePlan,
  getRecentFailureLikeEntries,
  normalizeTelemetryPayload,
  pickBestCandidate,
  summarizeQzoneDebug,
  summarizeQzoneWindowStats
} = require('../../../core/qzoneGenerationPhase2');
const {
  buildDailyShareUserInfo,
  recordSystemGroupSend,
  sendGroupReply
} = require('../../../core/systemGroupReply');
const {
  acquireInitiativeLock,
  evaluateInitiativePolicy,
  releaseInitiativeLock
} = require('../../../core/initiativePolicyEngine');
const { markInitiativeSent, setLastCycleKey } = require('../../../core/initiativeState');
const { shouldAllowProactiveGroupOutbound } = require('../../../core/proactiveGroupOutboundControl');
const { isAdmin } = require('../../../core/router');
const { recordMemoryScope: defaultRecordMemoryScope } = require('../../../utils/memoryScopeIndex');
const { appendPerfEvent, getBackgroundPressureDelayMs } = require('../../../utils/perfRuntime');
const {
  QZONE_TARGET_ID,
  WINDOW_STATUS_LABELS,
  logDailyShare
} = require('./core');
const {
  ensureWindowSchedule,
  formatHm,
  formatWindowRange,
  getAutoTypeForWindow,
  getMaxAutoSendsPerWindow,
  getWindowDefinitions,
  getWindowRemainingCapacity,
  shouldDeferOrSkip
} = require('./schedule');
const {
  advanceWindowPointer,
  buildDailyShareVariantNote,
  buildQzoneDailySharePromptFromPlan,
  classifyDailyShareGenerationFailure,
  createDailyShareAbortError,
  detectQzoneTerminalReplyFailureType,
  getDailyShareFailureCooldownMs,
  summarizeRecentShares,
  trimReplyText
} = require('./qzone');
const {
  buildQzoneMemoryPromptBlock,
  prefetchQzoneDailyShareMemory
} = require('./memory-prefetch');
const {
  findCurrentWindow,
  getNextWindowInfo,
  isManualDailyShareType,
  isManualQzoneDailyShareType,
  shouldRunWindowNow
} = require('./window');

function createDailyShareEngine({
  knowledgeProvider = dailyShareKnowledgeProvider,
  contentBuilder = null,
  qzonePublisher = null,
  runMemoryCli = null,
  recordMemoryScope = defaultRecordMemoryScope,
  memoryQueryPlanner = null
} = {}) {
  const resolvedContentBuilder = contentBuilder || createDailyShareContent({ knowledgeProvider });
  let targetsCache = null;
  let stateCache = null;

  function getToday(date = new Date()) {
    return formatDateInTz(date, config.TIMEZONE);
  }

  function ensureCaches(today = getToday()) {
    targetsCache = targetsCache || loadTargets();
    stateCache = stateCache || loadState(today);
    return { targets: targetsCache, state: stateCache };
  }

  function flush() {
    if (targetsCache) saveTargets(targetsCache);
    if (stateCache) saveState(stateCache);
  }

  function ensureTargetState(targetId, today = getToday()) {
    const { targets, state } = ensureCaches(today);
    return {
      target: ensureTarget(targets, targetId),
      stateEntry: ensureStateEntry(state, targetId, today)
    };
  }

  function ensureGroup(groupId, today = getToday()) {
    return ensureTargetState(groupId, today);
  }

  function ensureQzone(today = getToday()) {
    return ensureTargetState(QZONE_TARGET_ID, today);
  }

  function formatStatusForTarget(targetId, today = getToday(), date = new Date()) {
    const { target, stateEntry } = ensureTargetState(targetId, today);
    const currentWindow = findCurrentWindow(target, date);
    const windows = getWindowDefinitions(target);
    windows.forEach((windowDef) => ensureWindowSchedule(stateEntry, targetId, windowDef, today, date, target));
    const nextWindow = getNextWindowInfo(target, stateEntry, date);
    const title = String(target?.surface || '').trim().toLowerCase() === 'qzone' ? 'QZone Daily Share' : 'Daily Share';

    const lines = [
      `${title}: ${target.enabled ? '已启用' : '已禁用'}`,
      `今日自动发送：${stateEntry.dailyCount}/${target.maxPerDay}`,
      currentWindow
        ? `当前自动窗口：${currentWindow.label} ${formatWindowRange(currentWindow)}`
        : '当前自动窗口：当前无激活窗口',
      `下一次待执行：${nextWindow.label} ${nextWindow.time}`
    ];

    for (const windowDef of windows) {
      const schedule = stateEntry.scheduleByWindow[windowDef.key];
      const status = stateEntry.windowStatus[windowDef.key];
      const type = getAutoTypeForWindow(target, stateEntry, windowDef.key) || '无';
      lines.push(
        `${windowDef.label} ${formatWindowRange(windowDef)} | ${WINDOW_STATUS_LABELS[status.status] || status.status} | 自动类型 ${type} | 已发 ${Math.max(0, Number(schedule.sentCount || 0) || 0)}/${getMaxAutoSendsPerWindow(target)} | 计划 ${formatHm(schedule.plannedAt)} | 延期 ${formatHm(schedule.deferredAt)} | 最近成功 ${status.lastSuccessType || '无'} | 最近原因 ${status.lastReason || '无'}`
      );
    }
    return lines.join('\n');
  }

  function formatStatus(groupId, today = getToday(), date = new Date()) {
    return formatStatusForTarget(groupId, today, date);
  }

  async function generateValidatedShare({
    askAIByGraph,
    targetId,
    groupId,
    windowKey,
    type,
    payload,
    stateEntry,
    now,
    surface = 'group'
  }) {
    const normalizedSurface = String(surface || 'group').trim().toLowerCase() || 'group';
    const userId = normalizedSurface === 'qzone' ? 'dailyshare:qzone' : `dailyshare:group:${groupId}`;
    const userInfo = buildDailyShareUserInfo(
      normalizedSurface === 'qzone' ? '' : groupId,
      {
        userId,
        level: normalizedSurface === 'qzone' ? 'self' : 'group',
        relationship: normalizedSurface === 'qzone' ? 'self' : 'group',
        surface: normalizedSurface
      }
    );
    let lastFailure = '';
    let lastFailureClass = '';
    let qzoneMemoryEvidence = { items: [], sources: [] };
    let qzoneMemoryMeta = {
      memoryOwner: '',
      memoryQuery: '',
      memorySearchCount: 0,
      memoryOpenUsed: false,
      memoryOpenedSource: '',
      memoryPrefetchError: '',
      memoryEvidenceSources: []
    };

    if (normalizedSurface === 'qzone') {
      const prefetched = await prefetchQzoneDailyShareMemory({
        type,
        groupId,
        windowKey,
        windowLabel: payload?.windowLabel || windowKey,
        today: formatDateInTz(new Date(now), config.TIMEZONE),
        stateEntry,
        recentShareSummaries: summarizeRecentShares(stateEntry, 3),
        topicLabel: payload?.topicLabel || '',
        payload,
        runMemoryCli,
        recordMemoryScope,
        memoryQueryPlanner
      });
      qzoneMemoryEvidence = prefetched.memoryEvidence || qzoneMemoryEvidence;
      qzoneMemoryMeta = prefetched.meta || qzoneMemoryMeta;
      const memoryBlock = buildQzoneMemoryPromptBlock(qzoneMemoryEvidence);
      if (memoryBlock) {
        payload.prompt = payload.prompt ? `${payload.prompt}\n\n${memoryBlock}` : memoryBlock;
      }
    }

    const recentQzoneHistory = normalizedSurface === 'qzone' ? getRecentQzoneHistory() : [];
    const recentFailureHistory = normalizedSurface === 'qzone' ? getRecentFailureLikeEntries() : [];

    if (normalizedSurface === 'qzone') {
      for (let planAttempt = 0; planAttempt < PLAN_RETRY_LIMIT; planAttempt += 1) {
        const plan = buildQzonePlan({
          source: 'daily_share',
          type,
          windowKey,
          groupId: targetId,
          today: stateEntry?.today || '',
          planAttempt,
          now,
          recentHistory: recentQzoneHistory,
          recentFailures: recentFailureHistory,
          allowImage: false,
          targetLength: type === 'greeting' ? '18-60' : (type === 'mood' ? '24-90' : '30-100')
        });
        const candidates = [];
        for (let candidateIndex = 0; candidateIndex < Math.max(1, CANDIDATE_COUNT); candidateIndex += 1) {
          const variantType = CANDIDATE_VARIANT_TYPES[candidateIndex] || CANDIDATE_VARIANT_TYPES[0];
          const prompt = buildCandidatePrompt(
            buildQzoneDailySharePromptFromPlan({
              payload,
              plan,
              memoryBlock: payload.prompt && payload.prompt.includes('[记忆证据块]') ? '' : payload.prompt,
              retryNote: candidateIndex > 0
                ? `这是第 ${candidateIndex + 1} 个候选，请明显拉开开头、叙事动势和收尾。`
                : ''
            }),
            plan,
            [
              buildDailyShareVariantNote(variantType),
              candidateIndex > 0 ? `上一个候选不够好，请重新组织语气和画面。` : ''
            ].filter(Boolean).join('\n')
          );
          const reply = await askAIByGraph(prompt, userInfo, userId, prompt, null, {
            systemInitiated: true,
            topRouteType: 'proactive',
            routePolicyKey: 'proactive/daily-share',
            disableTools: true,
            disableStream: true,
            disableMemoryLearning: true,
            modelConfig: getModelConfigForQzoneAttempt(candidateIndex > 0 ? 'similarity' : ''),
            routeMeta: {
              groupId: String(groupId || ''),
              taskType: 'daily_share',
              channelId: String(targetId),
              windowKey,
              shareType: type,
              surface: normalizedSurface
            }
          });
          const text = trimReplyText(reply, 260);
          const terminalFailureType = detectQzoneTerminalReplyFailureType(text);
          if (terminalFailureType) {
            throw createDailyShareAbortError(text, terminalFailureType);
          }
          const validation = validateDailyShareOutput(text, type, normalizedSurface);
          candidates.push({
            plan,
            variantType,
            text,
            rejected: !validation.ok,
            rejectionReason: validation.ok ? '' : validation.reason
          });
        }
        const picked = pickBestCandidate(candidates, {
          source: type,
          recentHistory: recentQzoneHistory,
          plan
        });
        if (picked.selected) {
          appendQzoneGenerationLog(normalizeTelemetryPayload({
            source: 'daily_share',
            type,
            groupId: targetId,
            status: 'sent',
            selectedFingerprint: picked.selected.fingerprint,
            selectedScore: picked.selected.score,
            similarity: picked.selected.similarity,
            noveltyScore: picked.selected.noveltyScore,
            tropeCollisionScore: picked.selected.tropeCollisionScore,
            circleNaturalnessScore: picked.selected.circleNaturalnessScore,
            edgeTensionScore: picked.selected.edgeTensionScore,
            failureReasons: [],
            planSummary: {
              fingerprint: plan.fingerprint,
              topicKey: plan.theme?.key || payload.topicKey || '',
              topicGroup: plan.theme?.key ? String(plan.theme.key).split('.')[0] : (payload.topicGroup || ''),
              lens: plan.variationProfile?.lens || '',
              anchor: plan.variationProfile?.anchor || '',
              structure: plan.variationProfile?.structure || '',
              arc: plan.variationProfile?.arc || '',
              tempo: plan.variationProfile?.tempo || '',
              distance: plan.variationProfile?.distance || '',
              spark: plan.variationProfile?.spark || '',
              socialMask: plan.variationProfile?.socialMask || '',
              freshnessMode: plan.variationProfile?.freshnessMode || '',
              voiceEdge: plan.variationProfile?.voiceEdge || '',
              tropeFingerprint: plan.tropeFingerprint || ''
            },
            candidates: picked.ranked.map((item) => ({
              fingerprint: item.fingerprint,
              score: item.score,
              similarity: item.similarity,
              noveltyScore: item.noveltyScore,
              tropeCollisionScore: item.tropeCollisionScore,
              circleNaturalnessScore: item.circleNaturalnessScore,
              edgeTensionScore: item.edgeTensionScore,
              variantType: item.variantType,
              tropeFingerprint: item.tropeFingerprint,
              rejected: item.rejected,
              rejectionReason: item.rejectionReason
            }))
          }));
          return {
            text: picked.selected.text,
            fingerprint: picked.selected.fingerprint,
            variationProfile: plan.variationProfile || null,
            topicGroup: plan.theme?.key ? String(plan.theme.key).split('.')[0] : (payload.topicGroup || ''),
            plan,
            candidates: picked.ranked,
            meta: {
              ...qzoneMemoryMeta,
              similarity: picked.selected.similarity,
              selectedScore: picked.selected.score,
              noveltyScore: picked.selected.noveltyScore,
              tropeCollisionScore: picked.selected.tropeCollisionScore,
              circleNaturalnessScore: picked.selected.circleNaturalnessScore,
              edgeTensionScore: picked.selected.edgeTensionScore,
              memoryEvidenceSources: Array.isArray(qzoneMemoryMeta.memoryEvidenceSources) && qzoneMemoryMeta.memoryEvidenceSources.length
                ? qzoneMemoryMeta.memoryEvidenceSources
                : (Array.isArray(qzoneMemoryEvidence.sources) ? qzoneMemoryEvidence.sources : [])
            }
          };
        }
        lastFailure = picked.ranked[0]?.rejectionReason || 'qzone_phase2_candidate_rejected';
        lastFailureClass = 'similarity';
        appendQzoneGenerationLog(normalizeTelemetryPayload({
          source: 'daily_share',
          type,
          groupId: targetId,
          status: 'failed',
          selectedFingerprint: '',
          selectedScore: 0,
          similarity: 0,
          failureReasons: picked.ranked.map((item) => item.rejectionReason).filter(Boolean),
          planSummary: {
            fingerprint: plan.fingerprint,
            topicKey: plan.theme?.key || payload.topicKey || '',
            topicGroup: plan.theme?.key ? String(plan.theme.key).split('.')[0] : (payload.topicGroup || ''),
            lens: plan.variationProfile?.lens || '',
            anchor: plan.variationProfile?.anchor || '',
            structure: plan.variationProfile?.structure || '',
            arc: plan.variationProfile?.arc || '',
            tempo: plan.variationProfile?.tempo || '',
            distance: plan.variationProfile?.distance || '',
            spark: plan.variationProfile?.spark || '',
            socialMask: plan.variationProfile?.socialMask || '',
            freshnessMode: plan.variationProfile?.freshnessMode || '',
            voiceEdge: plan.variationProfile?.voiceEdge || '',
            tropeFingerprint: plan.tropeFingerprint || ''
          },
          candidates: picked.ranked.map((item) => ({
            fingerprint: item.fingerprint,
            score: item.score,
            similarity: item.similarity,
            noveltyScore: item.noveltyScore,
            tropeCollisionScore: item.tropeCollisionScore,
            circleNaturalnessScore: item.circleNaturalnessScore,
            edgeTensionScore: item.edgeTensionScore,
            variantType: item.variantType,
            tropeFingerprint: item.tropeFingerprint,
            rejected: item.rejected,
            rejectionReason: item.rejectionReason
          }))
        }));
      }
      throw new Error(lastFailure || 'daily-share-validation-failed');
    }

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      const variationProfile = normalizedSurface === 'qzone'
        ? sampleVariationProfile({
          source: 'daily_share',
          type,
          windowKey,
          groupId: targetId,
          today: stateEntry?.today || '',
          attempt,
          now,
          recentHistory: recentQzoneHistory
        })
        : null;
      const promptBase = normalizedSurface === 'qzone' && typeof payload.buildPrompt === 'function'
        ? payload.buildPrompt({
          variationProfile,
          recentHistory: recentQzoneHistory
        })
        : payload.prompt;
      const prompt = attempt === 0
        ? [promptBase, payload.prompt].filter(Boolean).join('\n\n')
        : [
          promptBase,
          payload.prompt,
          buildVariationConstraintPrompt({ recentHistory: recentQzoneHistory }),
          `上一次结果不合格，失败原因：${lastFailure || 'unknown'}。这次必须避开相同问题并重新生成。`
        ].filter(Boolean).join('\n\n');
      const modelConfig = normalizedSurface === 'qzone'
        ? getModelConfigForQzoneAttempt(lastFailureClass)
        : null;
      const reply = await askAIByGraph(prompt, userInfo, userId, prompt, null, {
        systemInitiated: true,
        topRouteType: 'proactive',
        routePolicyKey: 'proactive/daily-share',
        disableTools: true,
        disableStream: true,
        disableMemoryLearning: true,
        modelConfig,
        routeMeta: {
          groupId: String(groupId || ''),
          taskType: 'daily_share',
          channelId: String(targetId),
          windowKey,
          shareType: type,
          surface: normalizedSurface
        }
      });

      const text = trimReplyText(reply, 260);
      if (!text) {
        lastFailure = 'empty-daily-share-reply';
        lastFailureClass = 'validation';
        continue;
      }

      const validation = validateDailyShareOutput(text, type, normalizedSurface);
      if (!validation.ok) {
        lastFailure = validation.reason;
        lastFailureClass = 'validation';
        logDailyShare({
          groupId: targetId,
          windowKey,
          type,
          reason: validation.reason,
          source: payload.source || '',
          event: attempt === 0 ? 'validator retry' : 'validator fail'
        });
        continue;
      }

      const fingerprint = normalizeDailyShareFingerprint(text);
      const recentFingerprints = (Array.isArray(stateEntry.recentContentFingerprints) ? stateEntry.recentContentFingerprints : [])
        .map((item) => String(item?.key || '').trim().toLowerCase())
        .filter(Boolean);
      if (fingerprint && recentFingerprints.includes(fingerprint)) {
        lastFailure = 'recent-content-duplicate';
        lastFailureClass = 'duplicate';
        logDailyShare({
          groupId: targetId,
          windowKey,
          type,
          reason: lastFailure,
          source: payload.source || '',
          event: attempt === 0 ? 'validator retry' : 'validator fail'
        });
        continue;
      }

      return {
        text,
        fingerprint,
        variationProfile: null,
        topicGroup: payload.topicGroup || '',
        meta: {
          ...qzoneMemoryMeta,
          memoryEvidenceSources: Array.isArray(qzoneMemoryMeta.memoryEvidenceSources) && qzoneMemoryMeta.memoryEvidenceSources.length
            ? qzoneMemoryMeta.memoryEvidenceSources
            : (Array.isArray(qzoneMemoryEvidence.sources) ? qzoneMemoryEvidence.sources : [])
        }
      };
    }

    throw new Error(lastFailure || 'daily-share-validation-failed');
  }

  async function sendShare({
    sendWithRetry,
    askAIByGraph,
    groupId,
    windowKey,
    type,
    today = getToday(),
    advancePointer = false,
    manual = false,
    now = Date.now(),
    surface = 'group'
  }) {
    const normalizedSurface = String(surface || 'group').trim().toLowerCase() || 'group';
    const targetId = normalizedSurface === 'qzone' ? QZONE_TARGET_ID : groupId;
    const { target, stateEntry } = ensureTargetState(targetId, today);
    const windowDef = getWindowDefinitions(target).find((item) => item.key === windowKey) || {
      key: windowKey,
      label: windowKey,
      startMinutes: 0,
      endMinutes: 0
    };

    const payload = await resolvedContentBuilder.build({
      type,
      groupId,
      windowKey,
      windowLabel: windowDef.label,
      stateEntry,
      targetConfig: target,
      today,
      now,
      surface: normalizedSurface
    });
    payload.windowLabel = payload.windowLabel || windowDef.label;

    if (payload.topicRelaxed) {
      logDailyShare({
        groupId: targetId,
        windowKey,
        type,
        reason: 'topic-relaxed-7d',
        event: 'dedupe relaxed'
      });
    }

    const generated = await generateValidatedShare({
      askAIByGraph,
      targetId,
      groupId,
      windowKey,
      type,
      payload,
      stateEntry,
      now,
      surface: normalizedSurface
    });

    let initiativeLockOwner = '';
    let initiativePolicy = null;
    if (normalizedSurface === 'group') {
      initiativePolicy = evaluateInitiativePolicy({
        source: 'daily_share',
        groupId,
        userId: '',
        candidateReason: 'daily_share',
        contextHints: {
          primaryContext: type,
          secondaryContext: payload?.topicLabel || '',
          windowKey
        }
      }, now);
      if (!initiativePolicy.allowed) {
        const status = stateEntry.windowStatus[windowKey];
        const schedule = stateEntry.scheduleByWindow[windowKey];
        schedule.deferred = true;
        schedule.deferredAt = now + (Math.max(1, Number(target.deferMinutes || 8)) * 60 * 1000);
        status.status = 'deferred';
        status.lastReason = initiativePolicy.reason;
        status.lastAttemptAt = now;
        flush();
        return { sent: false, deferred: true, reason: initiativePolicy.reason, text: '' };
      }
      initiativeLockOwner = `daily_share:${groupId}:${windowKey}:${type}`;
      const initiativeLock = acquireInitiativeLock({
        groupId,
        owner: initiativeLockOwner,
        now
      });
      if (!initiativeLock.acquired) {
        return { sent: false, deferred: true, reason: initiativeLock.reason, text: '' };
      }
    }

    let deliveredText = generated.text;
    try {
      if (normalizedSurface === 'qzone') {
        const publish = typeof qzonePublisher === 'function'
          ? qzonePublisher
          : async (payload) => runQzoneAgent(payload, {
            groupId: QZONE_TARGET_ID,

userId: String((config.ADMIN_USER_IDS || [])[0] || 'system')
          }, {
            publishPolicy: 'auto_publish',
            qzoneSource: 'daily_share',
            qzoneType: type,
            now,
            helpers: {
              tryGenerateBotDiaryQzoneImage,
              cleanupLocalImage
            }
          });
        const result = await publish({
          mode: 'agent',
          hint: generated.text,
          content: generated.text,
          source: 'daily_share',
          type,
          publishPolicy: 'auto_publish',
          windowKey,
          shareType: type,
          topicKey: payload.topicKey || '',
          topicGroup: payload.topicGroup || generated.topicGroup || '',
          imageIntent: generated.plan?.imageIntent || generated.meta?.imageIntent || null,
          imagePromptHints: generated.plan?.imagePromptHints || generated.meta?.imagePromptHints || []
        });
        if (!(result?.ok || result?.success)) {
          throw new Error(String(result?.reason || 'daily-share-send-failed'));
        }
        deliveredText = String(result?.content || generated.text || '').trim();
      } else {
        const sent = await sendGroupReply({
          sendWithRetry,
          groupId,
          senderId: '',
          replyText: generated.text,
          atSender: false,
          retries: 1,
          waitMs: 300,
          source: 'daily_share',
          routePolicyKey: 'proactive/daily-share',
          triggerReason: manual ? 'manual-send' : 'auto-send',
          topRouteType: 'proactive',
          routeMeta: {
            groupId,
            windowKey,
            shareType: type,
            manual,
            topicKey: payload.topicKey || ''
          }
        });
        if (!sent) throw new Error('daily-share-send-failed');

        recordSystemGroupSend({
          groupId,
          senderId: '',
          text: generated.text,
          senderName: '鐟炲笇',
          updatePresence: true,
          updateBotPresence: true,
          now,
          source: 'daily_share',
          routePolicyKey: 'proactive/daily-share'
        });
        const dailyShareCycleKey = String(initiativePolicy.cycleKey || '').trim();
        markInitiativeSent(groupId, {
          source: 'daily_share',
          reason: 'daily_share',
          cycleKey: dailyShareCycleKey
        }, now);
        if (dailyShareCycleKey) {
          setLastCycleKey(groupId, dailyShareCycleKey, now);
        }
      }
    } finally {
      if (initiativeLockOwner) {
        releaseInitiativeLock({
          groupId,
          owner: initiativeLockOwner,
          now: Date.now()
        });
      }
    }

    if (!manual) {
      stateEntry.dailyCount = Math.max(0, Number(stateEntry.dailyCount || 0) || 0) + 1;
    }

    const status = stateEntry.windowStatus[windowKey];
    const schedule = stateEntry.scheduleByWindow[windowKey];
    if (!manual) {
      schedule.sentCount = Math.max(0, Number(schedule.sentCount || 0) || 0) + 1;
      schedule.lastSentAt = now;
      schedule.deferred = false;
      schedule.deferredAt = 0;
      schedule.cooldownUntil = 0;
      schedule.completedAt = now;
      if (getWindowRemainingCapacity(schedule) > 0) {
        const nextPlan = now + (Math.max(1, Number(target.deferMinutes || 8)) * 60 * 1000);
        schedule.plannedAt = nextPlan;
        status.status = 'pending';
      } else {
        status.status = 'sent';
      }
    }

    status.lastReason = manual ? 'manual-send' : 'auto-send';
    status.lastAttemptAt = now;
    status.lastSuccessType = type;
    if (manual) {
      status.lastManualAt = now;
    }

    appendRecentShare(stateEntry, {
      at: now,
      windowKey,
      type,
      summary: trimReplyText(deliveredText, 120),
      topicKey: payload.topicKey || '',
      contentKey: payload.contentKey || ''
    });
    appendRecentContentFingerprint(stateEntry, normalizeDailyShareFingerprint(deliveredText) || generated.fingerprint, now);

    if (payload.topicKey) {
      stateEntry.recentTopicKeys = appendRecentKey(stateEntry.recentTopicKeys, payload.topicKey, now, 120);
    }
    if (advancePointer) {
      advanceWindowPointer(target, stateEntry, windowKey);
    }

    flush();
    logDailyShare({
      groupId: targetId,
      windowKey,
      type,
      reason: manual ? 'manual-send' : 'auto-send',
      source: payload.source || '',
      event: 'send success'
    });
    return { sent: true, text: deliveredText, type, meta: generated.meta || {} };
  }

  async function runGroupShareCycle({ sendWithRetry, askAIByGraph, today, date, now }) {
    const outboundGate = shouldAllowProactiveGroupOutbound({
      source: 'daily_share',
      runtimeConfig: config
    });
    if (!outboundGate.allowed) {
      logDailyShare({
        reason: outboundGate.reason,
        event: 'group outbound disabled'
      });
      return { ran: false, skipped: true, reason: outboundGate.reason };
    }

    const { targets, state } = ensureCaches(today);

    for (const [groupId] of Object.entries(targets || {})) {
      if (groupId === QZONE_TARGET_ID) continue;

      const target = ensureTarget(targets, groupId);
      if (!target.enabled) continue;

      const stateEntry = ensureStateEntry(state, groupId, today);
      if (stateEntry.today !== today) {
        state[groupId] = resetGroupState(stateEntry, today);
      }
      const freshState = ensureStateEntry(state, groupId, today);
      if (freshState.dailyCount >= target.maxPerDay) {
        logDailyShare({ groupId, reason: 'daily-quota-reached', event: 'skip' });
        continue;
      }

      for (const windowDef of getWindowDefinitions(target)) {
        const liveState = ensureStateEntry(state, groupId, today);
        ensureWindowSchedule(liveState, groupId, windowDef, today, date, target);
        if (!shouldRunWindowNow({ entry: liveState, windowDef, now, date, targetConfig: target })) { continue; }

        const gate = shouldDeferOrSkip({
          groupId,
          targetConfig: target,
          windowDef,
          stateEntry: liveState,
          now
        });
        if (!gate.allowed) {
          flush();
          continue;
        }

        const type = getAutoTypeForWindow(target, liveState, windowDef.key);
        if (!type) continue;

        try {
          const result = await sendShare({
            sendWithRetry,
            askAIByGraph,
            groupId,
            windowKey: windowDef.key,
            type,
            today,
            advancePointer: true,
            manual: false,
            now,
            surface: 'group'
          });
          if (result && result.sent === false) continue;
        } catch (error) {
          const currentState = ensureStateEntry(state, groupId, today);
          const failure = classifyDailyShareGenerationFailure(error);
          const schedule = currentState.scheduleByWindow[windowDef.key];
          if (failure.shouldCooldownWindow) {
            const cooldownMs = getDailyShareFailureCooldownMs(target, error);
            schedule.deferred = true;
            schedule.deferredAt = now + cooldownMs;
            schedule.cooldownUntil = now + cooldownMs;
            logDailyShare({
              groupId,
              windowKey: windowDef.key,
              type,
              reason: `cooldown:${failure.message || 'tool_error'}`,
              event: 'failure cooldown'
            });
          }
          logDailyShare({
            groupId,
            windowKey: windowDef.key,
            type,
              reason: failure.message || error?.message || String(error),
              event: 'send fail'
            });
          const status = currentState.windowStatus[windowDef.key];
          status.status = 'failed';
          status.lastReason = failure.message || error?.message || String(error);
          status.lastAttemptAt = now;
          flush();
        }
      }
    }
    return { ran: true, skipped: false, reason: '' };
  }

  async function runQzoneShareCycle({ sendWithRetry, askAIByGraph, today, date, now }) {
    const { targets, state } = ensureCaches(today);
    const target = ensureTarget(targets, QZONE_TARGET_ID);
    if (!target.enabled) return;

    const stateEntry = ensureStateEntry(state, QZONE_TARGET_ID, today);
    if (stateEntry.today !== today) {
      state[QZONE_TARGET_ID] = resetGroupState(stateEntry, today);
    }
    const freshState = ensureStateEntry(state, QZONE_TARGET_ID, today);
    if (freshState.dailyCount >= target.maxPerDay) {
      logDailyShare({ groupId: QZONE_TARGET_ID, reason: 'daily-quota-reached', event: 'skip' });
      return;
    }

    for (const windowDef of getWindowDefinitions(target)) {
      const liveState = ensureStateEntry(state, QZONE_TARGET_ID, today);
      ensureWindowSchedule(liveState, QZONE_TARGET_ID, windowDef, today, date, target);
      if (!shouldRunWindowNow({ entry: liveState, windowDef, now, date, targetConfig: target })) { continue; }

      const type = getAutoTypeForWindow(target, liveState, windowDef.key);
      if (!type) continue;

      try {
        await sendShare({
          sendWithRetry,
          askAIByGraph,
          groupId: '',
          windowKey: windowDef.key,
          type,
          today,
          advancePointer: true,
          manual: false,
          now,
          surface: 'qzone'
        });
      } catch (error) {
        const currentState = ensureStateEntry(state, QZONE_TARGET_ID, today);
        const failure = classifyDailyShareGenerationFailure(error);
        const schedule = currentState.scheduleByWindow[windowDef.key];
        if (failure.shouldCooldownWindow) {
          const cooldownMs = getDailyShareFailureCooldownMs(target, error);
          schedule.deferred = true;
          schedule.deferredAt = now + cooldownMs;
          schedule.cooldownUntil = now + cooldownMs;
          logDailyShare({
            groupId: QZONE_TARGET_ID,
            windowKey: windowDef.key,
            type,
            reason: `cooldown:${failure.message || 'tool_error'}`,
            event: 'failure cooldown'
          });
        }
        logDailyShare({
          groupId: QZONE_TARGET_ID,
          windowKey: windowDef.key,
          type,
            reason: failure.message || error?.message || String(error),
            event: 'send fail'
          });
        const status = currentState.windowStatus[windowDef.key];
        status.status = 'failed';
        status.lastReason = failure.message || error?.message || String(error);
        status.lastAttemptAt = now;
        flush();
      }
    }
  }

  async function runDailyShareCycle({ sendWithRetry, askAIByGraph, date = new Date() }) {
    if (!config.DAILY_SHARE_ENABLED) return { ran: false, reason: 'disabled' };
    const pressureDelayMs = getBackgroundPressureDelayMs();
    if (pressureDelayMs > 0) {
      appendPerfEvent({
        category: 'background_pressure',
        type: 'daily_share_deferred',
        delayMs: pressureDelayMs
      });
      return { ran: false, reason: 'resource_pressure_deferred', deferMs: pressureDelayMs };
    }

    const today = getToday(date);
    const now = date.getTime();
    const groupOutbound = await runGroupShareCycle({ sendWithRetry, askAIByGraph, today, date, now });
    await runQzoneShareCycle({ sendWithRetry, askAIByGraph, today, date, now });
    flush();
    return { ran: true, groupOutbound };
  }

  async function handleAdminCommand({
    rawText,
    groupId,
    userId,
    sendWithRetry,
    askAIByGraph,
    date = new Date()
  }) {
    const text = String(rawText || '').trim();
    if (!/^\/dailyshare(?:\s|$)/i.test(text)) return null;
    if (!String(groupId || '').trim()) return { handled: true, replyText: '这个要在群里才接得住啦。' };
    if (!isAdmin(userId)) return { handled: true, replyText: '这个按钮现在只给管理员按哦。' };

    const today = getToday(date);
    const parts = text.split(/\s+/).slice(1);
    const namespace = String(parts[0] || 'status').trim().toLowerCase();
    const isQzoneCommand = namespace === 'qzone';
    const targetId = isQzoneCommand ? QZONE_TARGET_ID : groupId;
    const { target, stateEntry } = isQzoneCommand ? ensureQzone(today) : ensureGroup(groupId, today);
    const sub = String(isQzoneCommand ? (parts[1] || 'status') : namespace).trim().toLowerCase();
    const runArgIndex = isQzoneCommand ? 2 : 1;

    if (sub === 'status') {
      flush();
      return { handled: true, replyText: formatStatusForTarget(targetId, today, date) };
    }

    if (isQzoneCommand && sub === 'debug') {
      return { handled: true, replyText: summarizeQzoneDebug(20) };
    }

    if (isQzoneCommand && sub === 'summary') {
      return { handled: true, replyText: summarizeQzoneWindowStats(7) };
    }

    if (sub === 'enable') {
      target.enabled = true;
      flush();
      return { handled: true, replyText: isQzoneCommand ? 'qzone daily share 已启用。' : 'daily share 已启用。' };
    }

    if (sub === 'disable') {
      target.enabled = false;
      flush();
      return { handled: true, replyText: isQzoneCommand ? 'qzone daily share 已禁用。' : 'daily share 已禁用。' };
    }

    if (sub === 'reset') {
      const { state } = ensureCaches(today);
      state[String(targetId)] = resetGroupState(stateEntry, today);
      flush();
      return { handled: true, replyText: isQzoneCommand ? 'qzone daily share 当前状态已重置。' : 'daily share 当前群当日状态已重置。' };
    }

    if (sub === 'run') {
      const requested = String(parts[runArgIndex] || 'auto').trim().toLowerCase();
      const typeAllowed = isQzoneCommand ? isManualQzoneDailyShareType(requested) : isManualDailyShareType(requested);
      if (requested !== 'auto' && !typeAllowed) {
        return {
          handled: true,
          replyText: isQzoneCommand
            ? '仅支持 `/dailyshare qzone run [auto|greeting|mood|recommendation]`。'
            : '仅支持 `/dailyshare run [auto|greeting|mood|knowledge|recommendation]`。'
        };
      }

      const currentWindow = findCurrentWindow(target, date);
      if (requested === 'auto' && !currentWindow) {
        return {
          handled: true,
          replyText: isQzoneCommand
            ? '当前不在任何 QZone 自动窗口内，`/dailyshare qzone run auto` 未执行。'
            : '当前不在任何自动窗口内，`/dailyshare run auto` 未执行。'
        };
      }

      const windowDef = currentWindow || getWindowDefinitions(target)[0];
      const type = requested === 'auto'
        ? getAutoTypeForWindow(target, stateEntry, windowDef.key)
        : requested;
      if (!type) {
        return { handled: true, replyText: '当前窗口没有可用的自动分享类型。' };
      }

      try {
        if (!isQzoneCommand) {
          const outboundGate = shouldAllowProactiveGroupOutbound({
            source: 'daily_share',
            groupId,
            runtimeConfig: config
          });
          if (!outboundGate.allowed) {
            return {
              handled: true,
              replyText: `未发送：${outboundGate.reason}`
            };
          }
        }

        await sendShare({
          sendWithRetry,
          askAIByGraph,
          groupId: isQzoneCommand ? '' : groupId,
          windowKey: windowDef.key,
          type,
          today,
          advancePointer: requested === 'auto',
          manual: requested !== 'auto',
          now: date.getTime(),
          surface: isQzoneCommand ? 'qzone' : 'group'
        });
      } catch (error) {
        return {
          handled: true,
          replyText: `执行失败：${error?.message || String(error)}`
        };
      }

      return {
        handled: true,
        replyText: requested === 'auto'
          ? `已执行 auto，窗口 ${windowDef.label}，自动序列已推进。`
          : `已执行 ${type}，未修改自动序列指针。`
      };
    }

    return {
      handled: true,
      replyText: isQzoneCommand
        ? '可用命令：/dailyshare qzone status | debug | summary | enable | disable | run [auto|greeting|mood|recommendation] | reset'
        : '可用命令：/dailyshare status | enable | disable | run [auto|greeting|mood|knowledge|recommendation] | reset'
    };
  }

  return {
    formatStatus,
    handleAdminCommand,
    runDailyShareCycle
  };
}

module.exports = { createDailyShareEngine };
