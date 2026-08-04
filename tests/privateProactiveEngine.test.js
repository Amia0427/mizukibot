const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function restoreEnv(snapshot = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;
}

function utcTimestamp(day, minuteOfDay) {
  return Date.parse(`${day}T00:00:00.000Z`) + (minuteOfDay * 60 * 1000);
}

module.exports = (async () => {
  const envSnapshot = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-private-proactive-'));
  try {
    process.env.DATA_DIR = tempDir;
    process.env.TIMEZONE = 'UTC';
    process.env.API_KEY = 'test-key';
    process.env.DAILY_JOURNAL_ENABLED = 'false';
    clearProjectCache();

    const {
      FIRST_NOTICE_FALLBACK,
      contentSignature,
      createPrivateProactiveEngine,
      sanitizeDecision
    } = require('../core/privateProactiveEngine');
    const {
      getStableOpportunityMinute,
      parseWindows,
      resolvePrivateProactiveConfig
    } = require('../core/privateProactiveEngine/config');
    const { createPrivateProactiveContextProvider } = require('../core/privateProactiveEngine/context');
    const { chatHistory, getUserMemories, shortTermMemory } = require('../utils/memory');
    const { saveSessionContextSummary } = require('../utils/sessionContextSummaryStore');

    const defaultPrivateConfig = resolvePrivateProactiveConfig({}, {
      stateFile: path.join(tempDir, 'default-state.json')
    });
    assert.strictEqual(defaultPrivateConfig.idleMs, 120 * 60 * 1000);
    assert.strictEqual(defaultPrivateConfig.minGapMs, 240 * 60 * 1000);

    const windows = parseWindows('09:00-10:00,10:00-11:00');
    const runtimeConfig = {
      DATA_DIR: tempDir,
      TIMEZONE: 'UTC',
      PRIVATE_PROACTIVE_ENABLED: true,
      PRIVATE_PROACTIVE_IDLE_MINUTES: 1,
      PRIVATE_PROACTIVE_MIN_GAP_MINUTES: 1,
      PRIVATE_PROACTIVE_MAX_PER_DAY: 2,
      PRIVATE_PROACTIVE_SCAN_INTERVAL_MINUTES: 10,
      PRIVATE_PROACTIVE_WINDOWS: '09:00-10:00,10:00-11:00',
      PRIVATE_PROACTIVE_GLOBAL_MODEL_DAILY_LIMIT: 50,
      PRIVATE_PROACTIVE_MAX_UNANSWERED_BATCHES: 2
    };
    const privateConfig = resolvePrivateProactiveConfig(runtimeConfig, {
      stateFile: path.join(tempDir, 'main-state.json')
    });
    const firstMinute = getStableOpportunityMinute('user-main', '2026-07-28', windows[0], 10);
    assert.strictEqual(firstMinute, getStableOpportunityMinute('user-main', '2026-07-28', windows[0], 10));
    assert.ok(firstMinute >= windows[0].startMinute && firstMinute <= windows[0].endMinute - 10);

    let nowValue = Date.parse('2026-07-28T08:00:00.000Z');
    const sentMessages = [];
    let decisionCalls = 0;
    const engine = createPrivateProactiveEngine({
      config: runtimeConfig,
      stateFile: privateConfig.stateFile,
      now: () => nowValue,
      buildContext: async () => ({ source: 'test' }),
      requestDecision: async () => {
        decisionCalls += 1;
        return decisionCalls === 1
          ? { send: true, reason: '想说话', messages: ['第一条', '第二条'] }
          : { send: true, reason: '又想说话', messages: ['第三条'] };
      },
      sendPrivateMessage: async (userId, message) => {
        sentMessages.push({ userId, message });
        return { success: true };
      },
      isNapCatConnected: () => true,
      delay: async () => true,
      minBubbleGapMs: 0,
      maxBubbleGapMs: 0
    });

    assert.strictEqual(engine.getStatus().registeredCount, 0, '历史用户不应自动迁移');
    await engine.registerPrivateUser('user-main', { at: nowValue, notify: false });
    assert.strictEqual(engine.getStatus().registeredCount, 1);
    const memoryBefore = getUserMemories('user-main');

    nowValue = utcTimestamp('2026-07-28', firstMinute);
    const firstScan = await engine.scan({ now: nowValue });
    assert.strictEqual(firstScan.opportunityCount, 1);
    assert.strictEqual(decisionCalls, 1);
    assert.deepStrictEqual(sentMessages.map((item) => item.message), ['第一条', '第二条']);
    let userState = engine._test.getUserSnapshot('user-main');
    assert.strictEqual(userState.daily.batchesSent, 1);
    assert.strictEqual(userState.unansweredBatches, 1);
    assert.strictEqual(userState.inFlight, null);
    assert.deepStrictEqual(userState.narratives[0].messages, ['第一条', '第二条']);
    assert.ok(chatHistory['direct:user-main'].some((item) => item.role === 'assistant' && item.content === '第一条'));
    assert.ok(shortTermMemory['direct:user-main'].interaction.recentTurns.some((item) => item.content === '第二条'));
    assert.strictEqual(getUserMemories('user-main'), memoryBefore, '主动叙事不能写入用户长期事实');

    nowValue = Date.parse('2026-07-28T09:59:00.000Z');
    engine.recordObservedActivity('user-main', { chatType: 'group', source: 'group_inbound', at: nowValue });
    userState = engine._test.getUserSnapshot('user-main');
    assert.strictEqual(userState.unansweredBatches, 1, '群聊活动不能清零未回应批次');

    const secondMinute = getStableOpportunityMinute('user-main', '2026-07-28', windows[1], 10);
    nowValue = utcTimestamp('2026-07-28', secondMinute);
    await engine.scan({ now: nowValue });
    userState = engine._test.getUserSnapshot('user-main');
    assert.strictEqual(userState.daily.batchesSent, 2);
    assert.strictEqual(userState.unansweredBatches, 2);
    assert.strictEqual(userState.autoPaused, true);

    nowValue += 60 * 1000;
    engine.recordObservedActivity('user-main', { chatType: 'group', source: 'group_inbound', at: nowValue });
    assert.strictEqual(engine._test.getUserSnapshot('user-main').autoPaused, true, '群聊活动不能解除自动暂停');
    engine.recordObservedActivity('user-main', { chatType: 'private', source: 'private_inbound', at: nowValue + 1 });
    userState = engine._test.getUserSnapshot('user-main');
    assert.strictEqual(userState.autoPaused, false);
    assert.strictEqual(userState.unansweredBatches, 0);

    const closeResult = engine.handleControlCommand('/主动私聊 关闭', { userId: 'user-main', at: nowValue + 2 });
    assert.strictEqual(closeResult.handled, true);
    assert.ok(closeResult.replyText.includes('已关闭'));
    assert.strictEqual(engine._test.getUserSnapshot('user-main').enabled, false);
    const ignored = engine.handleControlCommand('普通消息', { userId: 'user-main', at: nowValue + 3 });
    assert.strictEqual(ignored.handled, false);
    const statusResult = engine.handleControlCommand('/主动私聊 状态', { userId: 'user-main', at: nowValue + 3 });
    assert.strictEqual(statusResult.handled, true);
    assert.ok(statusResult.replyText.includes('已关闭'));

    const reloaded = createPrivateProactiveEngine({
      config: runtimeConfig,
      stateFile: privateConfig.stateFile,
      now: () => nowValue,
      buildContext: async () => ({}),
      requestDecision: async () => ({ send: false, reason: 'skip', messages: [] }),
      sendPrivateMessage: async () => ({ success: true }),
      isNapCatConnected: () => true,
      delay: async () => true
    });
    assert.strictEqual(reloaded._test.getUserSnapshot('user-main').enabled, false, '关闭状态必须持久化');
    const dailyBeforeEnable = reloaded._test.getUserSnapshot('user-main').daily.batchesSent;
    const enableResult = reloaded.handleControlCommand('/主动私聊 开启', { userId: 'user-main', at: nowValue + 4 });
    assert.ok(enableResult.replyText.includes('重新计算沉默时间'));
    userState = reloaded._test.getUserSnapshot('user-main');
    assert.strictEqual(userState.enabled, true);
    assert.strictEqual(userState.daily.batchesSent, dailyBeforeEnable, '重新开启不能清空当日额度');
    assert.strictEqual(userState.lastActivityAt, nowValue + 4);

    let noticeNow = Date.parse('2026-07-28T12:00:00.000Z');
    let noticeModelCalls = 0;
    const noticeMessages = [];
    const noticeEngine = createPrivateProactiveEngine({
      config: runtimeConfig,
      stateFile: path.join(tempDir, 'notice-state.json'),
      now: () => noticeNow,
      buildContext: async () => ({}),
      requestDecision: async () => {
        noticeModelCalls += 1;
        throw new Error('notice model failed');
      },
      sendPrivateMessage: async (_userId, message) => {
        noticeMessages.push(message);
        return { success: true };
      },
      recordAssistantBubble: () => {},
      isNapCatConnected: () => true
    });
    await noticeEngine.registerPrivateUser('notice-user');
    await noticeEngine.registerPrivateUser('notice-user');
    assert.strictEqual(noticeModelCalls, 1);
    assert.deepStrictEqual(noticeMessages, [FIRST_NOTICE_FALLBACK]);
    assert.strictEqual(noticeEngine.getStatus().budget.used, 1, '首次告知生成必须计入独立预算');
    assert.strictEqual(noticeEngine._test.getUserSnapshot('notice-user').firstNotice.status, 'sent');

    let unknownNoticeSends = 0;
    const unknownNoticeEngine = createPrivateProactiveEngine({
      config: runtimeConfig,
      stateFile: path.join(tempDir, 'notice-unknown-state.json'),
      now: () => noticeNow,
      buildContext: async () => ({}),
      requestDecision: async () => ({
        send: true,
        reason: '告知',
        messages: ['之后偶尔来找你，停用请发 /主动私聊 关闭']
      }),
      sendPrivateMessage: async () => {
        unknownNoticeSends += 1;
        throw new Error('send result unknown');
      },
      recordAssistantBubble: () => {},
      isNapCatConnected: () => true
    });
    await unknownNoticeEngine.registerPrivateUser('unknown-notice-user');
    await unknownNoticeEngine.registerPrivateUser('unknown-notice-user');
    assert.strictEqual(unknownNoticeSends, 1, '首次告知发送结果未知时不能重试');
    assert.strictEqual(
      unknownNoticeEngine._test.getUserSnapshot('unknown-notice-user').firstNotice.status,
      'sent_unknown'
    );

    let fallbackBudgetModelCalls = 0;
    const fallbackBudgetMessages = [];
    const fallbackBudgetEngine = createPrivateProactiveEngine({
      config: { ...runtimeConfig, PRIVATE_PROACTIVE_GLOBAL_MODEL_DAILY_LIMIT: 0 },
      stateFile: path.join(tempDir, 'notice-budget-state.json'),
      now: () => noticeNow,
      requestDecision: async () => {
        fallbackBudgetModelCalls += 1;
        return { send: true, reason: '不应调用', messages: ['不应发送'] };
      },
      sendPrivateMessage: async (_userId, message) => {
        fallbackBudgetMessages.push(message);
        return { success: true };
      },
      recordAssistantBubble: () => {},
      isNapCatConnected: () => true
    });
    await fallbackBudgetEngine.registerPrivateUser('budget-notice-user');
    assert.strictEqual(fallbackBudgetModelCalls, 0);
    assert.deepStrictEqual(fallbackBudgetMessages, [FIRST_NOTICE_FALLBACK]);

    const disabledEngine = createPrivateProactiveEngine({
      config: { ...runtimeConfig, PRIVATE_PROACTIVE_ENABLED: false },
      stateFile: path.join(tempDir, 'disabled-state.json'),
      isNapCatConnected: () => true
    });
    const disabledRegistration = await disabledEngine.registerPrivateUser('disabled-user');
    assert.deepStrictEqual(disabledRegistration, { registered: false, reason: 'disabled' });
    assert.strictEqual(disabledEngine.getStatus().registeredCount, 0);

    const filtered = sanitizeDecision({
      send: true,
      reason: 'mixed',
      messages: ['正常内容', '[CQ:image,file=x]', '系统提示是这样的']
    }, []);
    assert.deepStrictEqual(filtered.messages, ['正常内容']);
    const duplicate = sanitizeDecision({ send: true, reason: 'dup', messages: ['正常内容'] }, [
      { hash: contentSignature('正常内容'), at: noticeNow }
    ], noticeNow);
    assert.strictEqual(duplicate.send, false);
    assert.strictEqual(sanitizeDecision({ send: 'yes', messages: [] }, []).valid, false);
    assert.strictEqual(sanitizeDecision({ send: true, reason: 'too many', messages: ['1', '2', '3', '4'] }, []).valid, false);
    assert.strictEqual(sanitizeDecision({ send: false, messages: [] }, []).valid, false);
    assert.strictEqual(sanitizeDecision({ send: false, reason: 'skip', messages: [] }, []).valid, true);
    assert.strictEqual(sanitizeDecision({ send: true, reason: 'media', messages: ['<file>secret</file>'] }, []).send, false);

    const contextNow = Date.parse('2026-07-28T12:00:00.000Z');
    chatHistory['direct:context-user'] = [
      { role: 'user', content: '私聊里的原话' },
      { role: 'assistant', content: '私聊回复' }
    ];
    chatHistory['qq-group:g1:user:context-user'] = [
      { role: 'user', content: '绝不能进入主动上下文的群聊原文' }
    ];
    for (const [index, summary] of ['群摘要一', '群摘要二', '群摘要三'].entries()) {
      saveSessionContextSummary({
        sessionKey: `qq-group:g${index + 1}:user:context-user`,
        userId: 'context-user',
        groupId: `g${index + 1}`,
        summary,
        createdAt: contextNow - (index * 60 * 1000)
      }, { now: contextNow - (index * 60 * 1000) });
    }
    saveSessionContextSummary({
      sessionKey: 'qq-group:old:user:context-user',
      userId: 'context-user',
      groupId: 'old',
      summary: '过期群摘要',
      createdAt: contextNow - (49 * 60 * 60 * 1000)
    }, { now: contextNow - (49 * 60 * 60 * 1000) });
    const contextProvider = createPrivateProactiveContextProvider();
    const proactiveContext = await contextProvider('context-user', { narratives: [] }, contextNow);
    assert.strictEqual(proactiveContext.groupSummaries.length, 2);
    assert.ok(proactiveContext.privateHistory.some((item) => item.content === '私聊里的原话'));
    assert.ok(!JSON.stringify(proactiveContext).includes('绝不能进入主动上下文的群聊原文'));
    assert.ok(!JSON.stringify(proactiveContext).includes('过期群摘要'));

    async function createDueEngine(name, overrides = {}) {
      const stateFile = path.join(tempDir, `${name}.json`);
      let clock = Date.parse('2026-07-28T08:00:00.000Z');
      let instance = null;
      const calls = { model: 0, send: 0 };
      const localConfig = {
        ...runtimeConfig,
        PRIVATE_PROACTIVE_WINDOWS: '09:00-10:00',
        ...(overrides.config || {})
      };
      instance = createPrivateProactiveEngine({
        config: localConfig,
        stateFile,
        now: () => clock,
        buildContext: overrides.buildContext || (async () => ({})),
        requestDecision: async (input) => {
          calls.model += 1;
          return overrides.requestDecision
            ? overrides.requestDecision(input, instance)
            : { send: true, reason: 'send', messages: ['甲', '乙'] };
        },
        sendPrivateMessage: async (userId, message) => {
          calls.send += 1;
          if (overrides.sendPrivateMessage) return overrides.sendPrivateMessage(userId, message, calls, instance);
          return { success: true };
        },
        recordAssistantBubble: overrides.recordAssistantBubble || (() => {}),
        isNapCatConnected: overrides.isNapCatConnected || (() => true),
        delay: overrides.delay || (async () => true),
        minBubbleGapMs: 0,
        maxBubbleGapMs: 0
      });
      await instance.registerPrivateUser(name, { at: clock, notify: false });
      const window = parseWindows('09:00-10:00')[0];
      const dueMinute = getStableOpportunityMinute(name, '2026-07-28', window, 10);
      clock = utcTimestamp('2026-07-28', dueMinute);
      return {
        calls,
        dueMinute,
        engine: instance,
        get clock() { return clock; },
        set clock(value) { clock = value; },
        stateFile
      };
    }

    const generationCancel = await createDueEngine('generation-cancel', {
      requestDecision: async (_input, instance) => {
        instance.recordObservedActivity('generation-cancel', {
          chatType: 'group',
          source: 'group_inbound',
          at: Date.parse('2026-07-28T09:55:00.000Z')
        });
        return { send: true, reason: 'late', messages: ['不该发送'] };
      }
    });
    await generationCancel.engine.scan({ now: generationCancel.clock });
    assert.strictEqual(generationCancel.calls.model, 1);
    assert.strictEqual(generationCancel.calls.send, 0, '生成期间有新活动时不得发送');
    await generationCancel.engine.scan({ now: generationCancel.clock });
    assert.strictEqual(generationCancel.calls.model, 1, '同一窗口不得重试');

    let bubbleEngine = null;
    const bubbleCancel = await createDueEngine('bubble-cancel', {
      delay: async () => {
        bubbleEngine.recordObservedActivity('bubble-cancel', {
          chatType: 'private',
          source: 'private_inbound',
          at: Date.parse('2026-07-28T09:56:00.000Z')
        });
        return false;
      }
    });
    bubbleEngine = bubbleCancel.engine;
    await bubbleCancel.engine.scan({ now: bubbleCancel.clock });
    assert.strictEqual(bubbleCancel.calls.send, 1, '气泡间有新私聊时必须取消剩余消息');

    let releaseModel;
    const modelGate = new Promise((resolve) => { releaseModel = resolve; });
    const concurrent = await createDueEngine('concurrent', {
      requestDecision: async () => {
        await modelGate;
        return { send: false, reason: 'no', messages: [] };
      }
    });
    const scanOne = concurrent.engine.scan({ now: concurrent.clock });
    const scanTwo = concurrent.engine.scan({ now: concurrent.clock });
    assert.strictEqual(scanOne, scanTwo, '并发扫描必须复用同一任务');
    releaseModel();
    await Promise.all([scanOne, scanTwo]);
    assert.strictEqual(concurrent.calls.model, 1);

    const partial = await createDueEngine('partial', {
      sendPrivateMessage: async (_userId, _message, calls) => {
        if (calls.send === 2) throw new Error('send failed');
        return { success: true };
      }
    });
    await partial.engine.scan({ now: partial.clock });
    await partial.engine.scan({ now: partial.clock });
    const partialState = partial.engine._test.getUserSnapshot('partial');
    assert.strictEqual(partial.calls.send, 2);
    assert.strictEqual(partial.calls.model, 1, '部分发送失败后同一窗口不能重试');
    assert.strictEqual(partialState.daily.batchesSent, 1, '部分成功仍只计一批');
    assert.strictEqual(partialState.inFlight, null);

    const offline = await createDueEngine('offline', { isNapCatConnected: () => false });
    await offline.engine.scan({ now: offline.clock });
    await offline.engine.scan({ now: offline.clock });
    assert.strictEqual(offline.calls.model, 0, 'NapCat 离线时不能调用模型');

    const notIdle = await createDueEngine('not-idle', {
      config: { PRIVATE_PROACTIVE_IDLE_MINUTES: 180 }
    });
    await notIdle.engine.scan({ now: notIdle.clock });
    assert.strictEqual(notIdle.calls.model, 0, '未达到全局沉默时间时不能调用模型');

    const minimumGap = await createDueEngine('minimum-gap', {
      config: { PRIVATE_PROACTIVE_MIN_GAP_MINUTES: 60 }
    });
    minimumGap.engine._test.stateStore.update((state) => {
      state.users['minimum-gap'].lastProactiveSentAt = minimumGap.clock - (30 * 60 * 1000);
      return state;
    }, { flushNow: true });
    await minimumGap.engine.scan({ now: minimumGap.clock });
    assert.strictEqual(minimumGap.calls.model, 0, '未达到主动私聊最小间隔时不能调用模型');

    const dailyLimited = await createDueEngine('daily-limited');
    dailyLimited.engine._test.stateStore.update((state) => {
      state.users['daily-limited'].daily = { day: '2026-07-28', batchesSent: 2 };
      return state;
    }, { flushNow: true });
    await dailyLimited.engine.scan({ now: dailyLimited.clock });
    assert.strictEqual(dailyLimited.calls.model, 0, '达到用户每日批次上限时不能调用模型');

    const budgetLimited = await createDueEngine('budget-limited', {
      config: { PRIVATE_PROACTIVE_GLOBAL_MODEL_DAILY_LIMIT: 0 }
    });
    await budgetLimited.engine.scan({ now: budgetLimited.clock });
    assert.strictEqual(budgetLimited.calls.model, 0, '达到主动私聊全局模型预算时不能调用模型');

    const restart = await createDueEngine('restart');
    restart.engine._test.stateStore.update((state) => {
      const user = state.users.restart;
      user.cursor.day = '2026-07-28';
      user.cursor.consumedWindowKeys = [parseWindows('09:00-10:00')[0].key];
      user.inFlight = {
        phase: 'sending',
        windowKey: user.cursor.consumedWindowKeys[0],
        startedAt: restart.clock,
        sentCount: 1
      };
      return state;
    }, { flushNow: true });
    const restarted = createPrivateProactiveEngine({
      config: { ...runtimeConfig, PRIVATE_PROACTIVE_WINDOWS: '09:00-10:00' },
      stateFile: restart.stateFile,
      now: () => restart.clock,
      buildContext: async () => ({}),
      requestDecision: async () => {
        throw new Error('restart must not regenerate');
      },
      sendPrivateMessage: async () => {
        throw new Error('restart must not resend');
      },
      recordAssistantBubble: () => {},
      isNapCatConnected: () => true
    });
    assert.strictEqual(restarted._test.getUserSnapshot('restart').inFlight, null);
    assert.strictEqual(restarted.getStatus().lastResult.status, 'interrupted');
    const restartScan = await restarted.scan({ now: restart.clock });
    assert.strictEqual(restartScan.opportunityCount, 0, '重启后已消费窗口不得继续发送');

    const nextDayMinute = getStableOpportunityMinute('user-main', '2026-07-29', windows[0], 10);
    nowValue = utcTimestamp('2026-07-29', nextDayMinute);
    await reloaded.scan({ now: nowValue });
    const nextDayState = reloaded._test.getUserSnapshot('user-main');
    assert.strictEqual(nextDayState.daily.day, '2026-07-29');
    assert.strictEqual(nextDayState.cursor.day, '2026-07-29');
    assert.strictEqual(reloaded.getStatus().budget.day, '2026-07-29');

    console.log('privateProactiveEngine.test.js passed');
  } finally {
    restoreEnv(envSnapshot);
    clearProjectCache();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})();
