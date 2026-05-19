const config = require('../../config');

const VALID_SEARCH_SOURCES = new Set(['all', 'profile', 'personal', 'task', 'group', 'journal', 'recent', 'style', 'jargon', 'notebook', 'image']);
const VALID_OPEN_SOURCES = new Set(['profile', 'personal', 'task', 'group', 'journal', 'recent', 'style', 'jargon', 'notebook', 'image']);

function sanitizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
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

function parseProfileArgs(tokens = [], raw = '') {
  const action = sanitizeText(tokens[0] || '').toLowerCase();
  if (!action) throw new Error(`Unexpected token: missing profile action in ${raw}`);
  let limit = 20;
  let query = '';

  for (let i = 1; i < tokens.length; i += 1) {
    const token = String(tokens[i] || '').trim();
    if (!token) continue;

    if (token === '--limit') {
      limit = Math.max(1, Math.min(100, Number(tokens[i + 1] || limit) || limit));
      i += 1;
      continue;
    }
    if (token.startsWith('--limit=')) {
      limit = Math.max(1, Math.min(100, Number(token.slice('--limit='.length)) || limit));
      continue;
    }
    if (token === '--query') {
      query = sanitizeText(tokens[i + 1] || '');
      i += 1;
      continue;
    }
    if (token.startsWith('--query=')) {
      query = sanitizeText(token.slice('--query='.length));
      continue;
    }

    throw new Error(`Unexpected token: ${token}`);
  }

  if (action !== 'review' && action !== 'stale' && action !== 'why-injected') {
    throw new Error(`Unsupported profile action: ${action}`);
  }
  if (action === 'why-injected' && !query) {
    throw new Error(`Unexpected token: missing profile injection query in ${raw}`);
  }
  return {
    commandName: 'profile',
    action,
    limit,
    query,
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
  if (subcommand === 'profile') return parseProfileArgs(args, raw);
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
    } else if (/^profile\b/i.test(normalized)) {
      normalized = normalized.replace(/^profile\b/i, 'mem profile');
      repairStrategy.push('prefix_mem_profile');
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

module.exports = {
  VALID_SEARCH_SOURCES,
  VALID_OPEN_SOURCES,
  sanitizeText,
  hasForbiddenShellSyntax,
  stripCodeFences,
  normalizeQuotes,
  safeJsonParse,
  tokenizeArgs,
  buildQuotedCommandValue,
  normalizeCommandSpacing,
  coerceSearchSource,
  parseSearchArgs,
  parseOpenArgs,
  parseProfileArgs,
  parseRememberArgs,
  parseReviewArgs,
  parseMemoryCliCommand,
  tryRepairJsonWrapper,
  tryRepairPrefix,
  tryRepairAssignedFlags,
  tryRepairImplicitSearch,
  tryRepairImplicitOpen,
  prepareMemoryCliCommand
};
