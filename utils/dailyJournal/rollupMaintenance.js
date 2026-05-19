function createDailyJournalRollupMaintenance(deps = {}) {
  const {
    atomicWriteText,
    buildFourDayRollupPlans,
    buildMonthlyRollupPlans,
    buildUserSnapshot,
    config,
    extractMessageContent,
    getFourDayRollupFilePath,
    getMemoryApiKey,
    getMemoryChatCompletionsUrl,
    getMemoryModelName,
    getMonthlyRollupFilePath,
    getSummaryFilePath,
    getYearMonthFromDay,
    listFourDayRollups,
    listUserSummaryDays,
    postWithRetry,
    safeReadText,
    shiftDate,
    strictClampText,
    syncEpisodeMemory,
    updateJournalIndex,
    updateRollupIndex
  } = deps;

  async function summarizeDerivedRollup(userId, payload = {}, options = {}) {
    const uid = String(userId || '').trim();
    const kind = String(payload.kind || '').trim();
    const sourceText = String(payload.sourceText || '').trim();
    const maxChars = Math.max(40, Number(payload.maxChars) || 40);
    if (!uid || !kind || !sourceText) return '';

    const customSummarizer = kind === 'monthly_rollup'
      ? options.monthlySummarizer
      : options.fourDaySummarizer;
    if (typeof customSummarizer === 'function') {
      return strictClampText(await customSummarizer(payload), maxChars);
    }

    const prompt = kind === 'monthly_rollup'
      ? [
        'You compress seven higher-level 4-day memory rollups into one monthly memory note.',
        'Keep only durable priorities, recurring themes, important progress, blockers, emotional patterns, and commitments worth recalling later.',
        'Drop filler and repetition.',
        'Return plain text only.',
        `Keep the output within ${maxChars} characters.`
      ].join('\n')
      : [
        'You compress four daily summaries into one durable higher-level memory note.',
        'Keep only durable preferences, decisions, progress, blockers, emotional shifts, and follow-up topics worth carrying forward.',
        'Drop filler and repetition.',
        'Return plain text only.',
        `Keep the output within ${maxChars} characters.`
      ].join('\n');

    const resp = await postWithRetry(
      getMemoryChatCompletionsUrl(),
      {
        model: getMemoryModelName(),
        temperature: 0.2,
        top_p: 0.9,
        messages: [
          { role: 'system', content: prompt },
          {
            role: 'system',
            content: `User snapshot:\n${buildUserSnapshot(uid)}`
          },
          {
            role: 'user',
            content: sourceText
          }
        ],
        max_tokens: Math.max(120, Math.min(800, maxChars * 2)),
        stream: false
      },
      Math.max(0, Number(config.AI_RETRIES) || 0),
      getMemoryApiKey()
    );

    const msg = extractMessageContent(resp);
    return strictClampText(String(msg?.content || msg?.text || '').trim(), maxChars);
  }

  async function maintainDailyJournalRollups(userId, options = {}) {
    const uid = String(userId || '').trim();
    if (!uid || !config.DAILY_JOURNAL_ENABLED) {
      return {
        userId: uid,
        fourDayCreated: 0,
        monthlyCreated: 0
      };
    }

    let fourDayCreated = 0;
    let monthlyCreated = 0;

    if (config.DAILY_JOURNAL_4DAY_ENABLED) {
      const fourDayPlans = buildFourDayRollupPlans(listUserSummaryDays(uid));
      for (const plan of fourDayPlans) {
        const filePath = getFourDayRollupFilePath(uid, plan.startDay, plan.endDay);
        if (deps.fs.existsSync(filePath)) continue;

        const sourceItems = plan.days
          .map((day) => ({ day, text: safeReadText(getSummaryFilePath(uid, day), '').trim() }))
          .filter((item) => item.text);
        if (sourceItems.length !== 4) continue;

        const sourceText = sourceItems
          .map((item) => `[${item.day}]\n${item.text}`)
          .join('\n\n');
        const summary = await summarizeDerivedRollup(uid, {
          kind: 'four_day_rollup',
          startDay: plan.startDay,
          endDay: plan.endDay,
          days: plan.days,
          sourceItems,
          sourceText,
          maxChars: config.DAILY_JOURNAL_4DAY_MAX_CHARS
        }, options);
        if (!summary) continue;

        atomicWriteText(filePath, `${summary}\n`);
        updateJournalIndex(uid, (index) => ({
          ...index,
          fourDayRollups: [
            ...index.fourDayRollups.filter((item) => !(item.startDay === plan.startDay && item.endDay === plan.endDay)),
            {
              startDay: plan.startDay,
              endDay: plan.endDay,
              yearMonth: getYearMonthFromDay(plan.endDay),
              filePath
            }
          ]
        }));
        updateRollupIndex(uid, (index) => ({
          ...index,
          fourDay: [
            ...(index.fourDay || []).filter((item) => !(item.startDay === plan.startDay && item.endDay === plan.endDay)),
            {
              startDay: plan.startDay,
              endDay: plan.endDay,
              yearMonth: getYearMonthFromDay(plan.endDay),
              sessionKeys: plan.days.flatMap((day) => (
                Array.isArray(index.daily?.[day]?.sessionKeys) ? index.daily[day].sessionKeys : []
              )).filter(Boolean),
              topics: plan.days.flatMap((day) => (
                Array.isArray(index.daily?.[day]?.topics) ? index.daily[day].topics : []
              )).filter(Boolean)
            }
          ]
        }));
        await syncEpisodeMemory(uid, summary, {
          source: 'daily_journal_rollup',
          rollupLevel: '4day',
          episodeDay: plan.endDay,
          startDay: plan.startDay,
          endDay: plan.endDay,
          yearMonth: getYearMonthFromDay(plan.endDay),
          sourceFile: filePath,
          textKind: 'journal_4day_rollup',
          maxChars: config.DAILY_JOURNAL_4DAY_MAX_CHARS,
          conflictKeys: plan.days.map((day) => `journal|${uid}|daily|${day}`),
          coveredByRollups: ['4day']
        });
        fourDayCreated += 1;
      }
    }

    if (config.DAILY_JOURNAL_MONTHLY_ENABLED) {
      const monthlyPlans = buildMonthlyRollupPlans(listFourDayRollups(uid));
      for (const plan of monthlyPlans) {
        if (!plan.yearMonth) continue;
        const filePath = getMonthlyRollupFilePath(uid, plan.yearMonth, plan.part);
        if (deps.fs.existsSync(filePath)) continue;

        const sourceText = plan.items
          .map((item) => `[${item.startDay}..${item.endDay}]\n${item.text}`)
          .join('\n\n');
        const summary = await summarizeDerivedRollup(uid, {
          kind: 'monthly_rollup',
          yearMonth: plan.yearMonth,
          part: plan.part,
          startDay: plan.startDay,
          endDay: plan.endDay,
          items: plan.items,
          sourceText,
          maxChars: config.DAILY_JOURNAL_MONTHLY_MAX_CHARS
        }, options);
        if (!summary) continue;

        atomicWriteText(filePath, `${summary}\n`);
        updateJournalIndex(uid, (index) => ({
          ...index,
          monthlyRollups: [
            ...index.monthlyRollups.filter((item) => !(item.yearMonth === plan.yearMonth && Number(item.part || 0) === Number(plan.part || 0))),
            {
              yearMonth: plan.yearMonth,
              part: plan.part,
              filePath
            }
          ]
        }));
        updateRollupIndex(uid, (index) => ({
          ...index,
          monthly: [
            ...(index.monthly || []).filter((item) => !(item.yearMonth === plan.yearMonth && Number(item.part || 0) === Number(plan.part || 0))),
            {
              yearMonth: plan.yearMonth,
              part: plan.part,
              startDay: plan.startDay,
              endDay: plan.endDay,
              sessionKeys: plan.items.flatMap((item) => {
                const matched = (index.fourDay || []).find((row) => row.startDay === item.startDay && row.endDay === item.endDay);
                return Array.isArray(matched?.sessionKeys) ? matched.sessionKeys : [];
              }).filter(Boolean),
              topics: plan.items.flatMap((item) => {
                const matched = (index.fourDay || []).find((row) => row.startDay === item.startDay && row.endDay === item.endDay);
                return Array.isArray(matched?.topics) ? matched.topics : [];
              }).filter(Boolean)
            }
          ]
        }));
        await syncEpisodeMemory(uid, summary, {
          source: 'daily_journal_rollup',
          rollupLevel: 'monthly',
          episodeDay: plan.endDay,
          startDay: plan.startDay,
          endDay: plan.endDay,
          yearMonth: plan.yearMonth,
          part: plan.part,
          sourceFile: filePath,
          textKind: 'journal_monthly_rollup',
          maxChars: config.DAILY_JOURNAL_MONTHLY_MAX_CHARS,
          conflictKeys: plan.items.flatMap((item) => {
            const keys = [`journal|${uid}|4day|${item.endDay}||${item.startDay}|${item.endDay}`];
            const range = [];
            let current = String(item.startDay || '').trim();
            while (current && current <= item.endDay) {
              range.push(`journal|${uid}|daily|${current}`);
              if (current === item.endDay) break;
              current = shiftDate(current, 1);
            }
            return keys.concat(range);
          }),
          coveredByRollups: ['monthly']
        });
        monthlyCreated += 1;
      }
    }

    return {
      userId: uid,
      fourDayCreated,
      monthlyCreated
    };
  }

  return {
    maintainDailyJournalRollups,
    summarizeDerivedRollup
  };
}

module.exports = {
  createDailyJournalRollupMaintenance
};
