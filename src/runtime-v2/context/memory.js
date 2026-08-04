'use strict';

const { MEMORY_RECALL_PROMPT_MIN_BUDGET_MS, getConfig, shouldForceMemoryContextForQuestion } = require('./config');
const { normalizeArray, normalizeObject, normalizeText } = require('./normalization');

function buildMemoryContext(...args) { return require('../../../utils/memoryContext').buildMemoryContext(...args); }
function buildMemoryContextAsync(...args) { return require('../../../utils/memoryContext').buildMemoryContextAsync(...args); }
function composePersonaMemoryState(...args) { return require('../../../utils/personaMemoryState').composePersonaMemoryState(...args); }
function renderPersonaMemoryPrompt(...args) { return require('../../../utils/personaMemoryState').renderPersonaMemoryPrompt(...args); }
function getMemosPlannerRecallRuntime() { return require('../../../utils/memosPlannerRecall'); }
function getMemoryRecallDeduperRuntime() { return require('../../../utils/memoryRecallDeduper'); }
function getOpenVikingRecallRuntime() { return require('../../../utils/openVikingMemory/recall'); }
function getOpenVikingDeduperRuntime() { return require('../../../utils/openVikingMemory/deduper'); }

function buildMemoryRecallPolicyPromptSnippet(memoryContext = {}) {
  const context = memoryContext && typeof memoryContext === 'object' ? memoryContext : {};
  const trace = context?.diagnostics?.memoryTrace && typeof context.diagnostics.memoryTrace === 'object' ? context.diagnostics.memoryTrace : {};
  const hits = Array.isArray(trace.hits) ? trace.hits : [];
  const evidenceText = [context.promptRetrievedMemoryText, context.memoryForPrompt, context.promptDailyJournalText, context.taskMemoryText, context.groupMemoryText, context.promptLongTermProfileText].map((item) => normalizeText(item)).filter(Boolean).join('\n');
  const hasEvidenceText = Boolean(evidenceText) && !/^\[?(?:RetrievedMemory|RelevantEvidence|DailyJournal)?\]?\s*(?:none|null|undefined|暂无|无|暂无与当前问题强相关的长期记忆)?\s*$/i.test(evidenceText);
  if (hits.length === 0 && Number(trace.retrieved_count || 0) <= 0 && !hasEvidenceText) return '';
  const firstHit = hits.find((item) => item && typeof item === 'object') || {};
  const sourcePlan = context?.diagnostics?.sourcePlan || context?.stats?.sourcePlan || {};
  const { getMemoryRecallPolicyResource } = require('../../../utils/memory-v3/recallPolicyResource');
  const resource = getMemoryRecallPolicyResource({ category: firstHit.category || context.category, sourcePlan });
  if (!resource || !normalizeText(resource.text)) return '';
  const lines = ['[MemoryRecallPolicy]', resource.text];
  const category = normalizeText(resource.category || firstHit.category);
  const source = normalizeText(resource.sourcePlan?.source);
  const reason = normalizeText(resource.sourcePlan?.reason);
  if (category || source || reason) lines.push(`active_plan=${[category ? `category:${category}` : '', source ? `source:${source}` : '', reason ? `reason:${reason}` : ''].filter(Boolean).join('|')}`);
  return lines.join('\n');
}

function resolveMemosRecallObject(options = {}, routeMeta = {}, promptMaterials = null) {
  const candidates = [promptMaterials?.memosRecall, options?.memosRecall, routeMeta?.memosRecall];
  return candidates.find((item) => item && typeof item === 'object' && !Array.isArray(item)) || {};
}

function resolveMemosRecallText(options = {}, routeMeta = {}, promptMaterials = null) {
  const explicitRecall = promptMaterials?.memosRecall || options?.memosRecall || null;
  if (explicitRecall && typeof explicitRecall === 'object' && !Array.isArray(explicitRecall) && explicitRecall.used === false && normalizeText(explicitRecall.rejectedReason) === 'deduped_by_local_memory') return '';
  const directText = normalizeText(promptMaterials?.memosRecallText || options?.memosRecallText || routeMeta?.memosRecallText);
  if (directText) return directText;
  try { return normalizeText(getMemosPlannerRecallRuntime().getMemosRecallPromptText(resolveMemosRecallObject(options, routeMeta, promptMaterials))); } catch (_) { return ''; }
}

