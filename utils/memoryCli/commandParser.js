const config = require('../../config');

const VALID_SEARCH_SOURCES = new Set(['all', 'profile', 'personal', 'task', 'group', 'journal', 'recent', 'style', 'jargon', 'notebook', 'image', 'openviking']);
const VALID_OPEN_SOURCES = new Set(['profile', 'personal', 'task', 'group', 'journal', 'recent', 'style', 'jargon', 'notebook', 'image', 'openviking']);
const URI_SCHEMES = new Set(['core', 'group', 'journal', 'image', 'system']);

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

    if (!ref && isMemoryUri(token)) {
      ref = sanitizeText(token);
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

function isMemoryUri(value = '') {
  const match = String(value || '').trim().match(/^([a-z][a-z0-9_-]*):\/\//i);
  return Boolean(match && URI_SCHEMES.has(String(match[1] || '').toLowerCase()));
}

function parseReadArgs(tokens = [], raw = '') {
  let uri = '';
  let namespace = '';
  for (let i = 0; i < tokens.length; i += 1) {
    const token = String(tokens[i] || '').trim();
    if (!token) continue;
    if (token === '--uri') {
      uri = sanitizeText(tokens[i + 1] || '');
      i += 1;
      continue;
    }
    if (token.startsWith('--uri=')) {
      uri = sanitizeText(token.slice('--uri='.length));
      continue;
    }
    if (token === '--namespace') {
      namespace = sanitizeText(tokens[i + 1] || '');
      i += 1;
      continue;
    }
    if (token.startsWith('--namespace=')) {
      namespace = sanitizeText(token.slice('--namespace='.length));
      continue;
    }
    if (!uri && isMemoryUri(token)) {
      uri = sanitizeText(token);
      continue;
    }
    throw new Error(`Unexpected token: ${token}`);
  }
  if (!uri) throw new Error(`Unexpected token: missing read uri in ${raw}`);
  return { commandName: 'read', uri, namespace, raw };
}

function parseBootArgs(tokens = [], raw = '') {
  let query = '';
  let namespace = '';
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
    if (token === '--namespace') {
      namespace = sanitizeText(tokens[i + 1] || '');
      i += 1;
      continue;
    }
    if (token.startsWith('--namespace=')) {
      namespace = sanitizeText(token.slice('--namespace='.length));
      continue;
    }
    throw new Error(`Unexpected token: ${token}`);
  }
  return { commandName: 'boot', query, namespace, raw };
}

function parseAliasArgs(tokens = [], raw = '') {
  const action = sanitizeText(tokens[0] || '').toLowerCase();
  if (!action) throw new Error(`Unexpected token: missing alias action in ${raw}`);
  let aliasUri = '';
  let targetUri = '';
  let namespace = '';
  let priority = 0;
  let disclosure = '';
  for (let i = 1; i < tokens.length; i += 1) {
    const token = String(tokens[i] || '').trim();
    if (!token) continue;
    if (token === '--alias' || token === '--uri') {
      aliasUri = sanitizeText(tokens[i + 1] || '');
      i += 1;
      continue;
    }
    if (token.startsWith('--alias=')) {
      aliasUri = sanitizeText(token.slice('--alias='.length));
      continue;
    }
    if (token.startsWith('--uri=')) {
      aliasUri = sanitizeText(token.slice('--uri='.length));
      continue;
    }
    if (token === '--target') {
      targetUri = sanitizeText(tokens[i + 1] || '');
      i += 1;
      continue;
    }
    if (token.startsWith('--target=')) {
      targetUri = sanitizeText(token.slice('--target='.length));
      continue;
    }
    if (token === '--namespace') {
      namespace = sanitizeText(tokens[i + 1] || '');
      i += 1;
      continue;
    }
    if (token.startsWith('--namespace=')) {
      namespace = sanitizeText(token.slice('--namespace='.length));
      continue;
    }
    if (token === '--priority') {
      priority = Math.max(0, Number(tokens[i + 1] || 0) || 0);
      i += 1;
      continue;
    }
    if (token.startsWith('--priority=')) {
      priority = Math.max(0, Number(token.slice('--priority='.length)) || 0);
      continue;
    }
    if (token === '--disclosure') {
      disclosure = sanitizeText(tokens[i + 1] || '');
      i += 1;
      continue;
    }
    if (token.startsWith('--disclosure=')) {
      disclosure = sanitizeText(token.slice('--disclosure='.length));
      continue;
    }
    if (!aliasUri && isMemoryUri(token)) {
      aliasUri = sanitizeText(token);
      continue;
    }
    if (!targetUri && isMemoryUri(token)) {
      targetUri = sanitizeText(token);
      continue;
    }
    throw new Error(`Unexpected token: ${token}`);
  }
  if (!['add', 'remove', 'list'].includes(action)) throw new Error(`Unsupported alias action: ${action}`);
  if (action !== 'list' && !aliasUri) throw new Error(`Unexpected token: missing alias uri in ${raw}`);
  if (action === 'add' && !targetUri) throw new Error(`Unexpected token: missing alias target in ${raw}`);
  return { commandName: 'alias', action, aliasUri, targetUri, namespace, priority, disclosure, raw };
}

function parseTriggerArgs(tokens = [], raw = '') {
  const action = sanitizeText(tokens[0] || '').toLowerCase();
  if (!action) throw new Error(`Unexpected token: missing trigger action in ${raw}`);
  let uri = '';
  let namespace = '';
  let priority = 0;
  let disclosure = '';
  const keywords = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const token = String(tokens[i] || '').trim();
    if (!token) continue;
    if (token === '--uri') {
      uri = sanitizeText(tokens[i + 1] || '');
      i += 1;
      continue;
    }
    if (token.startsWith('--uri=')) {
      uri = sanitizeText(token.slice('--uri='.length));
      continue;
    }
    if (token === '--keyword') {
      keywords.push(sanitizeText(tokens[i + 1] || ''));
      i += 1;
      continue;
    }
    if (token.startsWith('--keyword=')) {
      keywords.push(sanitizeText(token.slice('--keyword='.length)));
      continue;
    }
    if (token === '--namespace') {
      namespace = sanitizeText(tokens[i + 1] || '');
      i += 1;
      continue;
    }
    if (token.startsWith('--namespace=')) {
      namespace = sanitizeText(token.slice('--namespace='.length));
      continue;
    }
    if (token === '--priority') {
      priority = Math.max(0, Number(tokens[i + 1] || 0) || 0);
      i += 1;
      continue;
    }
    if (token.startsWith('--priority=')) {
      priority = Math.max(0, Number(token.slice('--priority='.length)) || 0);
      continue;
    }
    if (token === '--disclosure') {
      disclosure = sanitizeText(tokens[i + 1] || '');
      i += 1;
      continue;
    }
    if (token.startsWith('--disclosure=')) {
      disclosure = sanitizeText(token.slice('--disclosure='.length));
      continue;
    }
    if (!uri && isMemoryUri(token)) {
      uri = sanitizeText(token);
      continue;
    }
    keywords.push(sanitizeText(token));
  }
  const filteredKeywords = keywords.filter(Boolean);
  if (!['add', 'remove', 'list'].includes(action)) throw new Error(`Unsupported trigger action: ${action}`);
  if (action === 'add' && (!uri || filteredKeywords.length === 0)) throw new Error(`Unexpected token: missing trigger uri or keyword in ${raw}`);
  return { commandName: 'trigger', action, uri, keywords: filteredKeywords, namespace, priority, disclosure, raw };
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
  let action = 'legacy';
  let id = '';
  let status = 'candidate';
  let limit = 20;
  if (tokens.length > 0 && ['list', 'accept', 'reject'].includes(sanitizeText(tokens[0]).toLowerCase())) {
    action = sanitizeText(tokens[0]).toLowerCase();
    tokens = tokens.slice(1);
  }

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
    if (token === '--id') {
      id = sanitizeText(tokens[i + 1] || '');
      i += 1;
      continue;
    }
    if (token.startsWith('--id=')) {
      id = sanitizeText(token.slice('--id='.length));
      continue;
    }
    if (!id && action !== 'legacy') {
      id = sanitizeText(token);
      continue;
    }

    throw new Error(`Unexpected token: ${token}`);
  }

  if (status !== 'candidate' && status !== 'active') {
    throw new Error(`Unsupported review status: ${status}`);
  }
  if ((action === 'accept' || action === 'reject') && !id) {
    throw new Error(`Unexpected token: missing review id in ${raw}`);
  }

  return {
    commandName: 'review',
    action,
    id,
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
  let userId = '';
  let status = 'active';
  let apply = false;

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
    if (token === '--user' || token === '--user-id' || token === '--user_id') {
      userId = sanitizeText(tokens[i + 1] || '');
      i += 1;
      continue;
    }
    if (token.startsWith('--user=')) {
      userId = sanitizeText(token.slice('--user='.length));
      continue;
    }
    if (token.startsWith('--user-id=')) {
      userId = sanitizeText(token.slice('--user-id='.length));
      continue;
    }
    if (token.startsWith('--user_id=')) {
      userId = sanitizeText(token.slice('--user_id='.length));
      continue;
    }
    if (token === '--status') {
      status = sanitizeText(tokens[i + 1] || status).toLowerCase();
      i += 1;
      continue;
    }
    if (token.startsWith('--status=')) {
      status = sanitizeText(token.slice('--status='.length)).toLowerCase();
      continue;
    }
    if (token === '--apply') {
      apply = true;
      continue;
    }

    throw new Error(`Unexpected token: ${token}`);
  }

  if (action !== 'review' && action !== 'stale' && action !== 'why-injected' && action !== 'list' && action !== 'clean') {
    throw new Error(`Unsupported profile action: ${action}`);
  }
  if (!['active', 'candidate', 'stale', 'superseded'].includes(status)) {
    throw new Error(`Unsupported profile status: ${status}`);
  }
  if (action === 'why-injected' && !query) {
    throw new Error(`Unexpected token: missing profile injection query in ${raw}`);
  }
  return {
    commandName: 'profile',
    action,
    limit,
    query,
    userId,
    status,
    apply,
    raw
  };
}

