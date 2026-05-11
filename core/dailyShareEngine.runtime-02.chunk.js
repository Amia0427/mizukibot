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
          waitMs: 300
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
          await sendShare({
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
    await runGroupShareCycle({ sendWithRetry, askAIByGraph, today, date, now });
    await runQzoneShareCycle({ sendWithRetry, askAIByGraph, today, date, now });
    flush();
    return { ran: true };
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
    if (!String(groupId || '').trim()) return { handled: true, replyText: '仅群聊可用。' };
    if (!isAdmin(userId)) return { handled: true, replyText: '仅管理员可用。' };

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