function normalizeMemosRecallBlockText(value = '') { const text = normalizeText(value); return text ? (/^\[MemOSRecall\]/i.test(text) ? text : `[MemOSRecall]\n${text}`) : ''; }
function normalizeOpenVikingRecallBlockText(value = '') { const text = normalizeText(value); return text ? (/^\[OpenVikingRecall\]/i.test(text) ? text : `[OpenVikingRecall]\n${text}`) : ''; }

function dedupeMemosRecallForPrompt(memosRecall = {}, memoryContext = {}, options = {}) {
  try { return getMemoryRecallDeduperRuntime().dedupeMemosRecallAgainstMemoryContext(memosRecall, memoryContext, { maxChars: getConfig().MEMOS_RECALL_MAX_CHARS, ...normalizeObject(options, {}) }); } catch (_) {
    const recall = memosRecall && typeof memosRecall === 'object' && !Array.isArray(memosRecall) ? memosRecall : {};
    const localText = normalizeText([memoryContext?.promptRetrievedMemoryText, memoryContext?.retrievedMemoryForPrompt, memoryContext?.memoryForPrompt].filter(Boolean).join('\n'));
    const recallText = normalizeText(recall.promptText || normalizeArray(recall.items).map((item) => item?.text || item?.content || '').filter(Boolean).join('\n'));
    const canonical = (value = '') => normalizeText(value).toLowerCase().replace(/\[(?:memosrecall|retrievedmemorylite|retrievedmemory|relevantevidence|weakevidence|sessioncontinuity|taskmemory|groupmemory|stylesignals)\]/gi, ' ').replace(/^\s*\d+[.)、]\s*/gm, ' ').replace(/(?:然后|并且|而且|以及|另外|同时|先|再|会|了|的)/g, ' ').replace(/[^\u4e00-\u9fa5a-z0-9]+/g, '').trim();
    const localCanonical = canonical(localText); const recallCanonical = canonical(recallText);
    if (localCanonical && recallCanonical && (localCanonical.includes(recallCanonical) || recallCanonical.includes(localCanonical))) return { ...recall, items: [], used: false, rejectedReason: 'deduped_by_local_memory', promptText: '', diagnostics: { ...(recall.diagnostics && typeof recall.diagnostics === 'object' ? recall.diagnostics : {}), dedupe: { enabled: true, fallback: true, removed: normalizeArray(recall.items).length || 1, kept: 0 } } };
    return recall;
  }
}

function resolveOpenVikingRecallObject(options = {}, routeMeta = {}, promptMaterials = null) {
  const candidates = [promptMaterials?.openVikingRecall, promptMaterials?.openvikingRecall, options?.openVikingRecall, options?.openvikingRecall, routeMeta?.openVikingRecall];
  return candidates.find((item) => item && typeof item === 'object' && !Array.isArray(item)) || {};
}

function resolveOpenVikingRecallText(options = {}, routeMeta = {}, promptMaterials = null) {
  const directText = normalizeText(promptMaterials?.openVikingRecallText || promptMaterials?.openvikingRecallText || options?.openVikingRecallText || options?.openvikingRecallText || routeMeta?.openVikingRecallText);
  if (directText) return directText;
  try { return normalizeText(getOpenVikingRecallRuntime().getOpenVikingRecallPromptText(resolveOpenVikingRecallObject(options, routeMeta, promptMaterials))); } catch (_) { return ''; }
}

function dedupeOpenVikingRecallForPrompt(openVikingRecall = {}, memoryContext = {}, options = {}) {
  try { return getOpenVikingDeduperRuntime().dedupeOpenVikingRecallAgainstMemoryContext(openVikingRecall, memoryContext, { maxChars: getConfig().OPENVIKING_RECALL_MAX_CHARS, ...normalizeObject(options, {}) }); } catch (_) { return openVikingRecall && typeof openVikingRecall === 'object' && !Array.isArray(openVikingRecall) ? openVikingRecall : {}; }
}

