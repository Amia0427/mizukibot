'use strict';

const { getConfig } = require('./config');
const { normalizeArray, normalizeObject, normalizeText } = require('./normalization');
const {
  GROUP_DIRECT_REPLY_CHAR_LIMIT,
  GROUP_DIRECT_REPLY_TARGET_MAX_CHARS,
  GROUP_DIRECT_REPLY_TARGET_MIN_CHARS
} = require('../../../api/runtimeV2/guards/groupDirectReplyStyleGuard');

function sanitizePromptTimingMeta(meta = {}) {
  const normalized = normalizeObject(meta, {});
  const out = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (value === undefined || typeof value === 'function') continue;
    if (Array.isArray(value)) out[key] = value.map((item) => normalizeText(item)).filter(Boolean).slice(0, 12);
    else if (value && typeof value === 'object') out[key] = sanitizePromptTimingMeta(value);
    else if (typeof value === 'number') out[key] = Number.isFinite(value) ? value : 0;
    else if (typeof value === 'boolean') out[key] = value;
    else out[key] = normalizeText(value);
  }
  return out;
}

function normalizePromptTimingEntry(entry = {}, now = Date.now()) {
  const normalized = normalizeObject(entry, {});
  const name = normalizeText(normalized.name);
  if (!name) return null;
  const startedAtMs = Number.isFinite(Number(normalized.startedAtMs)) ? Number(normalized.startedAtMs) : now;
  const endedAtMs = Number.isFinite(Number(normalized.endedAtMs)) ? Number(normalized.endedAtMs) : now;
  const durationMs = Number.isFinite(Number(normalized.durationMs)) ? Math.max(0, Number(normalized.durationMs)) : Math.max(0, endedAtMs - startedAtMs);
  return {
    name,
    category: normalizeText(normalized.category, 'prompt_assembly'),
    durationMs,
    status: normalizeText(normalized.status, normalized.ended === false ? 'running' : 'ok'),
    readOnly: normalized.readOnly !== false,
    source: normalizeText(normalized.source),
    startedAt: normalizeText(normalized.startedAt),
    endedAt: normalizeText(normalized.endedAt),
    ...(Array.isArray(normalized.includes) && normalized.includes.length > 0 ? { includes: normalized.includes.map((item) => normalizeText(item)).filter(Boolean) } : {}),
    ...(normalized.summary && typeof normalized.summary === 'object' ? { summary: sanitizePromptTimingMeta(normalized.summary) } : {}),
    ...(normalizeText(normalized.error) ? { error: normalizeText(normalized.error).slice(0, 240) } : {})
  };
}

function summarizePromptAssemblyTiming(entries = [], options = {}) {
  const now = Date.now();
  const stages = normalizeArray(entries).map((entry) => normalizePromptTimingEntry(entry, now)).filter(Boolean);
  const byName = {};
  for (const stage of stages) {
    if (!byName[stage.name]) byName[stage.name] = { count: 0, durationMs: 0, maxDurationMs: 0, status: stage.status, category: stage.category, source: stage.source };
    byName[stage.name].count += 1;
    byName[stage.name].durationMs += stage.durationMs;
    byName[stage.name].maxDurationMs = Math.max(byName[stage.name].maxDurationMs, stage.durationMs);
    if (stage.status !== 'ok') byName[stage.name].status = stage.status;
  }
  for (const item of Object.values(byName)) {
    item.durationMs = Math.max(0, Math.round(item.durationMs));
    item.maxDurationMs = Math.max(0, Math.round(item.maxDurationMs));
  }
  return {
    schemaVersion: 'prompt_assembly_stage_timing_v1', readOnly: true,
    totalDurationMs: Math.max(0, Number(options.totalDurationMs || 0) || 0),
    promptCollectMs: Math.max(0, Number(options.promptCollectMs || 0) || 0),
    promptRenderMs: Math.max(0, Number(options.promptRenderMs || 0) || 0),
    stages, byName,
    hotspots: stages.slice().sort((a, b) => b.durationMs - a.durationMs).slice(0, 8).map((item) => ({ name: item.name, durationMs: item.durationMs, category: item.category, source: item.source, status: item.status }))
  };
}

