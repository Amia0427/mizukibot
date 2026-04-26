const fs = require('fs');
const path = require('path');
const config = require('../config');
const {
  getUserProfile,
  getUserSummary,
  getUserImpression,
  getUserMemories,
  memories
} = require('./memory');
const {
  retrieveRelevantMemories,
  retrieveUnifiedMemories,
  rememberExplicitMemory,
  getMemoryItems,
  getMemoryItemsByFilter,
  touchAccessStats
} = require('./vectorMemory');
const { retrieveRelevantTaskMemories } = require('./taskMemory');
const { retrieveRelevantGroupMemoriesSync } = require('./groupMemory');
const {
  getAccessibleGroupIdsForUser,
  getMemoryScopeForUser
} = require('./memoryScopeIndex');
const {
  getDailyJournalStats,
  listFourDayRollups,
  listMonthlyRollups,
  getDailyJournalRetrievalBundle,
  listUserJournalDays,
  parseJournalEntries
} = require('./dailyJournal');
const { loadBridgeStore } = require('./shortTermBridgeMemory');
const {
  buildStructuredSummaryText,
  normalizeShortTermState,
  resolveShortTermSessionKey
} = require('./shortTermMemory');
const {
  RECALL_FACETS,
  classifyRecallFacet,
  getFacetPerSourceLimit,
  getFacetSourceWeights,
  shouldBiasToContinuity
} = require('./recallHeuristics');
const { queryMemory } = require('./memory-v3');
const {
  schedulePreload,
  searchMemoryCliFast,
  openMemoryCliFast
} = require('./memory-v3/cliSearchRuntime');
const {
  queryLocalKnowledge,
  readNotebookDoc
} = require('./localKnowledge');
const {
  loadSessionProjection,
  loadProfileProjection,
  loadMemoryNodes,
  loadEpisodeProjection
} = require('./memory-v3/storage');

const VALID_SEARCH_SOURCES = new Set(['all', 'profile', 'personal', 'task', 'group', 'journal', 'recent', 'style', 'jargon', 'notebook']);
const VALID_OPEN_SOURCES = new Set(['profile', 'personal', 'task', 'group', 'journal', 'recent', 'style', 'jargon', 'notebook']);
const SOURCE_PRIORITY = {
  recent: 0,
  personal: 1,
  task: 2,
  group: 3,
  style: 4,
  jargon: 5,
  profile: 6,
  journal: 7
};
const QUERY_FACETS = new Set(RECALL_FACETS);
const JOURNAL_RAW_FALLBACK_DAYS = 10;
const JOURNAL_RAW_FALLBACK_MAX_CANDIDATES = 8;
const JOURNAL_RAW_FALLBACK_WINDOW_RADIUS = 2;
const JOURNAL_BUNDLE_WEAK_SCORE = 0.48;

schedulePreload();

function sanitizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sanitizePreviewText(value, limit = 180) {
  const text = sanitizeText(value);
  if (!text) return '';
  const maxChars = Math.max(24, Number(limit) || 180);
  return text.length > maxChars ? `${text.slice(0, maxChars - 3).trim()}...` : text;
}

function hasForbiddenShellSyntax(text = '') {
  return /[|;&><`]/.test(String(text || '')) || /\.\.\//.test(String(text || ''));
}

function stripCodeFences(text = '') {
  return String(text || '')
    .replace(/^```[a-zA-Z0-9_-]*\s*/u, '')
    .replace(/\s*```$/u, '')
    .trim();
}

function normalizeQuotes(text = '') {
  return String(text || '')
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, '\'')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/\u3000/g, ' ');
}

function safeJsonParse(text = '') {
  try {
    return JSON.parse(String(text || ''));
  } catch (_) {
    return null;
  }
}

function tokenizeArgs(text = '') {
  const input = String(text || '').trim();
  const tokens = [];
  let current = '';
  let quote = '';

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = '';
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (quote) throw new Error('Unexpected token: unterminated quote');
  if (current) tokens.push(current);
  return tokens;
}

function buildQuotedCommandValue(value = '') {
  return `"${String(value || '').replace(/"/g, '\\"')}"`;
}

function normalizeCommandSpacing(text = '') {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function coerceSearchSource(value, fallback = 'all') {
  const source = sanitizeText(value).toLowerCase();
  return VALID_SEARCH_SOURCES.has(source) ? source : fallback;
}

function parseSearchArgs(tokens = [], raw = '') {
  let query = '';
  let source = 'all';
  let limit = Math.max(1, Math.min(20, Number(config.MEMORY_CLI_MAX_RESULTS || 8) || 8));

  for (let i = 0; i < tokens.length; i += 1) {
    const token = String(tokens[i] || '').trim();
    if (!token) continue;

    if (token === '--query') {
      query = sanitizeText(tokens[i + 1] || '');
      i += 1;
      continue;
    }
    if (token.startsWith('--query=')) {
      query = sanitizeText(token.slice('--query='.length));
      continue;
    }
    if (token.startsWith('query=')) {
      query = sanitizeText(token.slice('query='.length));
      continue;
    }

    if (token === '--source') {
      source = coerceSearchSource(tokens[i + 1] || 'all');
      i += 1;
      continue;
    }
    if (token.startsWith('--source=')) {
      source = coerceSearchSource(token.slice('--source='.length));
      continue;
    }
    if (token.startsWith('source=')) {
      source = coerceSearchSource(token.slice('source='.length));
      continue;
    }

    if (token === '--limit') {
      limit = Math.max(1, Math.min(20, Number(tokens[i + 1] || limit) || limit));
      i += 1;
      continue;
    }
    if (token.startsWith('--limit=')) {
      limit = Math.max(1, Math.min(20, Number(token.slice('--limit='.length)) || limit));
      continue;
    }
    if (token.startsWith('limit=')) {
      limit = Math.max(1, Math.min(20, Number(token.slice('limit='.length)) || limit));
      continue;
    }

    throw new Error(`Unexpected token: ${token}`);
  }

  if (!query) throw new Error(`Unexpected token: missing query in ${raw}`);
  return {
    commandName: 'search',
    query,
    source,
    limit,
    raw
  };
}

function parseOpenArgs(tokens = [], raw = '') {
  let ref = '';
  let source = '';
  let id = '';

  for (let i = 0; i < tokens.length; i += 1) {
    const token = String(tokens[i] || '').trim();
    if (!token) continue;

    if (token === '--ref') {
      ref = sanitizeText(tokens[i + 1] || '');
      i += 1;
      continue;
    }
    if (token.startsWith('--ref=')) {
      ref = sanitizeText(token.slice('--ref='.length));
      continue;
    }
    if (token.startsWith('ref=')) {
      ref = sanitizeText(token.slice('ref='.length));
      continue;
    }

    if (token === '--source') {
      source = sanitizeText(tokens[i + 1] || '').toLowerCase();
      i += 1;
      continue;
    }
    if (token.startsWith('--source=')) {
      source = sanitizeText(token.slice('--source='.length)).toLowerCase();
      continue;
    }
    if (token.startsWith('source=')) {
      source = sanitizeText(token.slice('source='.length)).toLowerCase();
      continue;
    }

    if (token === '--id') {
      id = sanitizeText(tokens[i + 1] || '');
      i += 1;
      continue;
    }
    if (token.startsWith('--id=')) {
      id = sanitizeText(token.slice('--id='.length));
      continue;
    }
    if (token.startsWith('id=')) {
      id = sanitizeText(token.slice('id='.length));
      continue;
    }

    throw new Error(`Unexpected token: ${token}`);
  }

  if (!ref && !source) throw new Error(`Unexpected token: missing open target in ${raw}`);
  if (source && !VALID_OPEN_SOURCES.has(source)) {
    throw new Error(`Unsupported memory_cli source: ${source}`);
  }
  if (source && source !== 'profile' && !id && !ref) {
    throw new Error(`Unexpected token: missing open id in ${raw}`);
  }

  return {
    commandName: 'open',
    ref,
    source,
    id,
    raw
  };
}

function parseRememberArgs(tokens = [], raw = '') {
  let text = '';
  let scope = 'personal';

  for (let i = 0; i < tokens.length; i += 1) {
    const token = String(tokens[i] || '').trim();
    if (!token) continue;

    if (token === '--text') {
      text = sanitizeText(tokens[i + 1] || '');
      i += 1;
      continue;
    }
    if (token.startsWith('--text=')) {
      text = sanitizeText(token.slice('--text='.length));
      continue;
    }

    if (token === '--scope') {
      scope = sanitizeText(tokens[i + 1] || 'personal').toLowerCase();
      i += 1;
      continue;
    }
    if (token.startsWith('--scope=')) {
      scope = sanitizeText(token.slice('--scope='.length)).toLowerCase();
      continue;
    }

    throw new Error(`Unexpected token: ${token}`);
  }

  if (!text) throw new Error(`Unexpected token: missing remember text in ${raw}`);
  if (scope !== 'personal' && scope !== 'group') throw new Error(`Unsupported remember scope: ${scope}`);
  return {
    commandName: 'remember',
    text,
    scope,
    raw
  };
}

function parseReviewArgs(tokens = [], raw = '') {
  let status = 'candidate';
  let limit = 20;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = String(tokens[i] || '').trim();
    if (!token) continue;

    if (token === '--status') {
      status = sanitizeText(tokens[i + 1] || 'candidate').toLowerCase();
      i += 1;
      continue;
    }
    if (token.startsWith('--status=')) {
      status = sanitizeText(token.slice('--status='.length)).toLowerCase();
      continue;
    }

    if (token === '--limit') {
      limit = Math.max(1, Math.min(100, Number(tokens[i + 1] || limit) || limit));
      i += 1;
      continue;
    }
    if (token.startsWith('--limit=')) {
      limit = Math.max(1, Math.min(100, Number(token.slice('--limit='.length)) || limit));
      continue;
    }

    throw new Error(`Unexpected token: ${token}`);
  }

  if (status !== 'candidate' && status !== 'active') {
    throw new Error(`Unsupported review status: ${status}`);
  }

  return {
    commandName: 'review',
    status,
    limit,
    raw
  };
}

function parseMemoryCliCommand(commandText = '') {
  const raw = sanitizeText(commandText);
  if (!raw) throw new Error('memory_cli command must start with "mem"');
  if (hasForbiddenShellSyntax(raw)) throw new Error('memory_cli command contains forbidden shell syntax');
  if (!raw.startsWith('mem ')) throw new Error('memory_cli command must start with "mem"');

  const tokens = tokenizeArgs(raw);
  if (tokens.length < 2) throw new Error('Unsupported memory_cli subcommand');
  const subcommand = String(tokens[1] || '').trim().toLowerCase();
  const args = tokens.slice(2);

  if (subcommand === 'search') return parseSearchArgs(args, raw);
  if (subcommand === 'open') return parseOpenArgs(args, raw);
  if (subcommand === 'remember') return parseRememberArgs(args, raw);
  if (subcommand === 'review') return parseReviewArgs(args, raw);
  if (subcommand === 'ls' || subcommand === 'stats') {
    return { commandName: subcommand, raw };
  }
  throw new Error('Unsupported memory_cli subcommand');
}