function canonicalMemoryEvidenceText(value = '') { return String(value || '').toLowerCase().replace(/\[(?:retrievedmemorylite|retrievedmemory|relevantevidence|dailyjournal|journal\|[^\]]+)\]/gi, ' ').replace(/date:\s*(\d{4}-\d{2}-\d{2})/gi, '$1 ').replace(/[^\u4e00-\u9fa5a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function removeDuplicateJournalPromptText(journalText = '', retrievedText = '') { const journal = String(journalText || '').trim(); if (!journal) return ''; const retrievedCanonical = canonicalMemoryEvidenceText(retrievedText); if (!retrievedCanonical) return journal; return journal.split(/\n{2,}/).map((chunk) => chunk.trim()).filter(Boolean).filter((chunk) => { const canonical = canonicalMemoryEvidenceText(chunk); return !canonical || canonical.length < 24 || !retrievedCanonical.includes(canonical); }).join('\n\n').trim(); }

function resolveMemoryPromptBudgetMs(options = {}, question = '') {
  const currentConfig = getConfig(); const base = Math.max(0, Number(options?.latencyDecision?.memoryBudgetMs || currentConfig.MEMORY_RETRIEVAL_SOFT_BUDGET_MS || 300) || 0);
  if (!shouldForceMemoryContextForQuestion(question, options)) return base;
  return Math.max(base, MEMORY_RECALL_PROMPT_MIN_BUDGET_MS, Number(currentConfig.MEMORY_RECALL_PROMPT_SOFT_BUDGET_MS || 0) || 0, Number(currentConfig.MEMORY_RETRIEVAL_RECALL_SOFT_BUDGET_MS || 0) || 0);
}

function buildFallbackMemoryContext(userId, question = '', options = {}, routeMeta = {}) {
  if (options.memoryContext && typeof options.memoryContext === 'object') return options.memoryContext;
  if (!shouldForceMemoryContextForQuestion(question, { ...options, routeMeta })) return {};
  const forceLocalRag = getConfig().MEMORY_RECALL_FORCE_LOCAL_RAG !== false;
  try { return buildMemoryContext(userId, question || '', { routePolicyKey: options.routePolicyKey, topRouteType: options.topRouteType || routeMeta.topRouteType || '', groupId: routeMeta.groupId || routeMeta.group_id || '', sessionKey: options.sessionKey || routeMeta.sessionKey || routeMeta.session_key || '', sessionId: routeMeta.sessionId || routeMeta.session_id || '', taskType: routeMeta.taskType || routeMeta.task_type || '', agentName: options.agentName || routeMeta.agentName || routeMeta.agent_name || '', toolName: options.toolName || routeMeta.toolName || routeMeta.tool_name || '', journalToday: options.journalToday, journalNow: options.journalNow, dailyJournalTimestamp: options.dailyJournalTimestamp, dailyJournalYearMonth: options.dailyJournalYearMonth, dailyJournalMaxFourDayFiles: 1, dailyJournalMaxMonthlyFiles: 0, forceMemoryContext: true, ragEnabled: forceLocalRag ? true : false, retrievalPath: forceLocalRag ? 'fallback_forced_local_rag' : 'fallback_no_rag' }); } catch (_) { return {}; }
}

module.exports = { buildFallbackMemoryContext, buildMemoryContext, buildMemoryContextAsync, buildMemoryRecallPolicyPromptSnippet, canonicalMemoryEvidenceText, composePersonaMemoryState, dedupeMemosRecallForPrompt, dedupeOpenVikingRecallForPrompt, getMemoryRecallDeduperRuntime, getMemosPlannerRecallRuntime, getOpenVikingDeduperRuntime, getOpenVikingRecallRuntime, normalizeMemosRecallBlockText, normalizeOpenVikingRecallBlockText, removeDuplicateJournalPromptText, renderPersonaMemoryPrompt, resolveMemoryPromptBudgetMs, resolveMemosRecallObject, resolveMemosRecallText, resolveOpenVikingRecallObject, resolveOpenVikingRecallText };