function createPromptAssemblyTimingCollector(existing = null) {
  if (existing && existing.__promptAssemblyTimingCollector === true) return existing;
  const entries = Array.isArray(existing?.entries) ? existing.entries : [];
  const start = (name = '', meta = {}) => {
    const startedAtMs = Date.now();
    const entry = { name: normalizeText(name, 'unknown'), ...sanitizePromptTimingMeta(meta), startedAtMs, startedAt: new Date(startedAtMs).toISOString(), durationMs: 0, status: 'running', ended: false, readOnly: meta?.readOnly !== false };
    entries.push(entry);
    return { entry, end(extra = {}) {
      if (entry.ended === true) return entry;
      const endedAtMs = Date.now();
      const cleanExtra = sanitizePromptTimingMeta(extra);
      Object.assign(entry, cleanExtra);
      entry.endedAtMs = endedAtMs;
      entry.endedAt = new Date(endedAtMs).toISOString();
      entry.durationMs = Math.max(0, endedAtMs - startedAtMs);
      entry.status = normalizeText(cleanExtra.status, entry.status === 'running' ? 'ok' : entry.status);
      entry.ended = true;
      return entry;
    } };
  };
  return {
    __promptAssemblyTimingCollector: true, entries, start,
    record(name = '', meta = {}) { const timer = start(name, meta); const entry = timer.end({ status: normalizeText(meta.status, 'ok') }); if (Number.isFinite(Number(meta.durationMs))) entry.durationMs = Math.max(0, Number(meta.durationMs)); return entry; },
    has(name = '') { const target = normalizeText(name); return Boolean(target && entries.some((entry) => normalizeText(entry.name) === target)); },
    find(name = '') { const target = normalizeText(name); return entries.find((entry) => normalizeText(entry.name) === target) || null; },
    measureSync(name = '', fn, meta = {}) { const timer = start(name, meta); try { const value = typeof fn === 'function' ? fn() : fn; timer.end({ status: 'ok' }); return value; } catch (error) { timer.end({ status: 'error', error: error?.message || String(error || '') }); throw error; } },
    async measureAsync(name = '', fn, meta = {}) { const timer = start(name, meta); try { const value = await (typeof fn === 'function' ? fn() : fn); timer.end({ status: 'ok' }); return value; } catch (error) { timer.end({ status: 'error', error: error?.message || String(error || '') }); throw error; } },
    snapshot(options = {}) { return summarizePromptAssemblyTiming(entries, options); }
  };
}

function recordMemoryContextTimingDetails(timing, memoryContext = {}) {
  if (!timing || typeof timing.record !== 'function') return;
  const context = normalizeObject(memoryContext, {});
  const dailyBundle = normalizeObject(context.dailyJournalBundle, {});
  const dailySource = normalizeText(dailyBundle.source, 'daily_journal_files');
  if (!timing.has('daily_journal')) timing.record('daily_journal', { category: 'memory_context', source: 'utils/dailyJournal.getDailyJournalRetrievalBundle', status: 'observed', readOnly: true, summary: { source: dailySource, items: normalizeArray(dailyBundle.items).length, promptChars: normalizeText(context.promptDailyJournalText || context.dailyJournalText).length } });
  const dailyStage = timing.find('daily_journal');
  const stableProfileSource = normalizeText(context.stableProfile?.source || context.stableProfileSource);
  const usedProfileJournalDb = dailySource === 'profile_journal_db' || stableProfileSource === 'profile_journal_db';
  if (!timing.has('profile_journal_db')) timing.record('profile_journal_db', { category: 'memory_context', source: 'utils/profileJournalDb', status: usedProfileJournalDb ? 'observed' : 'not_used', durationMs: usedProfileJournalDb && Number.isFinite(Number(dailyStage?.durationMs)) ? Number(dailyStage.durationMs) : 0, readOnly: true, summary: { dailyJournalSource: dailySource, stableProfileSource, promptDailyJournalChars: normalizeText(context.promptDailyJournalText || context.dailyJournalText).length, promptProfileChars: normalizeText(context.promptLongTermProfileText || context.longTermProfileText || context.profileText).length } });
}

function getRouteMetaGroupId(routeMeta = {}) { const normalizedRouteMeta = routeMeta && typeof routeMeta === 'object' ? routeMeta : {}; return String(normalizedRouteMeta.groupId || normalizedRouteMeta.group_id || '').trim(); }

function isGroupDirectChatRoute(options = {}) { const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {}; const topRouteType = String(options?.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase(); return topRouteType === 'direct_chat' && Boolean(getRouteMetaGroupId(routeMeta)); }

function buildGroupDirectChatStyleGuardPrompt() {
  return ['[GroupDirectChatStyleGuard]', '当前是QQ群里的直接问答，不是一对一长教程。', `最终回复默认1到3句，目标${GROUP_DIRECT_REPLY_TARGET_MIN_CHARS}到${GROUP_DIRECT_REPLY_TARGET_MAX_CHARS}个中文字，硬上限${GROUP_DIRECT_REPLY_CHAR_LIMIT}字。`, '先像群友顺手接话，再只给最关键的一两个点；不要标题、编号、分点、教程提纲、总结段。', '遇到“如何学习/怎么入门/推荐路线”这类问题，只给最短起步路径，不展开完整课程。'].join('\n');
}

module.exports = { buildGroupDirectChatStyleGuardPrompt, createPromptAssemblyTimingCollector, getRouteMetaGroupId, isGroupDirectChatRoute, normalizePromptTimingEntry, recordMemoryContextTimingDetails, sanitizePromptTimingMeta, summarizePromptAssemblyTiming };