function parseJournalArgs(tokens = [], raw = '') {
  const action = sanitizeText(tokens[0] || '').toLowerCase();
  if (!action) throw new Error(`Unexpected token: missing journal action in ${raw}`);
  let userId = '';
  let day = '';
  let status = '';
  let limit = 20;
  let apply = false;

  for (let i = 1; i < tokens.length; i += 1) {
    const token = String(tokens[i] || '').trim();
    if (!token) continue;
    if (token === '--user' || token === '--user-id' || token === '--user_id') {
      userId = sanitizeText(tokens[i + 1] || '');
      i += 1;
      continue;
    }
    if (token.startsWith('--user=')) {
      userId = sanitizeText(token.slice('--user='.length));
      continue;
    }
    if (token.startsWith('--user-id=')) {
      userId = sanitizeText(token.slice('--user-id='.length));
      continue;
    }
    if (token.startsWith('--user_id=')) {
      userId = sanitizeText(token.slice('--user_id='.length));
      continue;
    }
    if (token === '--day') {
      day = sanitizeText(tokens[i + 1] || '');
      i += 1;
      continue;
    }
    if (token.startsWith('--day=')) {
      day = sanitizeText(token.slice('--day='.length));
      continue;
    }
    if (token === '--status') {
      status = sanitizeText(tokens[i + 1] || '').toLowerCase();
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
    if (token === '--apply') {
      apply = true;
      continue;
    }
    throw new Error(`Unexpected token: ${token}`);
  }

  if (action !== 'list' && action !== 'clean') {
    throw new Error(`Unsupported journal action: ${action}`);
  }
  if (status && !['active', 'unsafe', 'skipped', 'archived', 'stale'].includes(status)) {
    throw new Error(`Unsupported journal status: ${status}`);
  }
  return {
    commandName: 'journal',
    action,
    userId,
    day,
    status,
    limit,
    apply,
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
  if (subcommand === 'read') return parseReadArgs(args, raw);
  if (subcommand === 'boot') return parseBootArgs(args, raw);
  if (subcommand === 'alias') return parseAliasArgs(args, raw);
  if (subcommand === 'trigger') return parseTriggerArgs(args, raw);
  if (subcommand === 'remember') return parseRememberArgs(args, raw);
  if (subcommand === 'review') return parseReviewArgs(args, raw);
  if (subcommand === 'profile') return parseProfileArgs(args, raw);
  if (subcommand === 'journal') return parseJournalArgs(args, raw);
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
    } else if (/^read\b/i.test(normalized)) {
      normalized = normalized.replace(/^read\b/i, 'mem read');
      repairStrategy.push('prefix_mem_read');
    } else if (/^boot\b/i.test(normalized)) {
      normalized = normalized.replace(/^boot\b/i, 'mem boot');
      repairStrategy.push('prefix_mem_boot');
    } else if (/^alias\b/i.test(normalized)) {
      normalized = normalized.replace(/^alias\b/i, 'mem alias');
      repairStrategy.push('prefix_mem_alias');
    } else if (/^trigger\b/i.test(normalized)) {
      normalized = normalized.replace(/^trigger\b/i, 'mem trigger');
      repairStrategy.push('prefix_mem_trigger');
    } else if (/^remember\b/i.test(normalized)) {
      normalized = normalized.replace(/^remember\b/i, 'mem remember');
      repairStrategy.push('prefix_mem_remember');
    } else if (/^review\b/i.test(normalized)) {
      normalized = normalized.replace(/^review\b/i, 'mem review');
      repairStrategy.push('prefix_mem_review');
    } else if (/^profile\b/i.test(normalized)) {
      normalized = normalized.replace(/^profile\b/i, 'mem profile');
      repairStrategy.push('prefix_mem_profile');
    } else if (/^journal\b/i.test(normalized)) {
      normalized = normalized.replace(/^journal\b/i, 'mem journal');
      repairStrategy.push('prefix_mem_journal');
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
  const match = text.match(/^mem open\s+((?:(?:mc_ref|ov_ref):|(?:core|group|journal|image|system):\/\/)[^\s]+)$/i);
  if (!match) return text;
  repairStrategy.push('implicit_open_ref');
  return `mem open --ref ${buildQuotedCommandValue(match[1])}`;
}

function tryRepairImplicitRead(text = '', repairStrategy = []) {
  const match = text.match(/^mem read\s+((?:core|group|journal|image|system):\/\/[^\s]+)$/i);
  if (!match) return text;
  repairStrategy.push('implicit_read_uri');
  return `mem read --uri ${buildQuotedCommandValue(match[1])}`;
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
  normalized = tryRepairImplicitRead(normalized, repairStrategy);
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
  parseReadArgs,
  parseBootArgs,
  parseAliasArgs,
  parseTriggerArgs,
  parseProfileArgs,
  parseJournalArgs,
  parseRememberArgs,
  parseReviewArgs,
  parseMemoryCliCommand,
  tryRepairJsonWrapper,
  tryRepairPrefix,
  tryRepairAssignedFlags,
  tryRepairImplicitSearch,
  tryRepairImplicitOpen,
  tryRepairImplicitRead,
  prepareMemoryCliCommand
};