function tryRepairJsonWrapper(text = '', repairStrategy = []) {
  const parsedJson = text.startsWith('{') ? safeJsonParse(text) : null;
  if (parsedJson && typeof parsedJson.command === 'string' && Object.keys(parsedJson).length === 1) {
    repairStrategy.push('json_command_unwrap');
    return sanitizeText(parsedJson.command);
  }
  return text;
}

function tryRepairPrefix(text = '', repairStrategy = []) {
  let normalized = text;
  if (/^memsearch\b/i.test(normalized) || /^mem-search\b/i.test(normalized)) {
    normalized = normalized.replace(/^mem(?:search|-search)\b/i, 'mem search');
    repairStrategy.push('split_mem_search');
  }
  if (/^memopen\b/i.test(normalized) || /^mem-open\b/i.test(normalized)) {
    normalized = normalized.replace(/^mem(?:open|-open)\b/i, 'mem open');
    repairStrategy.push('split_mem_open');
  }
  if (!/^mem\s+/i.test(normalized)) {
    if (/^search\b/i.test(normalized)) {
      normalized = normalized.replace(/^search\b/i, 'mem search');
      repairStrategy.push('prefix_mem_search');
    } else if (/^open\b/i.test(normalized)) {
      normalized = normalized.replace(/^open\b/i, 'mem open');
      repairStrategy.push('prefix_mem_open');
    } else if (/^remember\b/i.test(normalized)) {
      normalized = normalized.replace(/^remember\b/i, 'mem remember');
      repairStrategy.push('prefix_mem_remember');
    } else if (/^review\b/i.test(normalized)) {
      normalized = normalized.replace(/^review\b/i, 'mem review');
      repairStrategy.push('prefix_mem_review');
    } else if (/^ls\b/i.test(normalized)) {
      normalized = normalized.replace(/^ls\b/i, 'mem ls');
      repairStrategy.push('prefix_mem_ls');
    } else if (/^stats\b/i.test(normalized)) {
      normalized = normalized.replace(/^stats\b/i, 'mem stats');
      repairStrategy.push('prefix_mem_stats');
    }
  }
  return normalized;
}

function tryRepairAssignedFlags(text = '', repairStrategy = []) {
  let normalized = text;
  normalized = normalized.replace(/\bquery=/gi, '--query=');
  normalized = normalized.replace(/\bsource=/gi, '--source=');
  normalized = normalized.replace(/\bid=/gi, '--id=');
  normalized = normalized.replace(/\bref=/gi, '--ref=');
  if (normalized !== text) {
    repairStrategy.push('assignment_flags');
  }
  return normalized;
}

function tryRepairImplicitSearch(text = '', repairStrategy = []) {
  let normalized = text;
  if (/^mem search\s+--query=/i.test(normalized)) return normalized;

  const quoted = normalized.match(/^mem search\s+"([\s\S]+)"$/i);
  if (quoted) {
    repairStrategy.push('quoted_search_query');
    return `mem search --query ${buildQuotedCommandValue(quoted[1])}`;
  }

  const restMatch = normalized.match(/^mem search\s+(.+)$/i);
  if (!restMatch) return normalized;
  const rest = String(restMatch[1] || '').trim();
  if (!rest || rest.startsWith('--')) return normalized;
  if (/\s--(?:source|limit)\b/i.test(rest)) return normalized;
  repairStrategy.push('implicit_search_query');
  return `mem search --query ${buildQuotedCommandValue(rest)}`;
}

function tryRepairImplicitOpen(text = '', repairStrategy = []) {
  const match = text.match(/^mem open\s+(mc_ref:[^\s]+)$/i);
  if (!match) return text;
  repairStrategy.push('implicit_open_ref');
  return `mem open --ref ${buildQuotedCommandValue(match[1])}`;
}

function prepareMemoryCliCommand(commandText = '') {
  const rawCommandText = sanitizeText(commandText);
  const repairStrategy = [];
  let normalized = normalizeCommandSpacing(normalizeQuotes(stripCodeFences(rawCommandText)));

  if (!normalized) {
    return {
      ok: false,
      rawCommandText,
      normalizedCommandText: '',
      preparedCommand: '',
      repairApplied: false,
      repairStrategy,
      invalidReason: 'memory_cli command must start with "mem"'
    };
  }

  if (hasForbiddenShellSyntax(normalized)) {
    return {
      ok: false,
      rawCommandText,
      normalizedCommandText: normalized,
      preparedCommand: '',
      repairApplied: false,
      repairStrategy,
      invalidReason: 'memory_cli command contains forbidden shell syntax'
    };
  }

  normalized = tryRepairJsonWrapper(normalized, repairStrategy);
  normalized = tryRepairPrefix(normalized, repairStrategy);
  normalized = tryRepairAssignedFlags(normalized, repairStrategy);
  normalized = tryRepairImplicitSearch(normalized, repairStrategy);
  normalized = tryRepairImplicitOpen(normalized, repairStrategy);
  normalized = normalizeCommandSpacing(normalized);

  try {
    const parsed = parseMemoryCliCommand(normalized);
    return {
      ok: true,
      parsed,
      rawCommandText,
      normalizedCommandText: normalized,
      preparedCommand: normalized,
      repairApplied: repairStrategy.length > 0,
      repairStrategy,
      invalidReason: ''
    };
  } catch (error) {
    return {
      ok: false,
      rawCommandText,
      normalizedCommandText: normalized,
      preparedCommand: '',
      repairApplied: repairStrategy.length > 0,
      repairStrategy,
      invalidReason: String(error.message || 'invalid_command')
    };
  }
}

function getProfileResult(userId) {
  return {
    profile: getUserProfile(userId) || {},
    summary: getUserSummary(userId) || '',
    impression: getUserImpression(userId) || '',
    facts: Array.isArray(memories[userId]?.facts) ? memories[userId].facts : []
  };
}

function getJournalSummaryFiles(userId) {
  const dir = path.join(config.DAILY_JOURNAL_DIR, String(userId || '').trim());
  if (!fs.existsSync(dir)) return [];

  const summaries = fs.readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.summary\.md$/i.test(name))
    .map((name) => {
      const filePath = path.join(dir, name);
      const text = sanitizeText(fs.readFileSync(filePath, 'utf8'));
      const stat = fs.statSync(filePath);
      return {
        id: name.slice(0, 10),
        ref: `mc_ref:journal:${name.slice(0, 10)}`,
        source: 'journal',
        type: 'daily_summary',
        title: `Daily summary ${name.slice(0, 10)}`,
        preview: sanitizePreviewText(text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
        text,
        updatedAt: Number(stat.mtimeMs || 0) || 0,
        confidence: 0.68,
        tier: 'B',
        matchMode: 'lexical',
        filePath
      };
    })
    .filter((item) => item.text);

  const fourDay = listFourDayRollups(userId).map((item) => ({
    id: `${item.startDay}__${item.endDay}`,
    ref: `mc_ref:journal:4day:${item.startDay}__${item.endDay}`,
    source: 'journal',
    type: 'four_day_rollup',
    title: `4-day rollup ${item.startDay}..${item.endDay}`,
    preview: sanitizePreviewText(item.text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
    text: String(item.text || ''),
    updatedAt: 0,
    confidence: 0.7,
    tier: 'A',
    matchMode: 'lexical',
    filePath: item.filePath
  }));

  const monthly = listMonthlyRollups(userId).map((item) => ({
    id: `${item.yearMonth}__p${String(item.part || 1).padStart(2, '0')}`,
    ref: `mc_ref:journal:monthly:${item.yearMonth}__p${String(item.part || 1).padStart(2, '0')}`,
    source: 'journal',
    type: 'monthly_rollup',
    title: `Monthly rollup ${item.yearMonth} p${String(item.part || 1).padStart(2, '0')}`,
    preview: sanitizePreviewText(item.text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
    text: String(item.text || ''),
    updatedAt: 0,
    confidence: 0.72,
    tier: 'S',
    matchMode: 'lexical',
    filePath: item.filePath
  }));

  return [...summaries, ...fourDay, ...monthly];
}

function buildJournalRawRef(day = '', windowIndex = 0) {
  return `mc_ref:journal:raw:${day}:${Math.max(0, Number(windowIndex) || 0)}`;
}

function parseJournalRawRef(ref = '') {
  const match = String(ref || '').trim().match(/^mc_ref:journal:raw:(\d{4}-\d{2}-\d{2}):(\d+)$/i);
  if (!match) return null;
  return {
    day: match[1],
    windowIndex: Math.max(0, Number(match[2]) || 0)
  };
}

function buildJournalRawWindowCandidate(day = '', entries = [], query = '', windowIndex = 0, updatedAt = 0) {
  const safeEntries = Array.isArray(entries) ? entries : [];
  const texts = safeEntries
    .map((entry) => {
      const user = sanitizeText(entry?.user || '');
      const assistant = sanitizeText(entry?.assistant || '');
      return [
        user ? `user: ${user}` : '',
        assistant ? `assistant: ${assistant}` : ''
      ].filter(Boolean).join('\n');
    })
    .filter(Boolean);
  const text = sanitizeText(texts.join('\n\n'));
  if (!text) return null;

  const preview = sanitizePreviewText(text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS);
  const hasQuery = Boolean(sanitizeText(query));
  const score = hasQuery ? scoreTextMatch(query, text) : 0;
  if (hasQuery && score <= 0) return null;

  return {
    ref: buildJournalRawRef(day, windowIndex),
    source: 'journal',
    type: 'journal_raw',
    id: `${day}:${windowIndex}`,
    logicalId: `${day}:${windowIndex}`,
    title: `Journal raw ${day} #${windowIndex + 1}`,
    preview,
    text,
    score: score + 0.16,
    updatedAt,
    confidence: 0.54,
    tier: 'C',
    matchMode: 'fallback',
    day,
    windowIndex
  };
}

function buildJournalRawFallbackCandidates(userId, query) {
  const days = listUserJournalDays(userId).slice(-JOURNAL_RAW_FALLBACK_DAYS);
  const maxCandidates = Math.max(1, JOURNAL_RAW_FALLBACK_MAX_CANDIDATES);
  const candidates = [];

  for (const day of days.slice().reverse()) {
    const filePath = path.join(config.DAILY_JOURNAL_DIR, String(userId || '').trim(), `${day}.journal.md`);
    if (!fs.existsSync(filePath)) continue;
    const rawText = String(fs.readFileSync(filePath, 'utf8') || '');
    if (!rawText.trim()) continue;

    const entries = parseJournalEntries(rawText);
    if (!entries.length) continue;

    const scored = entries
      .map((entry, index) => {
        const entryText = sanitizeText([
          sanitizeText(entry?.user || ''),
          sanitizeText(entry?.assistant || '')
        ].filter(Boolean).join('\n'));
        return {
          index,
          score: scoreTextMatch(query, entryText)
        };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, 2);

    const updatedAt = Number(fs.statSync(filePath).mtimeMs || 0) || 0;
    const seenWindows = new Set();
    for (const match of scored) {
      const start = Math.max(0, match.index - JOURNAL_RAW_FALLBACK_WINDOW_RADIUS);
      const end = Math.min(entries.length, match.index + JOURNAL_RAW_FALLBACK_WINDOW_RADIUS + 1);
      const windowEntries = entries.slice(start, end);
      const windowKey = `${start}:${end}`;
      if (seenWindows.has(windowKey)) continue;
      seenWindows.add(windowKey);
      const candidate = buildJournalRawWindowCandidate(
        day,
        windowEntries,
        query,
        start,
        updatedAt
      );
      if (candidate) candidates.push(candidate);
      if (candidates.length >= maxCandidates) return candidates;
    }
  }

  return candidates;
}

function profileArrayHits(field, values = [], score = 0.6, title = '') {
  return (Array.isArray(values) ? values : [])
    .map((value, index) => {
      const text = sanitizeText(value);
      if (!text) return null;
      return {
        ref: `mc_ref:profile:${field}:${index}`,
        source: 'profile',
        type: field,
        id: `${field}:${index}`,
        logicalId: `${field}:${index}`,
        title: title || `Profile ${field}`,
        preview: sanitizePreviewText(text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
        text,
        score,
        updatedAt: 0,
        confidence: 0.82,
        tier: 'A',
        matchMode: 'fallback'
      };
    })
    .filter(Boolean);
}

function buildProfileSearchCandidates(userId) {
  const result = getProfileResult(userId);
  const profile = result.profile || {};
  return [
    {
      ref: 'mc_ref:profile:summary',
      source: 'profile',
      type: 'summary',
      id: 'summary',
      logicalId: 'summary',
      title: 'Profile summary',
      preview: sanitizePreviewText(result.summary, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
      text: String(result.summary || ''),
      score: 0.6,
      updatedAt: 0,
      confidence: 0.9,
      tier: 'A',
      matchMode: 'lexical'
    },
    {
      ref: 'mc_ref:profile:impression',
      source: 'profile',
      type: 'impression',
      id: 'impression',
      logicalId: 'impression',
      title: 'User impression',
      preview: sanitizePreviewText(result.impression, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
      text: String(result.impression || ''),
      score: 0.64,
      updatedAt: 0,
      confidence: 0.9,
      tier: 'S',
      matchMode: 'lexical'
    },
    {
      ref: 'mc_ref:profile:facts',
      source: 'profile',
      type: 'facts',
      id: 'facts',
      logicalId: 'facts',
      title: 'Known facts',
      preview: sanitizePreviewText(getUserMemories(userId), config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
      text: String(getUserMemories(userId) || ''),
      score: 0.58,
      updatedAt: 0,
      confidence: 0.8,
      tier: 'B',
      matchMode: 'lexical'
    },
    ...profileArrayHits('identities', profile.identities, 0.66, 'Identities'),
    ...profileArrayHits('likes', profile.likes, 0.7, 'Likes'),
    ...profileArrayHits('dislikes', profile.dislikes, 0.68, 'Dislikes'),
    ...profileArrayHits('goals', profile.goals, 0.69, 'Goals'),
    ...profileArrayHits('recent_topics', profile.recent_topics, 0.62, 'Recent topics'),
    ...profileArrayHits('hobbies', profile.hobbies, 0.66, 'Hobbies')
  ].filter((item) => sanitizeText(item.text));
}

function normalizeVectorHit(hit, source) {
  if (!hit || typeof hit !== 'object') return null;
  const text = sanitizeText(hit.text || hit.content || hit.preview || hit.canonicalText || '');
  const preview = sanitizePreviewText(text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS);
  if (!text) return null;
  return {
    ref: `mc_ref:${source}:${String(hit.id || '').trim()}`,
    source,
    type: String(hit.type || 'fact').trim() || 'fact',
    id: String(hit.id || '').trim(),
    logicalId: String(hit.id || '').trim(),
    title: String(hit.type || source || 'memory').trim(),
    preview,
    text,
    score: Number(hit.score || 0) || 0,
    updatedAt: Number(hit.ts || hit.updatedAt || 0) || 0,
    confidence: Number(hit.confidence || 0) || 0,
    tier: String(hit.tier || '').trim() || 'B',
    matchMode: 'lexical',
    importance: Number(hit.importance || 0) || 0,
    groupId: String(hit.groupId || '').trim(),
    taskType: String(hit.taskType || '').trim(),
    memoryKind: sanitizeText(hit.memoryKind || hit.meta?.memoryKind).toLowerCase(),
    scopeType: sanitizeText(hit.scopeType || ''),
    jargonRole: sanitizeText(hit.jargonRole || hit.meta?.jargonRole).toLowerCase(),
    styleRole: sanitizeText(hit.styleRole || hit.meta?.styleRole).toLowerCase()
  };
}

function buildUnifiedSearchOptions(userId, query, options = {}, context = {}) {
  const source = coerceSearchSource(options.source || 'all');
  const queryFacet = QUERY_FACETS.has(options.queryFacet) ? options.queryFacet : classifyRecallFacet(query);
  const requestedLimit = Number(options.limit || config.MEMORY_CLI_MAX_RESULTS || 8);
  const continuityBias = shouldBiasToContinuity(queryFacet);
  return {
    userId,
    source,
    queryFacet,
    limit: Math.max(1, Math.min(24, continuityBias ? Math.max(requestedLimit, 10) : requestedLimit)),
    routePolicyKey: sanitizeText(context.routePolicyKey),
    topRouteType: sanitizeText(context.topRouteType),
    taskType: sanitizeText(context.taskType),
    agentName: sanitizeText(context.agentName),
    toolName: sanitizeText(context.toolName),
    sessionId: sanitizeText(context.sessionId),
    channelId: sanitizeText(context.channelId),
    groupId: sanitizeText(context.groupId),
    groupIds: getAccessibleGroupIdsForUser(userId),
    participants: Array.isArray(context.participants) ? context.participants : [],
    includeTask: source === 'all' || source === 'task',
    includeGroup: source === 'all' || source === 'group' || source === 'jargon',
    includeSignals: source === 'all' || source === 'style' || source === 'jargon',
    includeEpisodes: source === 'all' || source === 'journal'
  };
}

function normalizeUnifiedHit(hit = {}) {
  const source = sanitizeText(hit.source || classifyMemoryHitSource(hit)).toLowerCase() || 'personal';
  const normalized = normalizeVectorHit(hit, source);
  if (!normalized) return null;
  return {
    ...normalized,
    source,
    status: sanitizeText(hit.status || 'active').toLowerCase() || 'active',
    sourceKind: sanitizeText(hit.sourceKind || 'legacy').toLowerCase() || 'legacy',
    reason: sanitizeText(hit.reason || ''),
    participantsMatched: Array.isArray(hit.participantsMatched) ? hit.participantsMatched : [],
    graphBoost: Number(hit.graphBoost || 0) || 0,
    recencyScore: Number(hit.recencyScore || 0) || 0,
    finalScore: Number(hit.score || 0) || 0
  };
}

function classifyMemoryHitSource(hit = {}) {
  const memoryKind = sanitizeText(hit.memoryKind || hit.meta?.memoryKind).toLowerCase();
  if (memoryKind === 'style') return 'style';
  if (memoryKind === 'jargon') return 'jargon';
  if (memoryKind === 'episode' || String(hit.type || '').trim().toLowerCase() === 'episode' || sanitizeText(hit.sourceKind).toLowerCase() === 'journal') {
    return 'journal';
  }
  const scopeType = sanitizeText(hit.scopeType).toLowerCase();
  if (scopeType === 'task') return 'task';
  if (scopeType === 'group') return 'group';
  return 'personal';
}

function classifyQueryFacet(query = '') {
  return classifyRecallFacet(query);
  const q = sanitizeText(query).toLowerCase();
  if (!q) return 'default';
  if (/(喜欢|讨厌|偏好|爱好|喜欢什么|like|likes|prefer|preference|favorite|favourite|dislike|hobby)/i.test(q)) return 'preference';
  if (/(我是谁|身份|设定|画像|identity|who am i|profile|summary|impression)/i.test(q)) return 'identity';
  if (/(关系|相处|熟悉|friend|relationship|stage)/i.test(q)) return 'relationship';
  if (/(上次聊到哪|刚刚聊到|继续|延续|recent|last time|where did we leave off|continuity)/i.test(q)) return 'recent_continuity';
  if (/(计划|任务|todo|待办|安排|路线|roadmap|task|plan)/i.test(q)) return 'task_or_plan';
  if (/(群|group|频道|channel|大家|上下文)/i.test(q)) return 'group_context';
  if (/(回想|想起来|记得什么|anything|all memory|broad recall)/i.test(q)) return 'broad_recall';
  return 'default';
}

function getFacetSourceWeightsLegacy(facet = 'default') {
  const base = {
    recent: 1,
    profile: 1,
    personal: 1,
    task: 1,
    group: 1,
    style: 1,
    jargon: 1,
    journal: 1
  };
  switch (facet) {
    case 'preference':
      return { ...base, profile: 1.45, personal: 1.32, recent: 1.1, task: 0.82, group: 0.8, style: 0.86, jargon: 0.72, journal: 0.88 };
    case 'identity':
      return { ...base, profile: 1.5, personal: 1.18, recent: 0.96, task: 0.8, group: 0.84, style: 0.88, jargon: 0.72, journal: 0.88 };
    case 'relationship':
      return { ...base, profile: 1.38, personal: 1.2, recent: 1.08, task: 0.8, group: 0.94, style: 0.9, jargon: 0.8, journal: 0.9 };
    case 'recent_continuity':
      return { ...base, recent: 1.6, journal: 1.18, profile: 0.94, personal: 1, task: 0.9, group: 0.92, style: 0.78, jargon: 0.78 };
    case 'task_or_plan':
      return { ...base, task: 1.48, personal: 1.12, journal: 1.04, recent: 1.08, profile: 0.96, group: 0.86, style: 0.8, jargon: 0.76 };
    case 'group_context':
      return { ...base, group: 1.46, recent: 1.12, profile: 0.84, personal: 1, task: 0.9, style: 0.84, jargon: 1.32, journal: 0.94 };
    case 'broad_recall':
      return { ...base, recent: 1.2, profile: 1.22, personal: 1.12, task: 1.04, group: 0.94, style: 0.86, jargon: 0.82, journal: 0.98 };
    default:
      return base;
  }
}

function buildQueryTokens(query = '') {
  return sanitizeText(query).toLowerCase().split(/\s+/).filter(Boolean);
}

function scoreTextMatch(query = '', text = '') {
  const haystack = sanitizeText(text).toLowerCase();
  if (!haystack) return 0;
  const q = sanitizeText(query).toLowerCase();
  if (!q) return 0;
  if (haystack.includes(q)) return 1;
  const tokens = buildQueryTokens(q);
  if (!tokens.length) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) hits += 1;
  }
  return hits / tokens.length;
}

function buildRecentSessionCandidates(userId, context = {}) {
  if (!config.MEMORY_CLI_RECENT_ENABLED) return [];

  const store = loadBridgeStore();
  const sessions = store && store.sessions && typeof store.sessions === 'object' ? store.sessions : {};
  const now = Date.now();
  const ttlMs = Math.max(1, Number(config.MEMORY_CLI_RECENT_TTL_HOURS || 72)) * 60 * 60 * 1000;
  const recentSessionMax = Math.max(1, Number(config.MEMORY_CLI_RECENT_SESSION_MAX || 3));
  const currentSessionKey = sanitizeText(resolveShortTermSessionKey(userId, context.routeMeta || {}));

  return Object.entries(sessions)
    .map(([sessionKey, entry]) => {
      const scope = entry?.scope && typeof entry.scope === 'object' ? entry.scope : {};
      if (String(scope.userId || entry?.userId || '').trim() !== String(userId || '').trim()) return null;

      const updatedAt = Number(entry?.updatedAt || 0) || 0;
      if (!updatedAt || (now - updatedAt) > ttlMs) return null;

      const state = normalizeShortTermState(entry?.shortTermState || {});
      const summary = buildStructuredSummaryText(state, Math.max(96, Number(config.SHORT_TERM_MEMORY_SUMMARY_MAX_TOKENS || 320)));
      const recentMessages = Array.isArray(entry?.recentMessages) ? entry.recentMessages : [];
      const messagePreview = recentMessages
        .slice(-4)
        .map((msg) => `${String(msg.role || '').trim()}: ${sanitizePreviewText(msg.content, 90)}`)
        .filter(Boolean)
        .join(' | ');
      const preview = [
        state.carryOverUserTurn ? `carry: ${state.carryOverUserTurn}` : '',
        state.activeTopic ? `topic: ${state.activeTopic}` : '',
        summary,
        messagePreview
      ].filter(Boolean).join(' | ');

      return {
        ref: `mc_ref:recent:${sessionKey}`,
        source: 'recent',
        type: 'recent_session',
        id: sessionKey,
        logicalId: sessionKey,
        title: sessionKey === currentSessionKey ? 'Current recent session' : `Recent session ${sessionKey}`,
        preview: sanitizePreviewText(preview, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
        text: sanitizeText([
          summary,
          state.carryOverUserTurn,
          state.activeTopic,
          state.openLoops.join(' | '),
          state.assistantCommitments.join(' | '),
          state.userConstraints.join(' | '),
          state.recentToolResults.join(' | '),
          messagePreview
        ].filter(Boolean).join('\n')),
        shortTermSummary: summary,
        shortTermState: state,
        recentMessages: recentMessages.slice(-4),
        updatedAt,
        expiresAt: Number(entry?.expiresAt || 0) || 0,
        confidence: 0.86,
        tier: 'A',
        matchMode: 'lexical',
        snapshotType: String(entry?.snapshotType || 'post_reply').trim() || 'post_reply',
        scope
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.id === currentSessionKey && b.id !== currentSessionKey) return -1;
      if (b.id === currentSessionKey && a.id !== currentSessionKey) return 1;
      return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    })
    .slice(0, recentSessionMax);
}

function searchRecentCandidates(userId, query, context = {}) {
  const queryFacet = classifyRecallFacet(query);
  const continuityBias = shouldBiasToContinuity(queryFacet);
  return buildRecentSessionCandidates(userId, context)
    .map((item) => ({
      ...item,
      score: scoreTextMatch(query, item.text) + (continuityBias ? 0.62 : 0.42)
    }));
}

function searchProfileCandidates(userId, query) {
  return buildProfileSearchCandidates(userId)
    .map((item) => ({
      ...item,
      score: scoreTextMatch(query, item.text) + Number(item.score || 0)
    }));
}

function searchPersonalCandidates(userId, query, limit) {
  return retrieveRelevantMemories(userId, query, limit, {
    scopeType: 'personal',
    trackAccess: false
  })
    .filter((hit) => sanitizeText(hit.memoryKind || hit.meta?.memoryKind).toLowerCase() !== 'style')
    .map((hit) => normalizeVectorHit(hit, 'personal'))
    .filter(Boolean);
}

function searchStyleCandidates(userId, query, limit) {
  return retrieveRelevantMemories(userId, query, limit, {
    scopeType: 'personal',
    memoryKind: 'style',
    trackAccess: false,
    forceSignalRecall: true
  }).map((hit) => normalizeVectorHit(hit, 'style')).filter(Boolean);
}

function searchTaskCandidates(userId, query, limit) {
  return retrieveRelevantTaskMemories(userId, query, limit, {
    trackAccess: false
  }).map((hit) => normalizeVectorHit(hit, 'task')).filter(Boolean);
}

function searchGroupCandidates(userId, query, limit) {
  const groups = getAccessibleGroupIdsForUser(userId).slice(0, Math.max(1, Number(config.MEMORY_CLI_GROUP_MAX_GROUPS_PER_SEARCH || 6)));
  const perGroupLimit = 2;
  const results = [];
  for (const groupId of groups) {
    const hits = retrieveRelevantGroupMemoriesSync(groupId, query, Math.min(limit, perGroupLimit), {
      trackAccess: false
    })
      .filter((hit) => sanitizeText(hit.memoryKind || hit.meta?.memoryKind).toLowerCase() !== 'jargon')
      .map((hit) => normalizeVectorHit(hit, 'group'))
      .filter(Boolean);
    results.push(...hits);
  }
  return results;
}

function searchJargonCandidates(userId, query, limit) {
  const groups = getAccessibleGroupIdsForUser(userId).slice(0, Math.max(1, Number(config.MEMORY_CLI_GROUP_MAX_GROUPS_PER_SEARCH || 6)));
  const perGroupLimit = 2;
  const results = [];
  for (const groupId of groups) {
    const hits = retrieveRelevantGroupMemoriesSync(groupId, query, Math.min(limit, perGroupLimit), {
      trackAccess: false,
      memoryKind: 'jargon',
      forceSignalRecall: true
    }).map((hit) => normalizeVectorHit(hit, 'jargon')).filter(Boolean);
    results.push(...hits);
  }
  return results;
}

function searchJournalCandidates(userId, query) {
  const episodeHits = retrieveUnifiedMemories(userId, query, 12, {
    sourceFilter: 'journal',
    includePersonal: false,
    includeTask: false,
    includeGroup: false,
    includeSignals: false,
    includeEpisodes: true,
    trackAccess: false
  }).map((hit) => normalizeUnifiedHit({ ...hit, source: 'journal' })).filter(Boolean);
  if (episodeHits.length > 0) return episodeHits;

  const files = getJournalSummaryFiles(userId);
  const direct = files
    .map((item) => ({
      ...item,
      score: scoreTextMatch(query, item.text) + 0.4
    }))
    .filter((item) => item.score > 0);

  if (direct.length > 0) return direct;

  const rawFallback = buildJournalRawFallbackCandidates(userId, query);
  const fallbackBundle = getDailyJournalRetrievalBundle(userId, {
    lookbackDays: Math.max(1, Number(config.MEMORY_CLI_JOURNAL_FALLBACK_DAYS || 14))
  });
  const preview = sanitizePreviewText(fallbackBundle.text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS);
  const bundleHit = preview ? [{
    ref: 'mc_ref:journal:fallback-bundle',
    source: 'journal',
    type: 'journal_bundle',
    id: 'fallback-bundle',
    logicalId: 'fallback-bundle',
    title: 'Recent journal bundle',
    preview,
    text: String(fallbackBundle.text || ''),
    score: scoreTextMatch(query, fallbackBundle.text) + 0.28,
    updatedAt: 0,
    confidence: 0.64,
    tier: 'B',
    matchMode: 'fallback'
  }] : [];

  if (!bundleHit.length) return rawFallback;

  const bundleWeak = Number(bundleHit[0].score || 0) < JOURNAL_BUNDLE_WEAK_SCORE;
  if (!bundleWeak) return bundleHit;

  return rawFallback.concat(bundleHit);
}

function buildFallbackCandidates(userId, facet = 'default', context = {}) {
  const fallbackSource = coerceSearchSource(context.source || 'all');
  const profile = getProfileResult(userId);
  const continuityBias = shouldBiasToContinuity(facet);
  const recentCandidates = buildRecentSessionCandidates(userId, context)
    .slice(0, continuityBias ? 3 : 1);
  const allowRecent = fallbackSource === 'all' || fallbackSource === 'recent';
  const allowTask = fallbackSource === 'all' || fallbackSource === 'task';
  const allowPersonal = fallbackSource === 'all' || fallbackSource === 'personal';
  const allowProfile = fallbackSource === 'all' || fallbackSource === 'profile';
  const allowJournal = fallbackSource === 'all' || fallbackSource === 'journal';
  const fallbackTask = allowTask ? searchTaskCandidates(userId, String(context.query || ''), continuityBias ? 4 : 2)
    .slice(0, continuityBias ? 3 : 1)
    .map((item, index) => ({
      ...item,
      score: Math.max(Number(item.score || 0), continuityBias ? (0.66 - (index * 0.03)) : (0.46 - (index * 0.02))),
      matchMode: 'fallback'
    })) : [];
  const fallbackPersonal = allowPersonal ? searchPersonalCandidates(userId, String(context.query || ''), continuityBias ? 4 : 2)
    .slice(0, continuityBias ? 2 : 1)
    .map((item, index) => ({
      ...item,
      score: Math.max(Number(item.score || 0), continuityBias ? (0.56 - (index * 0.03)) : (0.43 - (index * 0.02))),
      matchMode: 'fallback'
    })) : [];
  const journalBundle = getDailyJournalRetrievalBundle(userId, {
    lookbackDays: Math.max(1, Number(config.MEMORY_CLI_JOURNAL_FALLBACK_DAYS || 14))
  });
  const list = [];

  if (continuityBias && allowRecent && recentCandidates.length) {
    for (const [index, item] of recentCandidates.entries()) {
      list.push({
        ...item,
        score: 0.76 - (index * 0.04),
        matchMode: 'fallback'
      });
    }
  }
  if (continuityBias && fallbackTask.length) {
    list.push(...fallbackTask);
  }
  if (continuityBias && allowJournal && journalBundle.text) {
    list.push({
      ref: 'mc_ref:journal:fallback-bundle',
      source: 'journal',
      type: 'journal_bundle',
      id: 'fallback-bundle',
      logicalId: 'fallback-bundle',
        title: `Journal fallback ${facet}`,
        preview: sanitizePreviewText(journalBundle.text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
        text: String(journalBundle.text || ''),
        score: 0.58,
        updatedAt: 0,
        confidence: 0.64,
        tier: 'B',
        matchMode: 'fallback'
    });
  }
  if (continuityBias && fallbackPersonal.length) {
    list.push(...fallbackPersonal);
  }

  if (allowProfile && profile.summary) {
    list.push({
      ref: 'mc_ref:profile:summary',
      source: 'profile',
      type: 'summary',
      id: 'summary',
      logicalId: 'summary',
      title: 'Profile summary',
      preview: sanitizePreviewText(profile.summary, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
      text: String(profile.summary || ''),
      score: 0.44,
      updatedAt: 0,
      confidence: 0.78,
      tier: 'A',
      matchMode: 'fallback'
    });
  }
  if (allowProfile && profile.impression) {
    list.push({
      ref: 'mc_ref:profile:impression',
      source: 'profile',
      type: 'impression',
      id: 'impression',
      logicalId: 'impression',
      title: 'User impression',
      preview: sanitizePreviewText(profile.impression, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
      text: String(profile.impression || ''),
      score: 0.46,
      updatedAt: 0,
      confidence: 0.8,
      tier: 'S',
      matchMode: 'fallback'
    });
  }
  if (!continuityBias && allowRecent && recentCandidates.length) {
    for (const [index, item] of recentCandidates.entries()) {
      list.push({
        ...item,
        score: 0.55 - (index * 0.03),
        matchMode: 'fallback'
      });
    }
  }
  if (!continuityBias && fallbackPersonal.length) {
    list.push(...fallbackPersonal);
  }
  if (!continuityBias && fallbackTask.length) {
    list.push(...fallbackTask);
  }
  if (allowJournal && journalBundle.text && !continuityBias) {
    list.push({
      ref: 'mc_ref:journal:fallback-bundle',
      source: 'journal',
      type: 'journal_bundle',
      id: 'fallback-bundle',
      logicalId: 'fallback-bundle',
      title: `Journal fallback ${facet}`,
      preview: sanitizePreviewText(journalBundle.text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
      text: String(journalBundle.text || ''),
      score: 0.41,
      updatedAt: 0,
      confidence: 0.62,
      tier: 'B',
      matchMode: 'fallback'
    });
  }

  return list;
}

function rerankCandidates(candidates = [], queryFacet = 'default') {
  const sourceWeights = getFacetSourceWeights(queryFacet);
  return (Array.isArray(candidates) ? candidates : [])
    .map((item) => {
      const updatedAt = Number(item.updatedAt || 0) || 0;
      const ageHours = updatedAt > 0 ? Math.max(0, (Date.now() - updatedAt) / (60 * 60 * 1000)) : 9999;
      const recencyBoost = updatedAt > 0 ? Math.max(0.85, 1.25 - Math.min(ageHours / 168, 0.4)) : 1;
      const confidenceBoost = 0.88 + Math.min(0.2, Math.max(0, Number(item.confidence || 0)) * 0.2);
      const tierBoost = item.tier === 'S' ? 1.14 : item.tier === 'A' ? 1.08 : item.tier === 'C' ? 0.94 : 1;
      const sourceBoost = Number(sourceWeights[item.source] || 1) || 1;
      return {
        ...item,
        finalScore: (Number(item.score || 0) || 0.01) * sourceBoost * recencyBoost * confidenceBoost * tierBoost
      };
    })
    .sort((a, b) => {
      if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
      if ((SOURCE_PRIORITY[a.source] || 99) !== (SOURCE_PRIORITY[b.source] || 99)) {
        return (SOURCE_PRIORITY[a.source] || 99) - (SOURCE_PRIORITY[b.source] || 99);
      }
      return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    });
}

function dedupeAndDiversifyCandidates(candidates = [], limit = 8) {
  const seenText = new Set();
  const perSource = new Map();
  const results = [];
  const queryFacet = arguments[2] || 'default_continuity';
  const perSourceLimit = getFacetPerSourceLimit(queryFacet);
  const continuityBias = shouldBiasToContinuity(queryFacet);
  const continuityCore = new Set(['recent', 'task', 'journal']);

  for (const item of Array.isArray(candidates) ? candidates : []) {
    const canonical = sanitizeText(item.text || item.preview || '').toLowerCase();
    if (!canonical) continue;
    if (seenText.has(canonical)) continue;
    const current = perSource.get(item.source) || 0;
    const maxPerSource = Math.max(1, Number(perSourceLimit[item.source] || 2) || 2);
    if (current >= maxPerSource) continue;
    seenText.add(canonical);
    perSource.set(item.source, current + 1);
    results.push(item);
    if (results.length >= limit) break;
  }

  if (continuityBias && results.length < limit) {
    for (const item of Array.isArray(candidates) ? candidates : []) {
      if (results.length >= limit) break;
      if (!continuityCore.has(item.source)) continue;
      if (results.find((row) => row.ref === item.ref)) continue;
      const canonical = sanitizeText(item.text || item.preview || '').toLowerCase();
      if (!canonical || seenText.has(canonical)) continue;
      seenText.add(canonical);
      results.push(item);
    }
  }

  if (continuityBias && !results.some((item) => continuityCore.has(item.source))) {
    for (const item of Array.isArray(candidates) ? candidates : []) {
      if (!continuityCore.has(item.source)) continue;
      const canonical = sanitizeText(item.text || item.preview || '').toLowerCase();
      if (!canonical || seenText.has(canonical)) continue;
      results.unshift(item);
      if (results.length > limit) results.pop();
      break;
    }
  }

  return results;
}

function buildRecallHints(results = []) {
  const maxChars = Math.max(120, Number(config.MEMORY_CLI_DIGEST_MAX_CHARS || 480));
  const hints = [];
  for (const item of Array.isArray(results) ? results : []) {
    if (hints.length >= 5) break;
    const prefix = item.source === 'recent'
      ? 'Recent continuity'
      : item.source === 'profile'
        ? 'Stable profile'
        : item.source === 'personal'
          ? 'Personal memory'
          : item.source === 'task'
            ? 'Task memory'
            : item.source === 'group'
              ? 'Group memory'
              : 'Journal memory';
    hints.push(`${prefix}: ${sanitizePreviewText(item.preview || item.text, 96)}`);
  }

  let total = 0;
  const digest = [];
  for (const hint of hints) {
    const nextTotal = total + hint.length + 1;
    if (nextTotal > maxChars) break;
    digest.push(hint);
    total = nextTotal;
  }
  return digest;
}

function trimSearchResultsForBudget(results = []) {
  const maxTotalChars = Math.max(800, Number(config.MEMORY_CLI_RESULT_TOTAL_CHARS || 2200));
  const output = [];
  let total = 0;
  let dropped = 0;

  for (const item of Array.isArray(results) ? results : []) {
    const preview = sanitizePreviewText(item.preview || item.text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS);
    const estimated = preview.length + String(item.title || '').length + 48;
    if (total + estimated > maxTotalChars) {
      dropped += 1;
      continue;
    }
    output.push({
      ref: item.ref,
      source: item.source,
      type: item.type,
      title: item.title,
      preview,
      text: preview,
      score: Number(item.finalScore || item.score || 0).toFixed(3),
      updatedAt: Number(item.updatedAt || 0) || 0,
      confidence: Number(item.confidence || 0) || 0,
      tier: String(item.tier || '').trim() || 'B',
      matchMode: String(item.matchMode || 'lexical').trim() || 'lexical',
      status: sanitizeText(item.status || '').toLowerCase() || 'active',
      sourceKind: sanitizeText(item.sourceKind || '').toLowerCase() || 'legacy',
      reason: sanitizePreviewText(item.reason || '', 120),
      id: sanitizeText(item.id || ''),
      memoryKind: sanitizeText(item.memoryKind || '').toLowerCase()
    });
    total += estimated;
  }

  return {
    results: output,
    outputChars: total,
    droppedResultCount: dropped
  };
}

function searchUnifiedMemory(query, options = {}, context = {}) {
  const userId = sanitizeText(context.userId);
  const searchOptions = buildUnifiedSearchOptions(userId, query, options, context);
  const { source, queryFacet, limit } = searchOptions;

  if (!userId) {
    return {
      results: [],
      digest: [],
      sourceCoverage: {},
      queryFacet,
      candidateCounts: {},
      fallbackUsed: false,
      outputChars: 0,
      recentUsed: false,
      droppedResultCount: 0
    };
  }

  const include = (name) => source === 'all' || source === name;
  const internalCandidateTarget = Math.max(
    limit + 4,
    Number(config.MEMORY_CLI_INTERNAL_CANDIDATES_PER_SOURCE || 12),
    shouldBiasToContinuity(queryFacet) ? 20 : 12
  );
  const unifiedHits = retrieveUnifiedMemories(userId, query, internalCandidateTarget, {
    routePolicyKey: searchOptions.routePolicyKey,
    topRouteType: searchOptions.topRouteType,
    taskType: searchOptions.taskType,
    agentName: searchOptions.agentName,
    toolName: searchOptions.toolName,
    sessionId: searchOptions.sessionId,
    channelId: searchOptions.channelId,
    participants: searchOptions.participants,
    groupId: searchOptions.groupId,
    groupIds: searchOptions.groupIds,
    includeTask: searchOptions.includeTask,
    includeGroup: searchOptions.includeGroup,
    includeSignals: searchOptions.includeSignals,
    includeEpisodes: searchOptions.includeEpisodes,
    sourceFilter: source,
    trackAccess: false
  }).map((hit) => normalizeUnifiedHit(hit)).filter(Boolean);

  const candidateBuckets = {
    recent: include('recent') ? searchRecentCandidates(userId, query, context).slice(0, shouldBiasToContinuity(queryFacet) ? 10 : 6) : [],
    profile: include('profile') ? searchProfileCandidates(userId, query).slice(0, 10) : [],
    personal: include('personal') ? unifiedHits.filter((hit) => hit.source === 'personal') : [],
    task: include('task') ? unifiedHits.filter((hit) => hit.source === 'task') : [],
    group: include('group') ? unifiedHits.filter((hit) => hit.source === 'group') : [],
    style: include('style') ? unifiedHits.filter((hit) => hit.source === 'style') : [],
    jargon: include('jargon') ? unifiedHits.filter((hit) => hit.source === 'jargon') : [],
    journal: include('journal') ? searchJournalCandidates(userId, query).slice(0, shouldBiasToContinuity(queryFacet) ? 12 : 8) : []
  };

  let ranked = rerankCandidates(Object.values(candidateBuckets).flat(), queryFacet);
  let fallbackUsed = false;
  if (
    ranked.length < Math.min(limit, shouldBiasToContinuity(queryFacet) ? 5 : 3)
    || (ranked[0] && Number(ranked[0].finalScore || 0) < (shouldBiasToContinuity(queryFacet) ? 0.62 : 0.5))
    || (shouldBiasToContinuity(queryFacet) && !ranked.some((item) => item.source === 'recent' || item.source === 'task' || item.source === 'journal'))
  ) {
    ranked = rerankCandidates(
      ranked.concat(buildFallbackCandidates(userId, queryFacet, { ...context, query, source })),
      queryFacet
    );
    fallbackUsed = true;
  }

  const selected = dedupeAndDiversifyCandidates(ranked, limit, queryFacet);
  const packed = trimSearchResultsForBudget(selected);
  const sourceCoverage = {};
  for (const item of packed.results) {
    sourceCoverage[item.source] = (sourceCoverage[item.source] || 0) + 1;
  }

  return {
    results: packed.results,
    digest: buildRecallHints(selected),
    sourceCoverage,
    queryFacet,
    candidateCounts: {
      recent: candidateBuckets.recent.length,
      profile: candidateBuckets.profile.length,
      personal: candidateBuckets.personal.length,
      task: candidateBuckets.task.length,
      group: candidateBuckets.group.length,
      style: candidateBuckets.style.length,
      jargon: candidateBuckets.jargon.length,
      journal: candidateBuckets.journal.length
    },
    fallbackUsed,
    outputChars: packed.outputChars,
    recentUsed: Boolean(sourceCoverage.recent),
    droppedResultCount: packed.droppedResultCount
  };
}

function truncateProfileForOpen(profileResult = {}) {
  const profile = profileResult.profile || {};
  const maxItems = Math.max(1, Number(config.MEMORY_CLI_PROFILE_FIELD_MAX_ITEMS || 4));
  const limitList = (values) => (Array.isArray(values) ? values : []).slice(0, maxItems).map((item) => sanitizePreviewText(item, 160)).filter(Boolean);
  return {
    profile: {
      identities: limitList(profile.identities),
      personality_traits: limitList(profile.personality_traits),
      hobbies: limitList(profile.hobbies),
      likes: limitList(profile.likes),
      dislikes: limitList(profile.dislikes),
      goals: limitList(profile.goals),
      recent_topics: limitList(profile.recent_topics),
      relation_stage: sanitizePreviewText(profile.relation_stage, 80)
    },
    summary: sanitizePreviewText(profileResult.summary, 1000),
    impression: sanitizePreviewText(profileResult.impression, 1000),
    facts: (Array.isArray(profileResult.facts) ? profileResult.facts : []).slice(0, maxItems).map((item) => sanitizePreviewText(item, 180))
  };
}

function openRecentSession(userId, sessionKey, context = {}) {
  const recent = buildRecentSessionCandidates(userId, context).find((item) => item.id === sessionKey);
  if (!recent) return null;
  return {
    source: 'recent',
    id: sessionKey,
    data: {
      sessionKey,
      snapshotType: recent.snapshotType,
      updatedAt: recent.updatedAt,
      shortTermSummary: recent.shortTermSummary,
      shortTermState: {
        summary: recent.shortTermState.summary,
        activeTopic: recent.shortTermState.activeTopic,
        openLoops: recent.shortTermState.openLoops,
        assistantCommitments: recent.shortTermState.assistantCommitments,
        userConstraints: recent.shortTermState.userConstraints,
        recentToolResults: recent.shortTermState.recentToolResults,
        carryOverUserTurn: recent.shortTermState.carryOverUserTurn
      },
      recentMessages: (Array.isArray(recent.recentMessages) ? recent.recentMessages : []).map((msg) => ({
        role: sanitizeText(msg.role).toLowerCase(),
        content: sanitizePreviewText(msg.content, 220)
      }))
    }
  };
}

function openMemoryItemById(userId, source, id) {
  if (config.MEMORY_V3_ENABLED && String(id || '').startsWith('session:')) {
    return openRecentSession(userId, String(id || '').replace(/^session:/, ''), { userId });
  }
  if (config.MEMORY_V3_ENABLED && String(id || '').startsWith('profile:')) {
    return {
      source: 'profile',
      id,
      data: truncateProfileForOpen(getProfileResult(userId))
    };
  }
  if (config.MEMORY_V3_ENABLED) {
    const targetId = String(id || '').trim();
    const sessionProjection = loadSessionProjection();
    const profileProjection = loadProfileProjection();
    const memoryNodes = loadMemoryNodes();
    const episodeProjection = loadEpisodeProjection();
    if (targetId.startsWith('profile:')) {
      const profileUserId = targetId.split(':')[1] || '';
      if (String(profileUserId || '').trim() !== String(userId || '').trim()) return null;
      const profile = profileProjection.users?.[String(userId || '').trim()] || null;
      if (profile) {
        return {
          source: 'profile',
          id: targetId,
          data: truncateProfileForOpen({
            profile: {
              identities: profile.identities || [],
              personality_traits: profile.personality_traits || [],
              hobbies: profile.hobbies || [],
              likes: profile.likes || [],
              dislikes: profile.dislikes || [],
              goals: profile.goals || [],
              recent_topics: profile.recent_topics || [],
              relation_stage: profile.relation_stage || '陌生人'
            },
            summary: Array.isArray(profile.summaries) ? profile.summaries[0] || '' : '',
            impression: Array.isArray(profile.impressions) ? profile.impressions[0] || '' : '',
            facts: profile.facts || []
          })
        };
      }
    }
    if (targetId.startsWith('session:')) {
      const sessionKey = targetId.replace(/^session:/, '');
      const session = sessionProjection.sessions?.[sessionKey];
      if (session && String(session.userId || '') === String(userId || '')) {
        return {
          source: 'recent',
          id: targetId,
          data: {
            sessionKey,
            snapshotType: session.snapshotType || '',
            updatedAt: session.updatedAt || 0,
            shortTermSummary: session.summary || '',
            shortTermState: {
              summary: session.summary || '',
              activeTopic: session.activeTopic || '',
              openLoops: Array.isArray(session.openLoops) ? session.openLoops : [],
              assistantCommitments: Array.isArray(session.assistantCommitments) ? session.assistantCommitments : [],
              userConstraints: Array.isArray(session.userConstraints) ? session.userConstraints : [],
              recentToolResults: [],
              carryOverUserTurn: session.carryOverUserTurn || ''
            },
            recentMessages: Array.isArray(session.recentMessages) ? session.recentMessages : []
          }
        };
      }
    }
    const node = memoryNodes.find((item) => String(item.id || '') === targetId);
    if (node) {
      const nodeScopeType = sanitizeText(node.scopeType).toLowerCase();
      if (nodeScopeType === 'group') {
        const allowedGroups = new Set(getAccessibleGroupIdsForUser(userId));
        if (!allowedGroups.has(sanitizeText(node.groupId))) return null;
      } else if (String(node.userId || '').trim() !== String(userId || '').trim()) {
        return null;
      }
      return {
        source: source || node.source || 'personal',
        id: targetId,
        data: {
          id: node.id,
          type: node.type,
          text: sanitizePreviewText(node.text, Math.min(1600, Number(config.MEMORY_CLI_MAX_OPEN_CHARS || 12000))),
          confidence: node.confidence,
          importance: node.importance,
          tier: node.tier || '',
          status: sanitizeText(node.status).toLowerCase() || 'active',
          sourceKind: sanitizeText(node.sourceKind).toLowerCase() || 'runtime',
          evidenceTier: sanitizeText(node.evidenceTier).toLowerCase() || 'weak',
          stabilityScore: Number(node.stabilityScore || 0) || 0,
          fieldKey: sanitizeText(node.fieldKey).toLowerCase(),
          suppressedBy: sanitizeText(node.suppressedBy),
          updatedAt: node.updatedAt || 0,
          scopeType: node.scopeType || 'personal',
          groupId: node.groupId || '',
          taskType: node.taskType || '',
          routePolicyKey: node.routePolicyKey || '',
          topRouteType: node.topRouteType || '',
          source: node.source || '',
          participants: Array.isArray(node.participants) ? node.participants : [],
          entities: Array.isArray(node.entities) ? node.entities : [],
          relations: Array.isArray(node.relations) ? node.relations : [],
          memoryKind: sanitizeText(node.memoryKind).toLowerCase(),
          styleRole: '',
          jargonRole: ''
        }
      };
    }
    for (const item of Array.isArray(episodeProjection.users?.[String(userId || '').trim()]?.items)
      ? episodeProjection.users[String(userId || '').trim()].items
      : []) {
      if (`episode:${item.id}` !== targetId) continue;
      return {
        source: 'journal',
        id: targetId,
        data: {
          id: item.id,
          type: item.type,
          title: item.episodeDay || item.yearMonth || item.type,
          text: String(item.text || '').slice(0, Math.max(200, Number(config.MEMORY_CLI_MAX_OPEN_CHARS || 12000))),
          updatedAt: item.updatedAt || 0
        }
      };
    }
  }
  const targetId = String(id || '').trim();
  let items = [];

  if (source === 'group' || source === 'jargon') {
    const groupIds = getAccessibleGroupIdsForUser(userId);
    for (const groupId of groupIds) {
      items.push(...getMemoryItems(`group:${groupId}`));
    }
  } else if (source === 'journal') {
    items = getMemoryItems(userId).filter((item) => sanitizeText(item.memoryKind || item.meta?.memoryKind).toLowerCase() === 'episode');
  } else {
    items = getMemoryItems(userId);
  }

  const found = items.find((item) => {
    if (String(item.id || '') !== targetId) return false;
    const memoryKind = sanitizeText(item.meta?.memoryKind).toLowerCase();
    if (source === 'style') return memoryKind === 'style';
    if (source === 'jargon') return memoryKind === 'jargon';
    if (source === 'journal') return memoryKind === 'episode';
    return true;
  });
  if (!found) return null;
  const ownerId = (source === 'group' || source === 'jargon')
    ? String(found.userId || '').trim()
    : userId;
  if (config.MEMORY_CLI_TRACK_OPEN_ACCESS && ownerId) {
    touchAccessStats(ownerId, [found.id]);
  }
  return {
    source,
    id: found.id,
    data: {
      id: found.id,
      type: found.type,
      text: sanitizePreviewText(found.text, Math.min(1600, Number(config.MEMORY_CLI_MAX_OPEN_CHARS || 12000))),
      confidence: found.confidence,
      importance: found.importance,
      tier: found.tier,
      status: sanitizeText(found.status).toLowerCase() || 'active',
      sourceKind: sanitizeText(found.sourceKind).toLowerCase() || 'legacy',
      updatedAt: found.updatedAt,
      scopeType: found.scopeType,
      groupId: found.groupId || '',
      taskType: found.taskType || '',
      routePolicyKey: found.routePolicyKey || '',
      topRouteType: found.topRouteType || '',
      source: found.source || '',
      participants: Array.isArray(found.participants) ? found.participants : [],
      entities: Array.isArray(found.entities) ? found.entities : [],
      relations: Array.isArray(found.relations) ? found.relations : [],
      memoryKind: sanitizeText(found.meta?.memoryKind).toLowerCase(),
      styleRole: sanitizeText(found.meta?.styleRole).toLowerCase(),
      jargonRole: sanitizeText(found.meta?.jargonRole).toLowerCase()
    }
  };
}

function reviewMemories(context = {}, options = {}) {
  const userId = sanitizeText(context.userId);
  const status = sanitizeText(options.status || 'candidate').toLowerCase() || 'candidate';
  const limit = Math.max(1, Math.min(100, Number(options.limit || 20) || 20));
  const groupIds = getAccessibleGroupIdsForUser(userId);

  const personal = getMemoryItemsByFilter({ userId, status, limit });
  const groups = groupIds.flatMap((groupId) => getMemoryItemsByFilter({
    userId: `group:${groupId}`,
    status,
    limit
  }));

  const items = personal.concat(groups)
    .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0))
    .slice(0, limit)
    .map((item) => ({
      id: item.id,
      text: sanitizePreviewText(item.text, 220),
      type: item.type,
      tier: item.tier,
      status: sanitizeText(item.status).toLowerCase() || 'active',
      sourceKind: sanitizeText(item.sourceKind).toLowerCase() || 'legacy',
      scopeType: sanitizeText(item.scopeType).toLowerCase() || 'personal',
      groupId: sanitizeText(item.groupId),
      memoryKind: sanitizeText(item.memoryKind || item.meta?.memoryKind).toLowerCase(),
      updatedAt: Number(item.updatedAt || item.createdAt || 0) || 0
    }));

  return {
    ok: true,
    status,
    count: items.length,
    items
  };
}

function openJournalByRef(userId, ref = '') {
  const rawRef = parseJournalRawRef(ref);
  if (rawRef) {
    const filePath = path.join(config.DAILY_JOURNAL_DIR, String(userId || '').trim(), `${rawRef.day}.journal.md`);
    if (!fs.existsSync(filePath)) return null;
    const rawText = String(fs.readFileSync(filePath, 'utf8') || '');
    if (!rawText.trim()) return null;
    const entries = parseJournalEntries(rawText);
    if (!entries.length) return null;
    const start = Math.max(0, rawRef.windowIndex);
    const end = Math.min(entries.length, start + (JOURNAL_RAW_FALLBACK_WINDOW_RADIUS * 2) + 1);
    const opened = buildJournalRawWindowCandidate(
      rawRef.day,
      entries.slice(start, end),
      '',
      start,
      Number(fs.statSync(filePath).mtimeMs || 0) || 0
    );
    if (!opened) return null;
    return {
      ...opened,
      data: {
        id: opened.id,
        type: opened.type,
        title: opened.title,
        text: String(opened.text || '').slice(0, Math.max(200, Number(config.MEMORY_CLI_MAX_OPEN_CHARS || 12000))),
        updatedAt: opened.updatedAt,
        day: opened.day
      }
    };
  }
  return getJournalSummaryFiles(userId).find((item) => item.ref === ref) || null;
}

function openUnifiedMemory(target, options = {}, context = {}) {
  const userId = sanitizeText(context.userId);
  if (!userId) return null;

  const ref = sanitizeText(target?.ref || options.ref);
  const source = sanitizeText(target?.source || options.source).toLowerCase();
  const id = sanitizeText(target?.id || options.id);

  if (ref) {
    if (ref.startsWith('mc_ref:profile:')) {
      if (config.MEMORY_V3_ENABLED) {
        const targetProfileId = ref.replace(/^mc_ref:profile:/, '');
        const profileUserId = String(targetProfileId || '').split(':')[1] || '';
        if (profileUserId && profileUserId !== userId) return null;
        const profileProjection = loadProfileProjection();
        const userProfile = profileProjection.users?.[userId] || null;
        if (userProfile) {
          return {
            source: 'profile',
            id: ref.replace(/^mc_ref:profile:/, ''),
            data: {
              profile: {
                relation_stage: userProfile.relation_stage || '陌生人',
                identities: Array.isArray(userProfile.strictProfile?.identities) ? userProfile.strictProfile.identities.slice(0, 4) : [],
                personality_traits: Array.isArray(userProfile.strictProfile?.personality_traits) ? userProfile.strictProfile.personality_traits.slice(0, 4) : [],
                hobbies: [],
                likes: Array.isArray(userProfile.strictProfile?.likes) ? userProfile.strictProfile.likes.slice(0, 4) : [],
                dislikes: Array.isArray(userProfile.strictProfile?.dislikes) ? userProfile.strictProfile.dislikes.slice(0, 4) : [],
                goals: Array.isArray(userProfile.strictProfile?.goals) ? userProfile.strictProfile.goals.slice(0, 4) : [],
                recent_topics: Array.isArray(userProfile.weakProfile?.recent_topics) ? userProfile.weakProfile.recent_topics.slice(0, 4) : []
              },
              summary: userProfile.personaCore?.summary || '',
              impression: userProfile.personaCore?.impression || '',
              facts: [],
              personaCore: userProfile.personaCore || {},
              strictProfile: userProfile.strictProfile || {},
              weakProfile: userProfile.weakProfile || {},
              suppressed: Array.isArray(userProfile.suppressed) ? userProfile.suppressed.slice(0, 10) : []
            }
          };
        }
      }
      return {
        source: 'profile',
        id: ref.replace(/^mc_ref:profile:/, ''),
        data: truncateProfileForOpen(getProfileResult(userId))
      };
    }
    if (ref.startsWith('mc_ref:recent:')) {
      return openRecentSession(userId, ref.replace(/^mc_ref:recent:/, ''), context);
    }
    if (ref.startsWith('mc_ref:profile:profile:')) {
      return {
        source: 'profile',
        id: ref.replace(/^mc_ref:profile:/, ''),
        data: truncateProfileForOpen(getProfileResult(userId))
      };
    }
    if (parseJournalRawRef(ref)) {
      const openedJournal = openJournalByRef(userId, ref);
      if (!openedJournal) return null;
      return {
        source: 'journal',
        id: openedJournal.id,
        data: openedJournal.data
      };
    }
    if (ref.startsWith('mc_ref:journal:')) {
      const openedEpisode = openMemoryItemById(userId, 'journal', ref.replace(/^mc_ref:journal:/, ''));
      if (openedEpisode) return openedEpisode;
      const openedJournal = openJournalByRef(userId, ref);
      if (!openedJournal) return null;
      if (openedJournal.data && typeof openedJournal.data === 'object') {
        return {
          source: 'journal',
          id: openedJournal.id,
          data: openedJournal.data
        };
      }
      return {
        source: 'journal',
        id: openedJournal.id,
        data: {
          id: openedJournal.id,
          type: openedJournal.type,
          title: openedJournal.title,
          text: String(openedJournal.text || '').slice(0, Math.max(200, Number(config.MEMORY_CLI_MAX_OPEN_CHARS || 12000))),
          updatedAt: openedJournal.updatedAt
        }
      };
    }
    const match = ref.match(/^mc_ref:(personal|task|group):(.+)$/);
    if (match) {
      return openMemoryItemById(userId, match[1], match[2]);
    }
    const signalMatch = ref.match(/^mc_ref:(style|jargon):(.+)$/);
    if (signalMatch) {
      return openMemoryItemById(userId, signalMatch[1], signalMatch[2]);
    }
    return null;
  }

  if (source === 'profile') {
    return {
      source: 'profile',
      id: 'profile',
      data: truncateProfileForOpen(getProfileResult(userId))
    };
  }
  if (source === 'recent' && id) return openRecentSession(userId, id, context);
  if ((source === 'personal' || source === 'task' || source === 'group' || source === 'style' || source === 'jargon' || source === 'journal') && id) {
    return openMemoryItemById(userId, source, id);
  }
  if (source === 'journal' && id) {
    const hit = getJournalSummaryFiles(userId).find((item) => item.id === id || item.ref === id);
    if (!hit) return null;
    return {
      source: 'journal',
      id: hit.id,
      data: {
        id: hit.id,
        type: hit.type,
        title: hit.title,
        text: String(hit.text || '').slice(0, Math.max(200, Number(config.MEMORY_CLI_MAX_OPEN_CHARS || 12000)))
      }
    };
  }
  return null;
}

function listUnifiedMemorySources(context = {}) {
  const userId = sanitizeText(context.userId);
  const scope = getMemoryScopeForUser(userId);
  return {
    ok: true,
    sources: ['recent', 'profile', 'personal', 'task', 'group', 'style', 'jargon', 'journal'],
    groupCount: Array.isArray(scope.groups) ? scope.groups.length : 0,
    channelCount: Array.isArray(scope.channels) ? scope.channels.length : 0
  };
}

function getUnifiedMemoryStats(context = {}) {
  const userId = sanitizeText(context.userId);
  const allItems = getMemoryItems(userId);
  const taskItems = allItems.filter((item) => String(item.scopeType || '').trim() === 'task');
  const styleItems = allItems.filter((item) => sanitizeText(item.meta?.memoryKind).toLowerCase() === 'style');
  const personalItems = allItems.filter((item) => {
    const scopeType = String(item.scopeType || '').trim();
    const memoryKind = sanitizeText(item.meta?.memoryKind).toLowerCase();
    return scopeType !== 'task' && scopeType !== 'group' && memoryKind !== 'style';
  });
  const groupScope = getMemoryScopeForUser(userId);
  const groupIds = Array.isArray(groupScope.groups) ? groupScope.groups.map((group) => sanitizeText(group.groupId)).filter(Boolean) : [];
  const jargonItems = groupIds.flatMap((groupId) => getMemoryItems(`group:${groupId}`))
    .filter((item) => sanitizeText(item.meta?.memoryKind).toLowerCase() === 'jargon');
  const journalFiles = getJournalSummaryFiles(userId);
  const journalStats = getDailyJournalStats(userId, Math.max(1, Number(config.MEMORY_CLI_JOURNAL_FALLBACK_DAYS || 14)));
  return {
    ok: true,
    counts: {
      personal: personalItems.length,
      task: taskItems.length,
      style: styleItems.length,
      jargon: jargonItems.length,
      groups: Array.isArray(groupScope.groups) ? groupScope.groups.length : 0,
      channels: Array.isArray(groupScope.channels) ? groupScope.channels.length : 0,
      journalFiles: journalFiles.length
    },
    journal: journalStats,
    recentSessions: buildRecentSessionCandidates(userId, context).length
  };
}

async function runLegacyMemorySearch(parsed, prepared, context = {}) {
  const userId = sanitizeText(context.userId);
  let payload = null;

  const localKnowledge = await queryLocalKnowledge({
    userId,
    query: parsed.query,
    topK: parsed.limit,
    groupId: sanitizeText(context.groupId),
    groupIds: getAccessibleGroupIdsForUser(userId),
    sessionId: sanitizeText(context.sessionId),
    sessionKey: sanitizeText(context.sessionKey),
    routePolicyKey: sanitizeText(context.routePolicyKey),
    topRouteType: sanitizeText(context.topRouteType),
    taskType: sanitizeText(context.taskType)
  });
  const notebookOnlyResults = parsed.source === 'notebook'
    ? (localKnowledge.bySource?.notebook_doc || [])
    : [];
  if (parsed.source === 'notebook') {
    payload = {
      ok: true,
      command: 'search',
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy,
      count: notebookOnlyResults.length,
      results: notebookOnlyResults.map((item) => ({
        ref: `mc_ref:notebook:${item.ref.docId}:${item.ref.chunkIndex}`,
        source: 'notebook',
        type: 'notebook_doc',
        id: item.ref.docId,
        title: item.title,
        preview: item.preview,
        text: item.preview,
        score: item.score,
        updatedAt: item.updatedAt
      })),
      digest: notebookOnlyResults.map((item) => `[notebook] ${sanitizePreviewText(item.preview, 140)}`).slice(0, 4),
      sourceCoverage: { notebook: notebookOnlyResults.length },
      queryFacet: 'notebook',
      candidateCounts: { local: localKnowledge.diagnostics.candidates || 0 },
      fallbackUsed: false,
      outputChars: notebookOnlyResults.reduce((sum, item) => sum + String(item.preview || '').length, 0),
      recentUsed: false,
      droppedResultCount: 0
    };
  } else if (parsed.source === 'journal') {
    const journalOnly = (localKnowledge.bySource?.journal_entry || [])
      .concat(localKnowledge.bySource?.journal_continuity || [])
      .slice(0, parsed.limit);
    payload = {
      ok: true,
      command: 'search',
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy,
      count: journalOnly.length,
      results: journalOnly.map((item) => ({
        ref: `mc_ref:journal:${item.id}`,
        source: 'journal',
        type: 'journal_entry',
        id: item.id,
        title: item.source,
        preview: item.preview,
        text: item.preview,
        score: item.score,
        updatedAt: item.updatedAt
      })),
      digest: journalOnly.map((item) => `[journal] ${sanitizePreviewText(item.preview, 140)}`).slice(0, 4),
      sourceCoverage: { journal: journalOnly.length },
      queryFacet: 'journal',
      candidateCounts: { local: localKnowledge.diagnostics.candidates || 0 },
      fallbackUsed: false,
      outputChars: journalOnly.reduce((sum, item) => sum + String(item.preview || '').length, 0),
      recentUsed: false,
      droppedResultCount: 0
    };
  }

  if (payload) return payload;

  const search = config.MEMORY_V3_ENABLED
    ? await (async () => {
      let facet = classifyRecallFacet(parsed.query);
      if (parsed.source === 'recent') facet = 'continuity';
      else if (parsed.source === 'journal') facet = 'journal';
      else if (parsed.source === 'task') facet = 'task';
      else if (parsed.source === 'group') facet = 'group';
      else if (parsed.source === 'style' || parsed.source === 'jargon') facet = 'style';
      const result = await queryMemory({
        userId,
        query: parsed.query,
        topK: parsed.limit,
        facet,
        source: parsed.source,
        groupId: sanitizeText(context.groupId),
        groupIds: getAccessibleGroupIdsForUser(userId),
        sessionId: sanitizeText(context.sessionId),
        sessionKey: sanitizeText(context.sessionKey),
        routePolicyKey: sanitizeText(context.routePolicyKey),
        topRouteType: sanitizeText(context.topRouteType),
        taskType: sanitizeText(context.taskType)
      });
      const results = (Array.isArray(result.results) ? result.results : []).map((item) => ({
        ref: `mc_ref:${item.source}:${item.id}`,
        source: item.source,
        type: item.type,
        id: item.id,
        evidenceTier: sanitizeText(item.evidenceTier).toLowerCase() || '',
        fieldKey: sanitizeText(item.fieldKey).toLowerCase() || '',
        title: sanitizePreviewText(item.text, 80),
        preview: sanitizePreviewText(item.text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
        text: sanitizePreviewText(item.text, Math.min(400, Number(config.MEMORY_CLI_MAX_OPEN_CHARS || 12000))),
        score: item.score,
        tier: item.tier || '',
        confidence: item.confidence,
        status: item.status,
        matchMode: sanitizeText(item.matchMode || '') || (item.embedding > 0 ? 'hybrid' : 'lexical'),
        scoreParts: item.scoreParts && typeof item.scoreParts === 'object' ? item.scoreParts : {},
        updatedAt: item.updatedAt || 0
      }));
      return {
        results,
        digest: [
          ...(result.persona?.summary
            ? [`[persona|summary] ${sanitizePreviewText(result.persona.summary, 140)}`]
            : []),
          ...(result.persona?.impression
            ? [`[persona|impression] ${sanitizePreviewText(result.persona.impression, 140)}`]
            : []),
          ...((Array.isArray(result.strictResults) ? result.strictResults : [])
            .slice(0, 2)
            .map((item) => `[strict|${String(item.source || 'memory').trim() || 'memory'}|${String(item.type || '').trim() || 'fact'}] ${sanitizePreviewText(item.text, 140)}`)),
          ...((Array.isArray(result.weakResults) ? result.weakResults : [])
            .slice(0, 1)
            .map((item) => `[weak|${String(item.source || 'memory').trim() || 'memory'}|${String(item.type || '').trim() || 'fact'}] ${sanitizePreviewText(item.text, 140)}`))
        ].filter(Boolean).slice(0, 4),
        sourceCoverage: result.sourceCoverage || {},
        queryFacet: result.facet || classifyRecallFacet(parsed.query),
        candidateCounts: { v3: Number(result.stats?.candidates || 0) || 0 },
        fallbackUsed: false,
        outputChars: results.reduce((sum, item) => sum + String(item.preview || '').length, 0),
        recentUsed: Boolean((result.sourceCoverage || {}).recent),
        droppedResultCount: 0
      };
    })()
    : searchUnifiedMemory(parsed.query, {
      source: parsed.source,
      limit: parsed.limit
    }, context);
  return {
    ok: true,
    command: 'search',
    rawCommandText: prepared.rawCommandText,
    normalizedCommandText: prepared.normalizedCommandText,
    repairApplied: prepared.repairApplied,
    repairStrategy: prepared.repairStrategy,
    count: search.results.length,
    results: search.results,
    digest: search.digest,
    sourceCoverage: search.sourceCoverage,
    queryFacet: search.queryFacet,
    candidateCounts: search.candidateCounts,
    fallbackUsed: search.fallbackUsed,
    outputChars: search.outputChars,
    recentUsed: search.recentUsed,
    droppedResultCount: search.droppedResultCount
  };
}

async function runMemoryCli(commandText = '', context = {}) {
  const startedAt = Date.now();
  const prepared = prepareMemoryCliCommand(commandText);
  if (!prepared.ok || !prepared.parsed) {
    if (config.ENABLE_DEBUG_LOG) {
      console.log('[memory_cli] command invalid', {
        rawPreview: String(prepared.rawCommandText || '').slice(0, 180),
        invalidReason: prepared.invalidReason
      });
    }
    return {
      ok: false,
      command: '',
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy,
      invalidReason: prepared.invalidReason,
      results: []
    };
  }

  if (config.ENABLE_DEBUG_LOG && prepared.repairApplied) {
    console.log('[memory_cli] command normalized', {
      rawPreview: String(prepared.rawCommandText || '').slice(0, 180),
      normalizedPreview: String(prepared.normalizedCommandText || '').slice(0, 180),
      repairStrategy: prepared.repairStrategy
    });
  }

  const parsed = prepared.parsed;
  const userId = sanitizeText(context.userId);
  let payload = null;

  if (parsed.commandName === 'search') {
    if (String(config.MEMORY_CLI_SEARCH_ENGINE || 'fast').trim().toLowerCase() === 'legacy') {
      payload = await runLegacyMemorySearch(parsed, prepared, context);
    } else {
      try {
        const fastSearch = await searchMemoryCliFast(parsed.query, {
          source: parsed.source,
          limit: parsed.limit
        }, {
          ...context,
          userId,
          groupIds: getAccessibleGroupIdsForUser(userId)
        });
        payload = {
          ok: true,
          command: 'search',
          rawCommandText: prepared.rawCommandText,
          normalizedCommandText: prepared.normalizedCommandText,
          repairApplied: prepared.repairApplied,
          repairStrategy: prepared.repairStrategy,
          count: fastSearch.results.length,
          results: fastSearch.results,
          digest: fastSearch.digest,
          sourceCoverage: fastSearch.sourceCoverage,
          queryFacet: fastSearch.queryFacet,
          candidateCounts: fastSearch.candidateCounts,
          fallbackUsed: fastSearch.fallbackUsed,
          outputChars: fastSearch.outputChars,
          recentUsed: fastSearch.recentUsed,
          droppedResultCount: fastSearch.droppedResultCount
        };
      } catch (error) {
        if (config.ENABLE_DEBUG_LOG) {
          console.warn('[memory_cli_fast] search fallback to legacy:', error?.message || error);
        }
        payload = await runLegacyMemorySearch(parsed, prepared, context);
      }
    }
  }

  if (!payload && parsed.commandName === 'remember') {
    const userId = sanitizeText(context.userId);
    const groupId = sanitizeText(context.groupId);
    const scope = parsed.scope === 'group' && groupId ? 'group' : 'personal';
    const id = rememberExplicitMemory(userId, parsed.text, {
      scopeType: scope,
      groupId: scope === 'group' ? groupId : '',
      sessionId: sanitizeText(context.sessionId),
      routePolicyKey: sanitizeText(context.routePolicyKey),
      topRouteType: sanitizeText(context.topRouteType),
      agentName: sanitizeText(context.agentName),
      toolName: sanitizeText(context.toolName),
      channelId: sanitizeText(context.channelId),
      participants: Array.isArray(context.participants) ? context.participants : []
    });
    payload = {
      ok: Boolean(id),
      command: 'remember',
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy,
      id: id || null,
      scope,
      text: parsed.text
    };
  }

  if (!payload && parsed.commandName === 'review') {
    payload = {
      ...reviewMemories(context, parsed),
      command: 'review',
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy
    };
  }

  if (!payload && parsed.commandName === 'open') {
    let opened = null;
    if (String(config.MEMORY_CLI_SEARCH_ENGINE || 'fast').trim().toLowerCase() !== 'legacy') {
      try {
        opened = await openMemoryCliFast(parsed, context);
      } catch (error) {
        if (config.ENABLE_DEBUG_LOG) {
          console.warn('[memory_cli_fast] open fallback to legacy:', error?.message || error);
        }
      }
    }
    if (!opened && (parsed.source === 'notebook' || String(parsed.ref || '').startsWith('mc_ref:notebook:'))) {
      const refParts = String(parsed.ref || '').replace(/^mc_ref:notebook:/, '').split(':');
      const openedNotebook = readNotebookDoc({ userId }, {
        userId,
        docId: refParts[0] || parsed.id,
        chunkIndex: Number(refParts[1] || 0) || 0
      });
      if (openedNotebook?.ok) {
        opened = {
          source: 'notebook',
          id: refParts[0] || parsed.id,
          data: openedNotebook
        };
      }
    }
    if (!opened) {
      opened = openUnifiedMemory(parsed, parsed, context);
    }
    if (!opened && parseJournalRawRef(parsed.ref)) {
      const openedJournal = openJournalByRef(sanitizeText(context.userId), parsed.ref);
      if (openedJournal && openedJournal.data && typeof openedJournal.data === 'object') {
        opened = {
          source: 'journal',
          id: openedJournal.id,
          data: openedJournal.data
        };
      }
    }
    payload = {
      ok: Boolean(opened),
      command: 'open',
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy,
      source: opened ? opened.source : parsed.source,
      id: opened ? opened.id : parsed.id,
      data: opened ? opened.data : null
    };
  }

  if (!payload && parsed.commandName === 'ls') {
    payload = {
      ...listUnifiedMemorySources(context),
      command: 'ls',
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy
    };
  }

  if (!payload && parsed.commandName === 'stats') {
    const localKnowledgeStats = await queryLocalKnowledge({
      userId,
      query: '',
      topK: 1,
      groupId: sanitizeText(context.groupId),
      sessionKey: sanitizeText(context.sessionKey)
    });
    payload = {
      ...getUnifiedMemoryStats(context),
      command: 'stats',
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy,
      localKnowledge: localKnowledgeStats.diagnostics
    };
  }

  if (!payload) {
    payload = {
      ok: false,
      command: parsed.commandName,
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy,
      invalidReason: 'unsupported_command'
    };
  }

  if (config.ENABLE_DEBUG_LOG) {
    const topResult = Array.isArray(payload?.results) && payload.results.length > 0
      ? payload.results[0]
      : null;
    console.log('[memory_cli] command executed', {
      userId,
      route: `${String(context.topRouteType || '').trim() || 'unknown'}:${String(context.routePolicyKey || '').trim() || 'unknown'}`,
      commandName: parsed.commandName,
      source: parsed.source || '',
      hitCount: Number(payload?.count || payload?.results?.length || 0) || 0,
      topResultType: String(topResult?.type || '').trim(),
      topResultSource: String(topResult?.source || '').trim(),
      topResultRef: String(topResult?.ref || '').trim().slice(0, 160),
      durationMs: Date.now() - startedAt,
      truncated: Boolean(payload?.droppedResultCount)
    });
  }

  return payload;
}

module.exports = {
  parseMemoryCliCommand,
  prepareMemoryCliCommand,
  searchUnifiedMemory,
  openUnifiedMemory,
  listUnifiedMemorySources,
  getUnifiedMemoryStats,
  runMemoryCli
};
